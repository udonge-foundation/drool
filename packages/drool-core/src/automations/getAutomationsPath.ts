import * as path from 'path';

import { AUTOMATIONS_DIR_NAME } from '@industry/common/automations';

/**
 * Get the automations directory path for a given base path.
 *
 * @param basePath - The base path (e.g., project root or home directory)
 * @returns The full path to the automations directory
 */
export function getAutomationsPath(
  basePath: string,
  industryDirName: string = '.industry'
): string {
  return path.join(basePath, industryDirName, AUTOMATIONS_DIR_NAME);
}
