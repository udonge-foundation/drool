import {
  MissionState,
  type MissionFeature,
  type MissionSnapshot,
  type ProgressLogEntry,
  type WorkerStateInfo,
} from '@industry/drool-sdk-ext/protocol/drool';

import type { MissionStoreInterface } from '../types';
import type { TokenUsage } from '@industry/common/session/settings';

function sumTokenUsage(
  tokenUsageBySessionId: Record<string, TokenUsage>
): TokenUsage | undefined {
  const usages = Object.values(tokenUsageBySessionId);
  if (usages.length === 0) {
    return undefined;
  }

  return usages.reduce<TokenUsage>(
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
}

function deriveWorkerStateInfo(
  progressLog: ProgressLogEntry[],
  existingWorkerStates: Record<string, WorkerStateInfo>
): Record<string, WorkerStateInfo> {
  const nextWorkerStates = { ...existingWorkerStates };

  for (const entry of progressLog) {
    if (!('workerSessionId' in entry) || !entry.workerSessionId) {
      continue;
    }

    const workerSessionId = entry.workerSessionId;
    if (!nextWorkerStates[workerSessionId]) {
      nextWorkerStates[workerSessionId] = {
        startedAt: entry.timestamp,
      };
    }

    if (entry.type === 'worker_completed') {
      nextWorkerStates[workerSessionId] = {
        ...nextWorkerStates[workerSessionId],
        completedAt: entry.timestamp,
        exitCode: entry.exitCode,
      };
    }

    if (entry.type === 'worker_failed') {
      nextWorkerStates[workerSessionId] = {
        ...nextWorkerStates[workerSessionId],
        completedAt: entry.timestamp,
        exitCode: entry.exitCode ?? nextWorkerStates[workerSessionId]?.exitCode,
      };
    }
  }

  return nextWorkerStates;
}

export class MissionStore implements MissionStoreInterface {
  private title: string | null = null;

  private state: MissionState = MissionState.AwaitingInput;

  private features: MissionFeature[] = [];

  private progressLog: ProgressLogEntry[] = [];

  private workerSessionIds = new Set<string>();

  private workerStates: Record<string, WorkerStateInfo> = {};

  private tokenUsageBySessionId: Record<string, TokenUsage> = {};

  private listeners = new Set<() => void>();

  private cachedSnapshot: MissionSnapshot | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.cachedSnapshot = null;
    for (const listener of this.listeners) {
      listener();
    }
  }

  mergeFrom(other: MissionStore): void {
    const snapshot = other.getSnapshot();
    this.title = snapshot.title ?? null;
    this.state = snapshot.state;
    this.features = snapshot.features;
    this.progressLog = snapshot.progressLog;
    this.workerSessionIds = new Set(snapshot.workerSessionIds);
    this.workerStates = snapshot.workerStates ?? {};
    this.tokenUsageBySessionId = snapshot.tokenUsageBySessionId ?? {};
    this.notify();
  }

  getSnapshot(): MissionSnapshot {
    if (this.cachedSnapshot) {
      return this.cachedSnapshot;
    }

    this.cachedSnapshot = {
      state: this.state,
      title: this.title ?? undefined,
      features: [...this.features],
      progressLog: [...this.progressLog],
      workerSessionIds: Array.from(this.workerSessionIds),
      workerStates:
        Object.keys(this.workerStates).length > 0
          ? { ...this.workerStates }
          : undefined,
      tokenUsageBySessionId:
        Object.keys(this.tokenUsageBySessionId).length > 0
          ? { ...this.tokenUsageBySessionId }
          : undefined,
      tokenUsage: sumTokenUsage(this.tokenUsageBySessionId),
    };

    return this.cachedSnapshot;
  }

  setState(state: MissionState): void {
    this.state = state;
    this.notify();
  }

  setTitle(title: string | null): void {
    this.title = title;
    this.notify();
  }

  setFeatures(features: MissionFeature[]): void {
    this.features = [...features];
    for (const feature of features) {
      for (const workerSessionId of feature.workerSessionIds ?? []) {
        this.workerSessionIds.add(workerSessionId);
      }
    }
    this.notify();
  }

  setProgressLog(entries: ProgressLogEntry[]): void {
    this.progressLog = [...entries];
    this.workerStates = deriveWorkerStateInfo(entries, this.workerStates);
    for (const workerSessionId of Object.keys(this.workerStates)) {
      this.workerSessionIds.add(workerSessionId);
    }
    this.notify();
  }

  setTokenUsageBySessionId(
    tokenUsageBySessionId: Record<string, TokenUsage>
  ): void {
    this.tokenUsageBySessionId = { ...tokenUsageBySessionId };
    this.notify();
  }

  addWorker(workerSessionId: string): void {
    this.workerSessionIds.add(workerSessionId);
    this.workerStates[workerSessionId] ??= {
      startedAt: new Date().toISOString(),
    };
    this.notify();
  }

  addWorkerWithState(workerSessionId: string, state: WorkerStateInfo): void {
    this.workerSessionIds.add(workerSessionId);
    this.workerStates[workerSessionId] = state;
    this.notify();
  }

  completeWorker(workerSessionId: string, exitCode: number): void {
    this.workerSessionIds.add(workerSessionId);
    this.workerStates[workerSessionId] = {
      startedAt:
        this.workerStates[workerSessionId]?.startedAt ??
        new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode,
    };
    this.notify();
  }

  hasWorkerSession(workerSessionId: string): boolean {
    return this.workerSessionIds.has(workerSessionId);
  }

  setSessionTokenUsage(sessionId: string, tokenUsage: TokenUsage): void {
    this.tokenUsageBySessionId = {
      ...this.tokenUsageBySessionId,
      [sessionId]: tokenUsage,
    };
    this.notify();
  }
}
