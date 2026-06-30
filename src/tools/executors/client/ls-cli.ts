import { execFile } from 'node:child_process';
import path from 'path';

import { ToolExecutionErrorType } from '@industry/common/session';
import { LsCliParams } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { logInfo } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';
import { matchesGlobPattern } from '@industry/utils/text';

import { extractFilenameFromLine } from '@/tools/executors/client/extractFilenameFromLine';
import {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';

const DIRECTORY_LISTING_TIMEOUT_MS = 10000;
const DIRECTORY_LISTING_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Filter directory output based on ignore patterns
 */
function filterDirectoryOutput(
  output: string,
  ignorePatterns: string[],
  platform: NodeJS.Platform
): string {
  if (!ignorePatterns || ignorePatterns.length === 0) {
    return output;
  }

  const lines = output.split('\n');
  const filteredLines = lines.filter((line) => {
    const filename = extractFilenameFromLine(line, platform);

    // Keep non-file lines (headers, totals, etc)
    if (!filename) return true;

    // Check if filename matches any ignore pattern
    for (const pattern of ignorePatterns) {
      if (matchesGlobPattern(filename, pattern)) {
        return false; // Filter out this line
      }
    }

    return true;
  });

  return filteredLines.join('\n');
}

/**
 * List directory using native commands.
 *
 * The target directory is passed as a discrete argument (POSIX) or via an
 * environment variable referenced with -LiteralPath (Windows) and the process
 * is spawned without a shell, so a path containing shell metacharacters cannot
 * break out and execute arbitrary commands.
 */
async function listDirectoryNative(
  targetDirectory: string,
  ignorePatterns?: string[]
): Promise<string> {
  const platform = process.platform;
  const isWindows = platform === 'win32';

  const file = isWindows ? 'powershell.exe' : 'ls';
  const args = isWindows
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-ChildItem -Force -LiteralPath $env:LS_TARGET_DIR | Format-Table -AutoSize',
      ]
    : ['-la', '--', targetDirectory];

  logInfo('Native directory listing started', { command: file });

  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: DIRECTORY_LISTING_TIMEOUT_MS,
        maxBuffer: DIRECTORY_LISTING_MAX_BUFFER,
        encoding: 'utf8',
        ...(isWindows
          ? { env: { ...process.env, LS_TARGET_DIR: targetDirectory } }
          : {}),
      },
      (error, stdout) => {
        if (error) {
          const err = error as { killed?: boolean; code?: number | string };

          // execFile sets killed=true both on timeout and on maxBuffer
          // overflow; only the former is an actual timeout.
          if (
            err.killed === true &&
            err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ) {
            reject(
              new MetaError('Directory listing timed out', {
                timeout: DIRECTORY_LISTING_TIMEOUT_MS,
              })
            );
            return;
          }

          const exitCode = typeof err.code === 'number' ? err.code : null;
          reject(
            new MetaError(
              `Directory listing failed with code ${err.code ?? 'unknown'}`,
              {
                exitCode,
                stdout,
              }
            )
          );
          return;
        }

        resolve(filterDirectoryOutput(stdout, ignorePatterns || [], platform));
      }
    );
  });
}

export class LsCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: LsCliParams
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { directory_path: directoryPath, ignorePatterns } = parameters;
    const { workingDirectoryFullPath } = dependencies;

    const isDotInput =
      typeof directoryPath === 'string' && directoryPath.trim() === '.';

    try {
      // Handle undefined or empty directory path
      const targetPath = isDotInput
        ? (workingDirectoryFullPath ?? process.cwd())
        : !directoryPath || typeof directoryPath !== 'string'
          ? process.cwd()
          : directoryPath;

      // Validate absolute path when provided
      if (
        !isDotInput &&
        directoryPath &&
        typeof directoryPath === 'string' &&
        !path.isAbsolute(directoryPath)
      ) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError:
            'directory_path must be an absolute path, not a relative path',
          userError: 'Directory path must be absolute',
        };
        return;
      }

      const absolutePath = path.resolve(targetPath);

      // Use native commands to list directory contents
      const result = await listDirectoryNative(absolutePath, ignorePatterns);

      // Check if directory is empty (ls -la will show . and .. even in empty dirs)
      // Consider it empty if only shows headers or just . and ..
      const lines = result.split('\n').filter((line) => line.trim());
      const hasActualContent = lines.some((line) => {
        const filename = extractFilenameFromLine(line, process.platform);
        return filename && filename !== '.' && filename !== '..';
      });

      let maybeEmptyResult = hasActualContent ? result : 'Empty directory';

      if (isDotInput) {
        const reminder = `<system-reminder>WARNING: '.' was replaced with '${absolutePath}'. Use absolute paths in subsequent tool calls.</system-reminder>`;
        maybeEmptyResult = `${maybeEmptyResult}\n\n${reminder}`;
      }

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: maybeEmptyResult,
      };
    } catch (error) {
      if (error instanceof ToolAbortError) {
        throw error;
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `LS tool call failed: ${errorMessage}`,
        userError: 'Failed to list directory',
      };
    }
  }
}
