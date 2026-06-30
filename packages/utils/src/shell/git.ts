import * as fs from 'fs';
import * as path from 'path';

import { logWarn } from '@industry/logging';

/**
 * Find the root directory of a git repository by searching upward from the given directory
 *
 * @param startDir - Directory to start searching from (defaults to cwd)
 * @returns Path to the git repository root, or null if not found
 */
export function findGitRoot(startDir?: string): string | null {
  try {
    let dir = path.resolve(startDir || process.cwd());
    while (true) {
      const candidate = path.join(dir, '.git');
      try {
        const st = fs.statSync(candidate);
        if (st.isDirectory() || st.isFile()) return dir;
      } catch (err) {
        logWarn('Failed to stat .git in directory', { cause: err });
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
  } catch (err) {
    logWarn('Failed to find git root', { cause: err });
  }
  return null;
}
