import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import { logWarn } from '@industry/logging';
import {
  parseGitleaksAllowlistPathPatterns,
  scanGitCommandForSecrets as scanGitCommandForSecretsShared,
  type GitExecutor,
  type GitExecutorParams,
  type SecretFinding,
} from '@industry/utils/secretScrubber';

import { SECRET_SCANNER_MAX_BUFFER } from '@/tools/executors/client/shell/constants';
import { ScanUnavailableError } from '@/tools/executors/client/shell/errors';

const execFileAsync = promisify(execFile);
const GITLEAKS_CONFIG_FILE = '.gitleaks.toml';

/**
 * Heuristic: was the error raised because execFile's stdout/stderr buffer
 * overflowed? Node sets `code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` on
 * recent versions; older versions only expose a matching message string.
 */
function isMaxBufferError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: unknown; message?: unknown };
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true;
  if (typeof err.message === 'string' && err.message.includes('maxBuffer')) {
    return true;
  }
  return false;
}

/**
 * Node.js-specific git executor implementation
 */
const execGit: GitExecutor = async ({
  args,
  cwd,
}: GitExecutorParams): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: SECRET_SCANNER_MAX_BUFFER,
    });
    return stdout || '';
  } catch (error) {
    if (isMaxBufferError(error)) {
      // Fail closed: the diff is too large to scan with execFile, so we
      // cannot honestly say "no secrets found". Propagate a typed error so
      // the calling hook can block the commit/push with a clear message.
      //
      // Deliberately avoid logging `args` or `cwd` — they can include local
      // filesystem paths, branch/ref names, and other user state that we
      // don't want shipped to centralized telemetry from a security path.
      logWarn('Secret scanner git exec exceeded maxBuffer; failing closed', {
        command: args[0],
        sizeBytes: SECRET_SCANNER_MAX_BUFFER,
      });
      const joinedArgs = args.join(' ');
      const message = `Drool-Shield secret scanner could not buffer the full output of \`git ${joinedArgs}\` (diff exceeded the configured buffer size).`;
      throw new ScanUnavailableError(message);
    }
    // Non‑git repo or other failure; treat as no output. Same reasoning as
    // above for omitting `args` / `cwd` from the log payload.
    logWarn('Secret scanner git exec failed', {
      command: args[0],
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
};

async function loadGitleaksAllowlistPathPatterns(
  cwd: string
): Promise<string[]> {
  const repoRoot =
    (
      await execGit({
        args: ['rev-parse', '--show-toplevel'],
        cwd,
      })
    ).trim() || cwd;
  const configPath = path.join(repoRoot, GITLEAKS_CONFIG_FILE);

  try {
    const config = await readFile(configPath, 'utf8');
    return parseGitleaksAllowlistPathPatterns(config);
  } catch {
    return [];
  }
}

interface ScanGitCommandForSecretsParams {
  normalizedGitSubcommand: string;
  cwd: string;
}

/**
 * Scan git command for secrets using the shared implementation
 */
export async function scanGitCommandForSecrets({
  normalizedGitSubcommand,
  cwd,
}: ScanGitCommandForSecretsParams): Promise<SecretFinding[]> {
  const gitleaksAllowlistPathPatterns =
    await loadGitleaksAllowlistPathPatterns(cwd);
  return scanGitCommandForSecretsShared(normalizedGitSubcommand, cwd, execGit, {
    gitleaksAllowlistPathPatterns,
  });
}
