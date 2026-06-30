import * as path from 'path';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

/**
 * Gets the absolute path to the missions directory
 */
export function getMissionsDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'missions');
}
