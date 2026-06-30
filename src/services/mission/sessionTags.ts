import { MISSION_SESSION_TAG } from '@industry/common/session';
import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { type SessionTag } from '@industry/drool-sdk-ext/protocol/session';

import type { MissionSessionTagMetadata } from '@/services/mission/types';
import { SquadRole } from '@/services/squad/enums';
import { getSquadSessionTagMetadata } from '@/services/squad/sessionTags';

export function buildMissionSessionTag(
  metadata: MissionSessionTagMetadata
): SessionTag {
  return {
    name: MISSION_SESSION_TAG,
    metadata: {
      role: metadata.role,
      missionId: metadata.missionId,
    },
  };
}

export function upsertMissionSessionTag(
  tags: SessionTag[] | undefined,
  metadata: MissionSessionTagMetadata
): SessionTag[] {
  return [
    ...(tags ?? []).filter((tag) => tag.name !== MISSION_SESSION_TAG),
    buildMissionSessionTag(metadata),
  ];
}

export function removeMissionSessionTag(
  tags: SessionTag[] | undefined
): SessionTag[] | undefined {
  const nextTags = (tags ?? []).filter(
    (candidate) => candidate.name !== MISSION_SESSION_TAG
  );
  return nextTags.length > 0 ? nextTags : undefined;
}

export function getMissionSessionTagMetadata(
  tags: SessionTag[] | undefined
): MissionSessionTagMetadata | null {
  const tag = tags?.find((candidate) => candidate.name === MISSION_SESSION_TAG);
  if (!tag?.metadata) {
    return null;
  }

  const { role, missionId } = tag.metadata;
  if (
    role !== DecompSessionType.Orchestrator &&
    role !== DecompSessionType.Worker
  ) {
    return null;
  }
  if (typeof missionId !== 'string' || missionId.length === 0) {
    return null;
  }

  return { role, missionId };
}

export function isMissionOrchestratorSession(
  tags: SessionTag[] | undefined
): boolean {
  const metadata = getMissionSessionTagMetadata(tags);
  return metadata?.role === DecompSessionType.Orchestrator;
}

export function isMissionWorkerSession(
  tags: SessionTag[] | undefined
): boolean {
  const metadata = getMissionSessionTagMetadata(tags);
  return metadata?.role === DecompSessionType.Worker;
}

export function getDecompSessionTypeFromTags(
  tags: SessionTag[] | undefined
): DecompSessionType | undefined {
  const missionTagMetadata = getMissionSessionTagMetadata(tags);
  if (missionTagMetadata) {
    return missionTagMetadata.role;
  }

  const squadTagMetadata = getSquadSessionTagMetadata(tags);
  if (squadTagMetadata?.role === SquadRole.Orchestrator) {
    return DecompSessionType.Orchestrator;
  }
  if (squadTagMetadata?.role === SquadRole.Worker) {
    return DecompSessionType.Worker;
  }

  return undefined;
}
