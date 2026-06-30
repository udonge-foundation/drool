import { existsSync, statSync } from 'fs';

import z from 'zod';

import { ToolExecutionErrorType } from '@industry/common/session';
import { globSearchCliToolSchema } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { ToolAbortError } from '@industry/logging/errors';

import {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import { executeRipgrep } from '@/utils/grep-utils';

/**
 * Execute ripgrep with multiple glob patterns
 */
async function executeRipgrepGlob(
  patterns: string[],
  excludePatterns: string[] | undefined,
  workingDirectory: string,
  reIncludePatterns?: string[]
): Promise<string[]> {
  // Build ripgrep command arguments
  // --hidden: include hidden files/directories (e.g., .github)
  // --glob '!.git/**': exclude .git directory
  const args = ['--files', '--hidden', '--glob', '!.git/**'];

  // Add include patterns
  for (const pattern of patterns) {
    args.push('--glob', pattern);
  }

  // Add exclude patterns
  if (excludePatterns) {
    for (const pattern of excludePatterns) {
      args.push('--glob', `!${pattern}`);
    }
  }

  // Add re-include patterns (allowRead carve-outs override excludes).
  // In ripgrep, later globs override earlier ones.
  if (reIncludePatterns) {
    for (const pattern of reIncludePatterns) {
      args.push('--glob', pattern);
      args.push('--glob', `${pattern}/**`);
    }
  }

  // Add the search path
  args.push('.');

  // Use the shared executeRipgrep function (uses 20MB default maxBuffer from grep-utils)
  const { stdout } = await executeRipgrep(args, workingDirectory, {
    timeout: 30000,
  });

  // Parse output - one file per line
  if (!stdout || stdout.trim().length === 0) {
    return [];
  }

  const files = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Normalize to POSIX paths (forward slashes) for cross-platform
    // consistency. On Windows, ripgrep emits paths with backslashes which
    // leak into session content and confuse downstream consumers (and e2e
    // assertions) that expect forward slashes.
    .map((line) => line.replace(/\\/g, '/'))
    .slice(0, 1000);

  return files;
}

export class CliGlobSearchExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: z.infer<typeof globSearchCliToolSchema>
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { workingDirectoryFullPath } = dependencies;
    const { patterns, excludePatterns, folder } = parameters;

    // Use folder parameter if provided, otherwise use working directory
    const searchPath = folder || workingDirectoryFullPath;

    // Validate the search path exists before proceeding
    if (!existsSync(searchPath)) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: `Search directory does not exist: ${searchPath}`,
        userError: `The specified directory '${searchPath}' does not exist`,
      };
      return;
    }

    // Validate it's actually a directory
    const stats = statSync(searchPath);
    if (!stats.isDirectory()) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: `Path is not a directory: ${searchPath}`,
        userError: `The specified path '${searchPath}' is not a directory`,
      };
      return;
    }

    // Normalize patterns: string | string[] -> string[]
    const patternsArray = typeof patterns === 'string' ? [patterns] : patterns;

    if (!patternsArray || patternsArray.length === 0) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          'At least one pattern is required for glob search. Please provide a glob pattern string or an array of glob patterns.',
        userError: 'Patterns cannot be empty',
      };
      return;
    }

    try {
      const cleanPatterns = patternsArray
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      // Normalize excludePatterns: string | string[] -> string[]
      const cleanExcludes = !excludePatterns
        ? undefined
        : (typeof excludePatterns === 'string'
            ? [excludePatterns]
            : excludePatterns
          )
            .map((p) => p.trim())
            .filter((p) => p.length > 0);

      // Add denyRead exclusions and allowRead re-includes.
      const { getSandboxService } = await import('@/services/SandboxService');
      const { deny, allow } =
        getSandboxService().getReadSubtreeGlobs(searchPath);
      const allExcludes = [
        ...(cleanExcludes ?? []),
        ...deny.flatMap((s) => [s, `${s}/**`]),
      ];

      let matchedFiles: string[] = [];

      matchedFiles = await executeRipgrepGlob(
        cleanPatterns,
        allExcludes.length > 0 ? allExcludes : undefined,
        searchPath,
        allow.length > 0 ? allow : undefined
      );

      // Format results as a string - one file per line
      const result =
        matchedFiles.length > 0
          ? matchedFiles.join('\n')
          : 'No matching files found';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        llmError: errorMessage,
        userError: 'Failed to search file',
        errorType: ToolExecutionErrorType.ToolInternalError,
      };
    }
  }
}
