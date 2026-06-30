/**
 * Utility functions for ripgrep operations
 */

import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';

import { logWarn } from '@industry/logging';

import { RipgrepError } from '@/utils/errors';
import { ensureRipgrepBinary } from '@/utils/ripgrepEmbedded';

const execFileAsync = promisify(execFile);

const RIPGREP_DEFAULTS = {
  TIMEOUT: 10_000, // 10 seconds
  MAX_BUFFER: 20 * 1024 * 1024, // 20MB buffer to handle large result sets
} as const;

const MAX_BUFFER_TRUNCATION_WARNING =
  '\n[Results truncated: output exceeded maximum buffer size. Narrow your search pattern or use glob_pattern/type to filter results.]';

const RIPGREP_EXIT_CODES = {
  SUCCESS: 0,
  NO_MATCHES: 1,
  ERROR: 2,
} as const;

/**
 * Directories that should always be excluded from ripgrep operations.
 * These are VCS and build artifact directories that:
 * 1. Pollute search results with internal metadata
 * 2. Can contain thousands of files hurting performance
 * 3. Should never be indexed or searched in normal workflows
 */
const ALWAYS_EXCLUDED_DIRS = [
  '.git/**', // Git version control metadata
] as const;

/**
 * Apply always-excluded directory patterns to ripgrep args.
 * This ensures .git and other VCS directories are never indexed or searched,
 * even when using --hidden flag.
 */
function applyAlwaysExcludedDirs(args: string[]): void {
  for (const pattern of ALWAYS_EXCLUDED_DIRS) {
    args.push('--glob', `!${pattern}`);
  }
}

/**
 * Maximum number of attempts to initialize the ripgrep binary across a
 * session. Prevents a single transient failure (e.g. race condition during
 * extraction, permission blip) from permanently disabling Grep/Glob for the
 * rest of the session and triggering the model to loop on unusable tools.
 */
const MAX_RIPGREP_INIT_ATTEMPTS = 3;

/**
 * Cached ripgrep path.
 *   null      = not yet resolved (retry allowed on next call)
 *   undefined = permanently failed after MAX_RIPGREP_INIT_ATTEMPTS
 *   string    = resolved path
 */
let cachedRipgrepPath: string | undefined | null = null;
let ripgrepInitAttempts = 0;

/**
 * Reset cached ripgrep state. Exported for unit tests only.
 * @internal
 */
export function _resetRipgrepPathCacheForTesting(): void {
  cachedRipgrepPath = null;
  ripgrepInitAttempts = 0;
}

/**
 * Resolve ripgrep path with lazy initialization, caching, and bounded retry
 * on failure. Uses the embedded ripgrep binary from the CLI bundle.
 *
 * On a transient failure the result is **not** cached so that the next call
 * will retry. After {@link MAX_RIPGREP_INIT_ATTEMPTS} total failures the
 * result is cached as `undefined` to avoid unbounded work.
 *
 * Returns undefined if ripgrep cannot be resolved.
 */
export function getRipgrepPath(): string | undefined {
  if (typeof cachedRipgrepPath === 'string') {
    return cachedRipgrepPath;
  }
  // All retries exhausted — permanently failed.
  if (cachedRipgrepPath === undefined) {
    return undefined;
  }

  try {
    cachedRipgrepPath = ensureRipgrepBinary();
    return cachedRipgrepPath;
  } catch (error) {
    ripgrepInitAttempts++;

    if (ripgrepInitAttempts >= MAX_RIPGREP_INIT_ATTEMPTS) {
      logWarn('Failed to initialize ripgrep after max attempts', {
        attempt: `${ripgrepInitAttempts}/${MAX_RIPGREP_INIT_ATTEMPTS}`,
        cause: error,
      });
      cachedRipgrepPath = undefined;
    } else {
      logWarn('Failed to initialize ripgrep, will retry on next call', {
        attempt: `${ripgrepInitAttempts}/${MAX_RIPGREP_INIT_ATTEMPTS}`,
        cause: error,
      });
      // Leave cachedRipgrepPath === null so the next call retries.
    }

    return undefined;
  }
}

/**
 * Execute ripgrep command with proper error handling
 */
export async function executeRipgrep(
  args: string[],
  cwd: string,
  options: {
    timeout?: number;
    maxBuffer?: number;
    // Dependency injection for testing
    platform?: NodeJS.Platform;
    homeDir?: string;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  const {
    timeout = RIPGREP_DEFAULTS.TIMEOUT,
    maxBuffer = RIPGREP_DEFAULTS.MAX_BUFFER,
    platform = process.platform,
    homeDir = os.homedir(),
  } = options;

  const rgPath = getRipgrepPath();

  if (!rgPath) {
    // Only emit the definitive "do not retry" guidance once all init retries
    // are exhausted (cachedRipgrepPath === undefined). On transient failures
    // (cachedRipgrepPath === null) a subsequent call may still succeed, so we
    // keep the message open-ended to let the model retry naturally.
    if (cachedRipgrepPath === undefined) {
      throw new RipgrepError(
        'Ripgrep binary not found and could not be restored after retries. ' +
          'Do NOT retry Grep or Glob tools — they will continue to fail this session. ' +
          'Use the Execute tool with shell commands (e.g. find, grep) as alternatives.',
        null,
        '' // stderr is empty since ripgrep wasn't executed
      );
    }
    throw new RipgrepError(
      'Ripgrep binary not found. Initialization failed but retries are still available — subsequent calls may succeed.',
      null,
      '' // stderr is empty since ripgrep wasn't executed
    );
  }

  // Create a copy of args to avoid modifying the input array
  let finalArgs = [...args];

  // On macOS, exclude common system/user folders when running from home directory
  if (platform === 'darwin' && cwd === homeDir) {
    const macOSExclusions = [
      '.DS_Store',
      '.Trash/**',
      'Library/**',
      'Pictures/**',
      'Music/**',
      'Movies/**',
    ];

    // Prepend exclusion arguments to the beginning of args array
    const exclusionArgs = macOSExclusions.flatMap((pattern) => [
      '--glob',
      `!${pattern}`,
    ]);
    finalArgs = [...exclusionArgs, ...finalArgs];
  }

  try {
    const result = await execFileAsync(rgPath, finalArgs, {
      cwd,
      encoding: 'utf8',
      timeout,
      maxBuffer,
    });

    return { stdout: result.stdout, stderr: result.stderr || '' };
  } catch (error: unknown) {
    // Handle different exit codes appropriately
    if (error && typeof error === 'object' && 'code' in error) {
      const errorWithCode = error as {
        code?: number | string;
        message?: string;
        stderr?: string;
        stdout?: string;
      };

      // Handle maxBuffer exceeded - return partial results instead of crashing.
      // The warning is emitted via stderr (not stdout) so structured parsers
      // that consume stdout as line-delimited data are not corrupted.
      if (
        errorWithCode.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
        (typeof errorWithCode.message === 'string' &&
          errorWithCode.message.includes('maxBuffer'))
      ) {
        const partialStdout = errorWithCode.stdout || '';
        return {
          stdout: partialStdout,
          stderr: (errorWithCode.stderr || '') + MAX_BUFFER_TRUNCATION_WARNING,
        };
      }

      // Exit code 1 means "no matches found" which is OK for file listing
      if (errorWithCode.code === RIPGREP_EXIT_CODES.NO_MATCHES) {
        return { stdout: '', stderr: '' };
      }

      // Exit code 2+ usually means actual error
      if (
        typeof errorWithCode.code === 'number' &&
        errorWithCode.code >= RIPGREP_EXIT_CODES.ERROR
      ) {
        throw new RipgrepError(
          'Ripgrep execution failed',
          errorWithCode.code,
          errorWithCode.stderr || '',
          error
        );
      }
    }

    // Re-throw other errors
    throw error;
  }
}

/** @public */
export async function listFiles(
  cwd: string,
  options: {
    showHidden?: boolean;
    timeout?: number;
    maxBuffer?: number;
  } = {}
): Promise<string[]> {
  const args = ['--files'];

  if (options.showHidden) {
    args.push('--hidden');
  }

  // Apply always-excluded directories (e.g., .git)
  applyAlwaysExcludedDirs(args);

  args.push('.');

  const { stdout } = await executeRipgrep(args, cwd, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
  });

  if (!stdout) {
    return [];
  }

  return stdout
    .trim()
    .split('\n')
    .filter((file) => file.length > 0)
    .map((file) => {
      const cleaned = file.startsWith('./') ? file.substring(2) : file;
      // Normalize to POSIX paths (forward slashes) for cross-platform compatibility
      return cleaned.replace(/\\/g, '/');
    });
}
