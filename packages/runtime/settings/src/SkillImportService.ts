import * as fs from 'fs';
import * as path from 'path';

import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { MetaError } from '@industry/logging/errors';

import { SettingsManager } from './SettingsManager';
import { SettingsPaths } from './SettingsPaths';

import type { SkillImportSettingsProvider } from './types';

export class SkillImportService {
  // eslint-disable-next-line no-use-before-define
  private static instance: SkillImportService | null = null;

  private paths = new SettingsPaths();

  private settingsProvider: SkillImportSettingsProvider;

  constructor(settingsProvider: SkillImportSettingsProvider) {
    this.settingsProvider = settingsProvider;
  }

  static getInstance(): SkillImportService {
    if (!SkillImportService.instance) {
      SkillImportService.instance = new SkillImportService(
        SettingsManager.getInstance()
      );
    }
    return SkillImportService.instance;
  }

  static resetInstance(): void {
    SkillImportService.instance = null;
  }

  async importSkillDirectory(
    sourceDir: string,
    targetName: string,
    level: SettingsLevel
  ): Promise<void> {
    if (level === SettingsLevel.Folder || level === SettingsLevel.Org) {
      throw new MetaError(
        'Skill import is only supported for user and project levels'
      );
    }

    const skillFilePath = path.join(sourceDir, 'SKILL.md');
    try {
      await fs.promises.access(skillFilePath);
    } catch (err) {
      throw new MetaError('Source directory does not contain SKILL.md', {
        cause: err,
      });
    }

    const { userPath, projectPath } = await this.paths.getPaths();
    const targetBasePath =
      level === SettingsLevel.User ? userPath : projectPath;

    if (!targetBasePath) {
      throw new MetaError('Cannot determine target path for skill import');
    }

    const safeName = targetName
      .replace(/[/\\]/g, '-')
      .replace(/\.\./g, '')
      .replace(/^\.+/, '');

    const targetDir = path.join(targetBasePath, 'skills', safeName);

    const resolvedTarget = path.resolve(targetDir);
    const resolvedBase = path.resolve(targetBasePath);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
      throw new MetaError(
        'Invalid skill name contains path traversal characters'
      );
    }

    await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.promises.cp(sourceDir, targetDir, { recursive: true });
    this.settingsProvider.refresh();
  }
}
