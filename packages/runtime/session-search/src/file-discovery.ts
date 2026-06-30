import * as fs from 'fs';
import * as path from 'path';

import { logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { promisePool } from '@industry/utils/promise';

import type { SessionJsonlFileHandle } from './types';

const FILE_READ_CONCURRENCY = 50;

function getSessionsBaseDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'sessions');
}

export async function listAllSessionJsonlFiles(): Promise<
  SessionJsonlFileHandle[]
> {
  const sessionsDir = getSessionsBaseDir();
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const entries = await fs.promises.readdir(sessionsDir, {
    withFileTypes: true,
  });

  // Collect all jsonl file paths from global + project directories
  const allFiles: Array<{ sessionId: string; jsonlPath: string }> = [];

  // 1) Global sessions: *.jsonl directly under sessionsDir
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      allFiles.push({
        sessionId: entry.name.replace(/\.jsonl$/, ''),
        jsonlPath: path.join(sessionsDir, entry.name),
      });
    }
  }

  // 2) Project sessions: immediate subdirs starting with '-' containing *.jsonl
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('-')) {
      const dirPath = path.join(sessionsDir, entry.name);
      try {
        const dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const fileEntry of dirEntries) {
          if (fileEntry.isFile() && fileEntry.name.endsWith('.jsonl')) {
            allFiles.push({
              sessionId: fileEntry.name.replace(/\.jsonl$/, ''),
              jsonlPath: path.join(dirPath, fileEntry.name),
            });
          }
        }
      } catch (err) {
        logWarn('Failed to read project session directory', { cause: err });
      }
    }
  }

  // Stat all files with bounded concurrency to avoid ENFILE
  const tasks = allFiles.map(
    ({ sessionId, jsonlPath }) =>
      async (): Promise<SessionJsonlFileHandle> => {
        const stat = await fs.promises.stat(jsonlPath);
        return { sessionId, jsonlPath, mtimeMs: stat.mtimeMs, size: stat.size };
      }
  );

  const { results } = await promisePool(tasks, FILE_READ_CONCURRENCY, {
    throwErrors: false,
  });

  return results.filter((r): r is SessionJsonlFileHandle => r !== undefined);
}
