import { SQUAD_SESSION_TAG } from '@/services/squad/constants';
import { SquadRole } from '@/services/squad/enums';
import type { SquadSessionTagMetadata } from '@/services/squad/types';

import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';

export function buildSquadSessionTag(
  metadata: SquadSessionTagMetadata
): SessionTag {
  return {
    name: SQUAD_SESSION_TAG,
    metadata: { ...metadata },
  };
}

export function getSquadSessionTagMetadata(
  tags: SessionTag[] | undefined
): SquadSessionTagMetadata | null {
  const tag = tags?.find((candidate) => candidate.name === SQUAD_SESSION_TAG);
  if (!tag?.metadata) {
    return null;
  }

  const { squadId, agentId, role, agentName } = tag.metadata;
  if (!squadId || !agentId || !agentName) {
    return null;
  }

  if (role !== SquadRole.Orchestrator && role !== SquadRole.Worker) {
    return null;
  }

  return {
    squadId,
    agentId,
    role,
    agentName,
  };
}

export function isSquadSession(tags: SessionTag[] | undefined): boolean {
  return getSquadSessionTagMetadata(tags) !== null;
}
