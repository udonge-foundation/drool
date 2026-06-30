import fsPromises from 'fs/promises';

import {
  FeatureSuccessState,
  ProgressLogEntryType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';

import type { MissionFileService } from '@/services/mission/MissionFileService';
import type { WorkerCompletedEntry } from '@/services/mission/types';

import type {
  StartMissionRunResult,
  WorkerHandoff,
} from '@industry/drool-core/tools/definitions';

type WorkerCompletedWithHandoff = WorkerCompletedEntry & {
  handoff: NonNullable<WorkerCompletedEntry['handoff']>;
};

function getWorkerCompletedEntriesWithHandoffs(
  progressLog: Awaited<ReturnType<MissionFileService['readProgressLog']>>
): WorkerCompletedWithHandoff[] {
  return progressLog.filter(
    (entry): entry is WorkerCompletedWithHandoff =>
      entry.type === ProgressLogEntryType.WorkerCompleted &&
      entry.handoff !== undefined
  );
}

export async function collectAndMarkNewWorkerHandoffs(params: {
  missionFileService: MissionFileService;
  includeLatestWorkerHandoff?: boolean;
}): Promise<{
  workerHandoffs: WorkerHandoff[];
  latestWorkerHandoff?: StartMissionRunResult['latestWorkerHandoff'];
}> {
  const { missionFileService, includeLatestWorkerHandoff = false } = params;

  const [progressLog, state] = await Promise.all([
    missionFileService.readProgressLog(),
    missionFileService.readState(),
  ]);

  const workerCompletedEntries =
    getWorkerCompletedEntriesWithHandoffs(progressLog);

  const lastReviewedCount = state?.lastReviewedHandoffCount ?? 0;
  const newCompletions = workerCompletedEntries.slice(lastReviewedCount);

  if (newCompletions.length === 0) {
    return { workerHandoffs: [] };
  }

  const workerHandoffs = await Promise.all(
    newCompletions.map(async (entry) => {
      const successStateValue =
        entry.successState ?? FeatureSuccessState.Failure;
      const resultState: WorkerHandoff['resultState'] =
        successStateValue === FeatureSuccessState.Success ? 'pass' : 'fail';

      const discoveredIssuesCount = entry.handoff.discoveredIssues.length;

      const unfinished = entry.handoff.whatWasLeftUndone.trim();
      const unfinishedWorkCount =
        unfinished && unfinished !== '' && unfinished.toLowerCase() !== 'none'
          ? 1
          : 0;

      const handoffFile = await missionFileService.ensureWorkerHandoffJson({
        timestamp: entry.timestamp,
        workerSessionId: entry.workerSessionId,
        featureId: entry.featureId,
        commitId: entry.commitId,
        repoPath: entry.repoPath,
        successState: successStateValue,
        returnToOrchestrator: entry.returnToOrchestrator,
        handoff: entry.handoff,
      });

      return {
        featureId: entry.featureId,
        resultState,
        discoveredIssuesCount,
        unfinishedWorkCount,
        whatWasImplemented: entry.handoff.whatWasImplemented,
        handoffFile,
      };
    })
  );

  let latestWorkerHandoff: StartMissionRunResult['latestWorkerHandoff'];

  if (includeLatestWorkerHandoff) {
    const latest = workerHandoffs[workerHandoffs.length - 1];
    try {
      const handoffJson = await fsPromises.readFile(
        latest.handoffFile,
        'utf-8'
      );
      latestWorkerHandoff = {
        featureId: latest.featureId,
        resultState: latest.resultState,
        handoffFile: latest.handoffFile,
        handoffJson,
      };
    } catch (error) {
      logWarn('[MissionHandoffs] Failed to read latest handoff json', {
        cause: error,
        filePath: latest.handoffFile,
      });
      latestWorkerHandoff = {
        featureId: latest.featureId,
        resultState: latest.resultState,
        handoffFile: latest.handoffFile,
        handoffJson:
          '(Failed to read handoff json from disk; open handoffFile manually.)',
      };
    }
  }

  await missionFileService.updateState({
    lastReviewedHandoffCount: workerCompletedEntries.length,
  });

  return { workerHandoffs, latestWorkerHandoff };
}
