import { existsSync, statSync } from 'fs';
import { dirname, basename } from 'path';

import { ToolExecutionErrorType } from '@industry/common/session';
import { GrepSearchCliParams } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  NO_MATCHES_FOUND,
  NO_MATCHING_FILES_FOUND,
} from '@industry/drool-sdk-ext/protocol/tools';
import { logWarn } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';
import { scrubSecrets } from '@industry/utils/secretScrubber';

import { getSandboxService } from '@/services/SandboxService';
import {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import { executeRipgrep } from '@/utils/grep-utils';
import {
  formatSecretRedactionReminder,
  wrapInSystemReminder,
} from '@/utils/systemReminderUtils';

export class GrepSearchCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: GrepSearchCliParams
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { workingDirectoryFullPath } = dependencies;
    const { pattern, path, ...options } = parameters;

    // Use path parameter if provided, otherwise use working directory
    const searchPath = path || workingDirectoryFullPath;

    if (!pattern) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'Missing required pattern parameter',
        userError: 'Pattern is required',
      };
      return;
    }

    try {
      // Build ripgrep command based on options
      const grepArgs = [];

      // Output mode
      if (options.output_mode === 'content') {
        // Show content with line numbers and context if specified
        if (options.line_numbers) {
          grepArgs.push('--line-number');
        }
        if (options.context) {
          grepArgs.push('--context', String(options.context));
        } else {
          if (options.context_before) {
            grepArgs.push('--before-context', String(options.context_before));
          }
          if (options.context_after) {
            grepArgs.push('--after-context', String(options.context_after));
          }
        }
      } else {
        // Default: only return filenames
        grepArgs.push('--files-with-matches');
      }

      // Core flags
      grepArgs.push('--no-heading');
      grepArgs.push('--color=never');
      grepArgs.push('--hidden'); // Search hidden files and directories
      grepArgs.push('--glob', '!.git/**'); // Exclude .git directory

      // Search options
      if (options.case_insensitive) {
        grepArgs.push('--ignore-case');
      }

      if (options.type) {
        // Map common file type aliases to valid ripgrep types
        const typeMapping: Record<string, string> = {
          tsx: 'ts',
          jsx: 'js',
        };
        const mappedType = typeMapping[options.type] || options.type;
        grepArgs.push('--type', mappedType);
      }

      if (options.glob_pattern) {
        grepArgs.push('--glob', options.glob_pattern);
      }

      // Auto-enable multiline mode when pattern contains literal newline characters.
      // Models frequently include literal newlines in regex patterns, causing ripgrep
      // to fail without --multiline. This makes the fix transparent to the model.
      if (options.multiline || pattern.includes('\n')) {
        grepArgs.push('--multiline');
        grepArgs.push('--multiline-dotall');
      }

      // Use ripgrep's hybrid regex engine: defaults to the linear-time Rust engine
      // and only routes to PCRE2 when a pattern needs it. LLMs frequently emit
      // patterns valid in JS/PCRE but rejected by the strict Rust engine (over-
      // escaped quotes like \", lookarounds, literal `{`); auto handles those
      // transparently with no measurable perf cost on patterns that already work.
      grepArgs.push('--engine', 'auto');

      // Fixed string mode (literal search, no regex interpretation)
      if (options.fixed_string) {
        grepArgs.push('--fixed-strings');
      }

      // Limit results to prevent stdout buffer overflow on large repos.
      // --max-count limits matching lines per file, reducing total output.
      if (options.output_mode === 'content') {
        // For content mode, use head_limit as max-count if specified,
        // otherwise default to 500 matches per file to bound output size.
        // Use nullish check (not truthiness) so head_limit=0 is intentional.
        // Clamp to a positive integer to avoid invalid ripgrep args.
        const rawLimit = options.head_limit ?? 500;
        const maxCount = Math.max(
          1,
          Math.floor(Number.isFinite(rawLimit) ? rawLimit : 500)
        );
        grepArgs.push('--max-count', String(maxCount));
      }

      // Exclude denyRead entries and re-include allowRead carve-outs.
      // In ripgrep, later globs override earlier ones, so allow re-includes
      // take precedence over the deny exclusions.
      const { deny, allow } =
        getSandboxService().getReadSubtreeGlobs(searchPath);
      for (const subtree of deny) {
        grepArgs.push('--glob', `!${subtree}`);
        grepArgs.push('--glob', `!${subtree}/**`);
      }
      for (const subtree of allow) {
        grepArgs.push('--glob', subtree);
        grepArgs.push('--glob', `${subtree}/**`);
      }

      // Always use '--' separator to prevent pattern misinterpretation as flags
      grepArgs.push('--');
      grepArgs.push(pattern);

      // Determine if searchPath is a file or directory
      let cwd = searchPath;
      let targetPath = '.';

      // Validate the path exists before using it
      if (!existsSync(searchPath)) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError: `Path does not exist: ${searchPath}`,
          userError: `The specified search path '${searchPath}' does not exist`,
        };
        return;
      }

      // Now safe to check stats
      const stats = statSync(searchPath);
      if (stats.isFile()) {
        // If it's a file, use its directory as cwd and the file as target
        cwd = dirname(searchPath);
        targetPath = basename(searchPath);
      } else if (stats.isDirectory()) {
        // If it's a directory, search recursively in it
        cwd = searchPath;
        targetPath = '.';
      } else {
        // Not a file or directory (e.g., device, socket, etc.)
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError: `Path is not a regular file or directory: ${searchPath}`,
          userError: `The specified path '${searchPath}' is not a valid file or directory`,
        };
        return;
      }

      // Add the target path
      grepArgs.push(targetPath);

      // Use the shared executeRipgrep function (uses 20MB default maxBuffer from grep-utils)
      const { stdout } = await executeRipgrep(grepArgs, cwd, {
        timeout: 30000,
      });

      // Scrub secrets from output
      const scrubbedOutput = scrubSecrets(stdout);
      const redacted = scrubbedOutput !== stdout;

      let lines = scrubbedOutput.split('\n').filter((line) => line.trim());

      if (lines.length === 0) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value:
            options.output_mode === 'content'
              ? NO_MATCHES_FOUND
              : NO_MATCHING_FILES_FOUND,
        };
        return;
      }

      // Apply head_limit if specified (use nullish check so 0 is respected)
      if (options.head_limit != null && options.head_limit > 0) {
        lines = lines.slice(0, Math.floor(options.head_limit));
      }

      let result = lines.join('\n');
      if (redacted) {
        result += `\n\n${wrapInSystemReminder(formatSecretRedactionReminder())}`;
      }

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: result,
      };
    } catch (error) {
      logWarn('Failed to execute grep search', { cause: error });
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: errorMessage,
        userError: 'Failed to search files',
      };
    }
  }
}
