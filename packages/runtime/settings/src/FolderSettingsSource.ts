import { EventEmitter } from 'events';
import * as fs from 'fs';

import { IndustrySettingsFolder } from './IndustrySettingsFolder';

import type { SettingsFolder, SettingsFolderIndustry } from './types';
import type { Settings } from '@industry/common/settings';

function directoryExistsSync(dirPath: string): boolean {
  try {
    const stats = fs.statSync(dirPath);
    return stats.isDirectory();
    // eslint-disable-next-line industry/require-catch-handling
  } catch (_err) {
    return false;
  }
}

export class FolderSettingsSource extends EventEmitter {
  private readonly folderPath: string;

  private folder: SettingsFolder | null = null;

  private folderIndustry: SettingsFolderIndustry;

  private cache: Settings | null = null;

  private watchingEnabled = false;

  constructor(
    folderPath: string,
    watch = false,
    folderIndustry: SettingsFolderIndustry = (p, w) =>
      new IndustrySettingsFolder(p, w)
  ) {
    super();
    this.folderPath = folderPath;
    this.watchingEnabled = watch;
    this.folderIndustry = folderIndustry;
  }

  getFolderPath(): string {
    return this.folderPath;
  }

  async load(): Promise<Settings> {
    if (this.cache) return this.cache;

    if (!directoryExistsSync(this.folderPath)) {
      this.cache = {};
      return this.cache;
    }

    const folder = this.ensureFolder();
    this.cache = await folder.load();
    return this.cache;
  }

  async persist(data: Settings): Promise<void> {
    const folder = this.ensureFolder();
    await folder.persist(data);
  }

  async readSettingsJsonRaw(): Promise<Record<string, unknown>> {
    return this.ensureFolder().readSettingsJsonRaw();
  }

  async patchSettingsJsonRaw(patch: Record<string, unknown>): Promise<void> {
    await this.ensureFolder().patchSettingsJsonRaw(patch);
    this.invalidate();
  }

  startWatching(): void {
    this.watchingEnabled = true;
    this.folder?.startWatching();
  }

  stopWatching(): void {
    this.watchingEnabled = false;
    this.folder?.stopWatching();
  }

  invalidate(): void {
    this.cache = null;
  }

  reset(): void {
    this.folder?.stopWatching();
    this.folder = null;
    this.cache = null;
  }

  private ensureFolder(): SettingsFolder {
    if (!this.folder) {
      this.folder = this.folderIndustry(this.folderPath, this.watchingEnabled);
      this.folder.on('change', () => {
        this.invalidate();
        this.emit('change');
      });
    }
    return this.folder;
  }
}
