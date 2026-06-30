import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expands tilde (~) in file paths to the user's home directory
 *
 * Handles:
 * - `~` alone → home directory
 * - `~/path` → home directory + path (POSIX & Git Bash/WSL on Windows)
 * - `~\path` → home directory + path (native Windows backslash)
 *
 * @param filepath - Path that may contain a tilde
 * @returns Expanded path, or the original value if it does not start with `~`.
 *
 * @example
 * expandTilde('~/Development') // → '/Users/username/Development'
 * expandTilde('~') // → '/Users/username'
 * expandTilde('/absolute/path') // → '/absolute/path'
 */
export function expandTilde(filepath: string): string {
  if (!filepath) {
    return filepath;
  }
  if (filepath === '~') {
    return homedir();
  }
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}
