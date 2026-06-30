import {
  MissionState,
  type ProgressLogEntry,
} from '@industry/drool-sdk-ext/protocol/drool';

import { getMissionFileService } from '@/services/mission/MissionFileService';
import { getMissionTokenUsageBySession } from '@/services/mission/missionTokenUsage';
import { MissionFileErrorType } from '@/utils/enums';
import type { MissionFileError, MissionStateResult } from '@/utils/types';

import type { TokenUsage } from '@industry/common/session/settings';

/**
 * Categorize a file operation error into a specific type
 */
function categorizeFileError(
  error: unknown,
  filePath: string
): MissionFileError {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (error as NodeJS.ErrnoException).code;

  if (code === 'ENOENT') {
    return {
      type: MissionFileErrorType.NotFound,
      message: `File not found: ${filePath}`,
      filePath,
      cause: err,
    };
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return {
      type: MissionFileErrorType.PermissionError,
      message: `Permission denied: ${filePath}`,
      filePath,
      cause: err,
    };
  }

  if (err instanceof SyntaxError || err.name === 'SyntaxError') {
    return {
      type: MissionFileErrorType.ParseError,
      message: `Invalid JSON in ${filePath}: ${err.message}`,
      filePath,
      cause: err,
    };
  }

  return {
    type: MissionFileErrorType.ReadError,
    message: `Error reading ${filePath}: ${err.message}`,
    filePath,
    cause: err,
  };
}

/**
 * Load mission state with detailed error information
 */
export async function loadMissionStateWithDetails(
  sessionId: string,
  cwd?: string,
  options?: {
    includeTokenUsage?: boolean;
    /**
     * Cache of token usage for completed worker sessions. Completed workers
     * will not be re-read from disk; only the orchestrator and active workers
     * are fetched. The caller should persist this across polls and merge
     * newly completed workers into it after each call.
     */
    completedTokenCache?: Record<string, TokenUsage>;
  }
): Promise<MissionStateResult> {
  const missionFileService = getMissionFileService(sessionId);

  const exists = await missionFileService.missionExists();
  if (!exists) {
    return {
      success: false,
      error: {
        type: MissionFileErrorType.NotFound,
        message: 'Mission directory not found',
        filePath: missionFileService.getMissionDir(),
      },
    };
  }

  const filePaths = missionFileService.getFilePaths();
  const missionTitle = await missionFileService.readMissionTitle();

  // Try to read state.json
  let state;
  try {
    state = await missionFileService.readStateOrThrow();
  } catch (error) {
    const fileError = categorizeFileError(error, filePaths.state);
    // ENOENT for state.json is expected for planning missions.
    if (fileError.type !== MissionFileErrorType.NotFound) {
      return { success: false, error: fileError };
    }
    state = null;
  }
  const workingDirectory =
    state?.workingDirectory ??
    (await missionFileService.readWorkingDirectory());

  // Try to read features.json
  let featuresFile;
  try {
    featuresFile = await missionFileService.readFeaturesOrThrow();
  } catch (error) {
    const fileError = categorizeFileError(error, filePaths.features);
    // ENOENT for features.json is expected
    if (fileError.type !== MissionFileErrorType.NotFound) {
      return { success: false, error: fileError };
    }
    featuresFile = null;
  }

  // Try to read progress log
  let progressLog: ProgressLogEntry[];
  let derivedWorkerStates: Record<
    string,
    { startedAt: string; completedAt?: string; exitCode?: number }
  >;
  try {
    const result =
      await missionFileService.readProgressLogWithDerivedWorkerStatesOrThrow();
    progressLog = result.progressLog;
    derivedWorkerStates = result.derivedWorkerStates;
  } catch (error) {
    const fileError = categorizeFileError(error, filePaths.progressLog);
    if (fileError.type !== MissionFileErrorType.NotFound) {
      return { success: false, error: fileError };
    }
    progressLog = [];
    derivedWorkerStates = {};
  }

  // Aggregate worker session IDs from all features
  const allWorkerSessionIds = (featuresFile?.features ?? []).flatMap(
    (f) => f.workerSessionIds ?? []
  );

  // Get token usage
  // The orchestrator and worker sessions may live in different session
  // directories (e.g., orchestrator launched from apps/cli while workers use
  // the repo root). We pass both cwd and the mission's workingDirectory as
  // fallback candidates so each session is found regardless of which
  // directory it was created in.
  //
  // Perf: use completedTokenCache to avoid re-reading settings files for
  // workers that have already completed (their token usage won't change).
  let tokenUsageBySessionId: Record<string, TokenUsage>;
  if (options?.includeTokenUsage === false) {
    tokenUsageBySessionId = {};
  } else {
    const workerCwd = state?.workingDirectory;
    const allWorkerIds = allWorkerSessionIds;
    const cache = options?.completedTokenCache ?? {};
    const workerStates = derivedWorkerStates;

    // Partition workers into cached (completed + in cache) and uncached
    const cachedUsage: Record<string, TokenUsage> = {};
    const uncachedSessionIds: string[] = [sessionId]; // always re-read orchestrator
    for (const wid of allWorkerIds) {
      if (workerStates[wid]?.completedAt && cache[wid]) {
        cachedUsage[wid] = cache[wid];
      } else {
        uncachedSessionIds.push(wid);
      }
    }

    try {
      const freshUsage = await getMissionTokenUsageBySession({
        sessionIds: uncachedSessionIds,
        cwd,
        fallbackCwds: [workerCwd],
      });
      tokenUsageBySessionId = { ...cachedUsage, ...freshUsage };
    } catch {
      // Token usage is optional - continue without it
      tokenUsageBySessionId = { ...cachedUsage };
    }
  }

  const tokenUsage = Object.values(tokenUsageBySessionId).reduce<TokenUsage>(
    (acc, usage) => ({
      inputTokens: acc.inputTokens + usage.inputTokens,
      outputTokens: acc.outputTokens + usage.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + usage.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + usage.cacheReadTokens,
      thinkingTokens: acc.thinkingTokens + usage.thinkingTokens,
      industryCredits: (acc.industryCredits ?? 0) + (usage.industryCredits ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      industryCredits: 0,
    }
  );

  // The mission can exist before state.json is created (e.g., after propose_mission
  // but before start_mission_run). In that case, treat it as planning.
  if (!state) {
    return {
      success: true,
      data: {
        state: MissionState.Planning,
        title: missionTitle ?? undefined,
        workingDirectory: workingDirectory ?? undefined,
        features: featuresFile?.features ?? [],
        progressLog,
        workerSessionIds: [],
        tokenUsage,
        tokenUsageBySessionId,
      },
    };
  }

  for (const workerSessionId of allWorkerSessionIds) {
    if (!derivedWorkerStates[workerSessionId]) {
      derivedWorkerStates[workerSessionId] = {
        startedAt: state.createdAt,
      };
    }
  }

  return {
    success: true,
    data: {
      state: state.state,
      title: missionTitle ?? undefined,
      workingDirectory: workingDirectory ?? undefined,
      features: featuresFile?.features ?? [],
      progressLog,
      workerSessionIds: allWorkerSessionIds,
      tokenUsageBySessionId,
      tokenUsage,
      workerStates:
        Object.keys(derivedWorkerStates).length > 0
          ? derivedWorkerStates
          : undefined,
    },
  };
}
