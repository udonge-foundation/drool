import * as os from 'os';
import * as path from 'path';

/**
 * Get the lock file directory path.
 * Returns: ~/.industry/ide/
 */
export function getLockFileDirectory(): string {
  return path.join(os.homedir(), '.industry', 'ide');
}
