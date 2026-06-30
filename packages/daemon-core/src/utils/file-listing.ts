/**
 * Utility for listing files using ripgrep
 */

import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { getIndustryDirName } from '@industry/utils/environment';

const execFileAsync = promisify(execFile);

const RIPGREP_DEFAULTS = {
  TIMEOUT: 10_000, // 10 seconds
  MAX_BUFFER: 100 * 1024 * 1024, // 100MB
};

/**
 * Get the path to the ripgrep binary
 */
function getRipgrepPath(): string {
  // Use the embedded ripgrep binary from Industry directory
  // On Windows, the binary is named rg.exe
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const rgPath = path.join(
    os.homedir(),
    getIndustryDirName(),
    'bin',
    binaryName
  );
  return rgPath;
}

/**
 * List all files in a directory using ripgrep
 */
export async function listFiles(
  cwd: string,
  options: {
    showHidden?: boolean;
    timeout?: number;
    maxBuffer?: number;
  } = {}
): Promise<string[]> {
  const {
    showHidden = false,
    timeout = RIPGREP_DEFAULTS.TIMEOUT,
    maxBuffer = RIPGREP_DEFAULTS.MAX_BUFFER,
  } = options;

  const rgPath = getRipgrepPath();
  const args = [
    '--files',
    '--no-messages', // Suppress error messages about permission denied
  ];

  if (showHidden) {
    args.push('--hidden');
  }

  // Common exclusions for faster scanning
  const excludePatterns = [
    '.git',
    'node_modules',
    '.next',
    'dist',
    'build',
    '.turbo',
    'coverage',
    '.cache',
    'out',
    '.DS_Store',
    'Library', // Exclude macOS Library folder (contains protected directories)
  ];

  for (const pattern of excludePatterns) {
    args.push('--glob', `!${pattern}/**`);
  }

  args.push('.');

  try {
    const result = await execFileAsync(rgPath, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      maxBuffer,
    });

    if (!result.stdout) {
      return [];
    }

    return result.stdout
      .trim()
      .split('\n')
      .filter((file) => file.length > 0)
      .map((file) => {
        const cleaned = file.startsWith('./') ? file.substring(2) : file;
        // Normalize to POSIX paths (forward slashes) for cross-platform compatibility
        return cleaned.replace(/\\/g, '/');
      });
  } catch (error: unknown) {
    // Handle ripgrep errors
    if (error && typeof error === 'object') {
      const code = 'code' in error ? error.code : undefined;
      const stdout =
        'stdout' in error && typeof error.stdout === 'string'
          ? error.stdout
          : undefined;
      const killed = 'killed' in error ? error.killed : undefined;

      // Exit code 1 means "no matches found" which is OK for file listing
      if (code === 1) {
        return [];
      }

      // Exit code 2 means ripgrep encountered errors (e.g. permission denied on some dirs)
      // but may still have produced partial results in stdout
      if (code === 2 && stdout) {
        return stdout
          .trim()
          .split('\n')
          .filter((file) => file.length > 0)
          .map((file) => {
            const cleaned = file.startsWith('./') ? file.substring(2) : file;
            return cleaned.replace(/\\/g, '/');
          });
      }

      // ENOENT means the ripgrep binary was not found
      if (code === 'ENOENT') {
        return [];
      }

      // Process killed (e.g. timeout exceeded)
      if (killed) {
        return [];
      }
    }

    // Re-throw other errors
    throw error;
  }
}
