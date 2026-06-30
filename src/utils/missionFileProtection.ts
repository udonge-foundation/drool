import * as fs from 'fs';
import * as path from 'path';

import { logException } from '@industry/logging';

import { getMissionsDir } from '@/utils/getMissionsDir';

/**
 * Mission system files that should not be modified by LLM agents.
 * These are managed by the system (MissionFileService/MissionRunner).
 */
const MISSION_SYSTEM_FILES = [
  'state.json',
  'progress_log.jsonl',
  'model-settings.json',
];
const MISSION_WORKER_PROTECTED_FILES = ['features.json'];

function isMissionFileWithName(filePath: string, fileNames: string[]): boolean {
  const missionsDir = getMissionsDir();

  // Resolve to absolute paths, handling symlinks
  let resolvedFilePath: string;
  try {
    // If file exists, use realpath to resolve symlinks
    resolvedFilePath = fs.realpathSync(filePath);
  } catch {
    // If file doesn't exist, resolve parent directory and append basename
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    try {
      const resolvedDir = fs.realpathSync(dir);
      resolvedFilePath = path.join(resolvedDir, base);
    } catch {
      // If parent doesn't exist either, just use absolute path
      resolvedFilePath = path.resolve(filePath);
    }
  }

  // Use realpathSync to resolve symlinks (e.g., /var -> /private/var on macOS)
  // Fall back to path.resolve if the directory doesn't exist yet
  let resolvedMissionsDir: string;
  try {
    resolvedMissionsDir = fs.realpathSync(missionsDir);
  } catch {
    resolvedMissionsDir = path.resolve(missionsDir);
  }

  // Check if the file is within the missions directory
  const isInMissionsDir =
    resolvedFilePath.startsWith(resolvedMissionsDir + path.sep) ||
    resolvedFilePath === resolvedMissionsDir;

  if (!isInMissionsDir) {
    return false;
  }

  // Check if this is a protected mission file
  const fileName = path.basename(resolvedFilePath);
  return fileNames.includes(fileName);
}

/**
 * Checks if a given file path is a protected mission system file.
 * Protected files are state.json, progress_log.jsonl, and model-settings.json
 * within mission directories.
 *
 * Uses realpath to resolve symlinks and prevent bypasses.
 */
export function isMissionSystemFile(filePath: string): boolean {
  try {
    return isMissionFileWithName(filePath, MISSION_SYSTEM_FILES);
  } catch (error) {
    logException(error, 'Error checking mission system file', {
      filePath,
    });
    // On any error, be conservative and allow the operation
    // (unlike artifacts, we don't want to block legitimate writes)
    return false;
  }
}

/**
 * Checks if a given file path is a mission file workers may not mutate.
 * The caller is responsible for checking whether the current session is a
 * worker/validator session.
 */
export function isMissionWorkerProtectedFile(filePath: string): boolean {
  try {
    return isMissionFileWithName(filePath, MISSION_WORKER_PROTECTED_FILES);
  } catch (error) {
    logException(error, 'Error checking worker-protected mission file', {
      filePath,
    });
    // On any error, be conservative and allow the operation
    // (unlike artifacts, we don't want to block legitimate writes)
    return false;
  }
}
