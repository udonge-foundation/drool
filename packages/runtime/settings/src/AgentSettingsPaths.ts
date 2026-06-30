import { getIndustryHome } from '@industry/utils/cli';

import { AGENT_DIR_NAME, AGENTS_DIR_NAME } from './constants';
import { DotFolderPaths } from './DotFolderPaths';

import type { AgentSettingsPathsResult } from './types';

export class AgentSettingsPaths {
  private cachedAll: AgentSettingsPathsResult | null = null;

  // Primary resolver for .agents
  private agentsResolver = AgentSettingsPaths.buildResolver(AGENTS_DIR_NAME);

  // Legacy resolver for .agent
  private agentResolver = AgentSettingsPaths.buildResolver(AGENT_DIR_NAME);

  private static buildResolver(dirName: string): DotFolderPaths {
    return new DotFolderPaths({
      homeDirProvider: () => getIndustryHome(),
      userDirName: dirName,
      projectDirName: dirName,
      folderDirName: dirName,
    });
  }

  getAllPathsSync(cwd = process.cwd()): AgentSettingsPathsResult {
    if (this.cachedAll) return this.cachedAll;

    const primary = this.agentsResolver.getPathsSync(cwd);
    const legacy = this.agentResolver.getPathsSync(cwd);

    this.cachedAll = {
      userPaths: [primary.userPath, legacy.userPath].filter(
        (path): path is string => Boolean(path)
      ),
      projectPaths: [primary.projectPath, legacy.projectPath].filter(
        (path): path is string => Boolean(path)
      ),
      folderPaths: [...primary.folderPaths, ...legacy.folderPaths],
    };

    return this.cachedAll;
  }

  async getAllPaths(): Promise<AgentSettingsPathsResult> {
    return this.getAllPathsSync();
  }

  reset(): void {
    this.cachedAll = null;
    this.agentsResolver.reset();
    this.agentResolver.reset();
  }
}
