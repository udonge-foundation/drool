import { MissionStore } from './MissionStore';

export class MultiMissionStateManager {
  private readonly missionStores = new Map<string, MissionStore>();

  private readonly sessionToMissionId = new Map<string, string>();

  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private getOrCreateMissionStore(missionId: string): MissionStore {
    let store = this.missionStores.get(missionId);
    if (!store) {
      store = new MissionStore();
      this.missionStores.set(missionId, store);
      this.notify();
    }
    return store;
  }

  resolveMissionId(sessionId: string): string | null {
    return this.sessionToMissionId.get(sessionId) ?? null;
  }

  associateSessionWithMission(
    sessionId: string,
    missionId: string
  ): MissionStore {
    const previousMissionId = this.sessionToMissionId.get(sessionId);
    const targetStore = this.getOrCreateMissionStore(missionId);

    if (previousMissionId && previousMissionId !== missionId) {
      const previousStore = this.missionStores.get(previousMissionId);
      if (previousStore && previousStore !== targetStore) {
        targetStore.mergeFrom(previousStore);
        const stillReferenced = Array.from(
          this.sessionToMissionId.entries()
        ).some(
          ([candidateSessionId, candidateMissionId]) =>
            candidateSessionId !== sessionId &&
            candidateMissionId === previousMissionId
        );
        if (!stillReferenced) {
          this.missionStores.delete(previousMissionId);
        }
      }
    }

    this.sessionToMissionId.set(sessionId, missionId);
    this.notify();
    return targetStore;
  }

  associateWorkerWithParentMission(
    parentSessionId: string,
    workerSessionId: string
  ): MissionStore {
    const missionId = this.resolveMissionId(parentSessionId) ?? parentSessionId;
    return this.associateSessionWithMission(workerSessionId, missionId);
  }

  getMissionStore(sessionId: string): MissionStore {
    const missionId = this.resolveMissionId(sessionId) ?? sessionId;
    return this.associateSessionWithMission(sessionId, missionId);
  }

  getMissionStoreIfKnown(sessionId: string): MissionStore | null {
    const missionId = this.resolveMissionId(sessionId);
    if (!missionId) {
      return null;
    }
    return this.getOrCreateMissionStore(missionId);
  }
}
