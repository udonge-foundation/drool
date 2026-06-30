import path from 'path';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

export function getSquadsDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'squads');
}
