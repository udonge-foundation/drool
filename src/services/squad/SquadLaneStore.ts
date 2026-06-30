import { SQUAD_GENERAL_CHANNEL } from '@/services/squad/constants';
import { postSquadChannelMessage } from '@/services/squad/SquadBoardStore';
import {
  getSquadLanesPath,
  squadOperationQueues,
  withSerializedOperation,
} from '@/services/squad/SquadStateService';
import type { SquadLane } from '@/services/squad/types';
import {
  loadJsonFileWithBackup,
  saveJsonFileAtomic,
} from '@/utils/jsonFileStore';
import { generateUUID } from '@/utils/uuid';

function isSquadLaneArray(data: unknown): data is SquadLane[] {
  return (
    Array.isArray(data) &&
    data.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'id' in item &&
        typeof item.id === 'string'
    )
  );
}

function readLanes(squadId: string): SquadLane[] {
  const lanesPath = getSquadLanesPath(squadId);
  return loadJsonFileWithBackup<SquadLane[]>(
    lanesPath,
    `${lanesPath}.bak`,
    isSquadLaneArray,
    () => []
  );
}

function writeLanes(squadId: string, lanes: SquadLane[]): void {
  const lanesPath = getSquadLanesPath(squadId);
  saveJsonFileAtomic(lanesPath, `${lanesPath}.bak`, lanes);
}

function formatLane(lane: SquadLane): string {
  const status = lane.claimedBy ? `claimed by ${lane.claimedBy}` : 'unclaimed';
  return `[${lane.id}] ${lane.description} (${status})`;
}

export async function createSquadLane(params: {
  squadId: string;
  callerAgentId: string;
  description: string;
}): Promise<string> {
  const lane = await withSerializedOperation(
    squadOperationQueues,
    params.squadId,
    async () => {
      const lanes = readLanes(params.squadId);
      const newLane: SquadLane = {
        id: `lane-${generateUUID().slice(0, 8)}`,
        description: params.description,
        createdBy: params.callerAgentId,
        createdAt: new Date().toISOString(),
        claimedBy: null,
        claimedAt: null,
      };
      lanes.push(newLane);
      writeLanes(params.squadId, lanes);
      return newLane;
    }
  );

  await postSquadChannelMessage({
    squadId: params.squadId,
    callerAgentId: params.callerAgentId,
    channelName: SQUAD_GENERAL_CHANNEL,
    content: `Created lane: ${lane.description} [${lane.id}]`,
  });

  return `Created lane ${lane.id}: ${lane.description}`;
}

export async function claimSquadLane(params: {
  squadId: string;
  callerAgentId: string;
  laneId: string;
}): Promise<string> {
  const result = await withSerializedOperation(
    squadOperationQueues,
    params.squadId,
    async (): Promise<
      { ok: true; id: string; description: string } | { ok: false; msg: string }
    > => {
      const lanes = readLanes(params.squadId);
      const lane = lanes.find((l) => l.id === params.laneId);

      if (!lane) {
        return { ok: false, msg: `Lane ${params.laneId} was not found.` };
      }

      if (lane.claimedBy) {
        return {
          ok: false,
          msg: `Lane ${params.laneId} is already claimed by ${lane.claimedBy}.`,
        };
      }

      lane.claimedBy = params.callerAgentId;
      lane.claimedAt = new Date().toISOString();
      writeLanes(params.squadId, lanes);
      return { ok: true, id: lane.id, description: lane.description };
    }
  );

  if (!result.ok) {
    return result.msg;
  }

  await postSquadChannelMessage({
    squadId: params.squadId,
    callerAgentId: params.callerAgentId,
    channelName: SQUAD_GENERAL_CHANNEL,
    content: `Claimed lane: ${result.description} [${result.id}]`,
  });

  return `Claimed lane ${result.id}: ${result.description}`;
}

export async function listSquadLanes(squadId: string): Promise<string> {
  const lanes = readLanes(squadId);
  if (lanes.length === 0) {
    return 'No lanes exist yet.';
  }
  return lanes.map(formatLane).join('\n');
}
