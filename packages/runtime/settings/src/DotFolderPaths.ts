import * as fs from 'fs';
import * as path from 'path';

import { logWarn } from '@industry/logging';

import { arePathsEqual } from './pathComparison';

import type { SettingsPathsResult } from './types';

type DotFolderPathsConfig = {
  homeDirProvider: () => string;
  userDirName: string;
  projectDirName: string;
  folderDirName: string;
};

function directoryExistsSync(dirPath: string): boolean {
  try {
    const stats = fs.statSync(dirPath);
    return stats.isDirectory();
  } catch (err) {
    logWarn('Failed to stat directory', { cause: err });
    return false;
  }
}

function gitExistsSync(gitPath: string): boolean {
  try {
    const stats = fs.statSync(gitPath);
    return stats.isDirectory() || stats.isFile();
  } catch (err) {
    logWarn('Failed to stat git path', { cause: err });
    return false;
  }
}

function findGitRoot(startDir: string): string | null {
  let current = startDir;

  while (current !== path.dirname(current)) {
    const gitDir = path.join(current, '.git');
    if (gitExistsSync(gitDir)) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

export class DotFolderPaths {
  private cached: SettingsPathsResult | null = null;

  private readonly config: DotFolderPathsConfig;

  constructor(config: DotFolderPathsConfig) {
    this.config = config;
  }

  getPathsSync(cwd = process.cwd()): SettingsPathsResult {
    if (this.cached) return this.cached;

    const homeDir = this.config.homeDirProvider();

    const userPath = path.join(homeDir, this.config.userDirName);

    const gitRoot = findGitRoot(cwd);
    let projectPath: string | null = null;

    if (gitRoot) {
      projectPath = path.join(gitRoot, this.config.projectDirName);
    } else {
      const isHomeDir = arePathsEqual(cwd, homeDir);
      projectPath = isHomeDir
        ? null
        : path.join(cwd, this.config.projectDirName);
    }

    const folderPaths = DotFolderPaths.discoverFolderLevels(
      cwd,
      gitRoot,
      projectPath,
      userPath,
      this.config.folderDirName
    );

    this.cached = { userPath, projectPath, folderPaths };
    return this.cached;
  }

  async getPaths(): Promise<SettingsPathsResult> {
    return this.getPathsSync();
  }

  reset(): void {
    this.cached = null;
  }

  private static discoverFolderLevels(
    cwd: string,
    gitRoot: string | null,
    projectPath: string | null,
    userPath: string,
    folderDirName: string
  ): string[] {
    if (!gitRoot) return [];

    const paths: string[] = [];
    let current = cwd;

    while (current !== gitRoot && current !== path.dirname(current)) {
      const dir = path.join(current, folderDirName);
      const isNotProject = !projectPath || !arePathsEqual(dir, projectPath);
      const isNotUser = !arePathsEqual(dir, userPath);

      if (directoryExistsSync(dir) && isNotProject && isNotUser) {
        paths.push(dir);
      }
      current = path.dirname(current);
    }

    return paths;
  }
}
