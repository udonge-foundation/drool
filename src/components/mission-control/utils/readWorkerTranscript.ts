/**
 * Utility helpers for worker session transcript paths.
 */

import path from 'path';

import { sanitizePathToDirectoryName } from '@industry/utils/sessionPaths';

import { getUserIndustryDir } from '@/utils/industryPaths';

/**
 * Get the path to a worker session transcript file.
 * Worker sessions are stored under ~/.industry-dev/sessions/{sanitizedWorkingDir}/{sessionId}.jsonl
 */
export function getWorkerTranscriptPath(params: {
  workerSessionId: string;
  workingDirectory: string;
}): string {
  const { workerSessionId, workingDirectory } = params;
  const base = path.join(getUserIndustryDir(), 'sessions');
  const cwdDir = sanitizePathToDirectoryName(workingDirectory);
  return path.join(base, cwdDir, `${workerSessionId}.jsonl`);
}
