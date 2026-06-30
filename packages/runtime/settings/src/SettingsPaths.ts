import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { DotFolderPaths } from './DotFolderPaths';

import type { SettingsPathsResult } from './types';

export class SettingsPaths {
  private cached: SettingsPathsResult | null = null;

  private resolver = new DotFolderPaths({
    homeDirProvider: () => getIndustryHome(),
    userDirName: getIndustryDirName(),
    // Project and folder settings always use .industry (never .industry-dev)
    projectDirName: '.industry',
    folderDirName: '.industry',
  });

  getPathsSync(cwd = process.cwd()): SettingsPathsResult {
    if (this.cached) return this.cached;
    this.cached = this.resolver.getPathsSync(cwd);
    return this.cached;
  }

  async getPaths(): Promise<SettingsPathsResult> {
    return this.getPathsSync();
  }

  reset(): void {
    this.cached = null;
    this.resolver.reset();
  }
}
