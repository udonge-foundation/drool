import fs from 'fs/promises';
import path from 'path';

import { logWarn } from '@industry/logging';

import { SQUAD_GENERAL_CHANNEL } from '@/services/squad/constants';
import {
  SquadAgentStatus,
  SquadRole,
  SquadStatus,
} from '@/services/squad/enums';
import { getSquadsDir } from '@/services/squad/paths';
import type {
  SquadAgent,
  SquadRuntimeState,
  SquadState,
} from '@/services/squad/types';
import {
  loadJsonFileWithBackup,
  saveJsonFileAtomic,
} from '@/utils/jsonFileStore';
import { generateUUID } from '@/utils/uuid';

interface ActiveSquadRecord {
  squadId: string | null;
}

export const squadOperationQueues = new Map<string, Promise<void>>();

export async function withSerializedOperation<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const completion = next.then(
    () => undefined,
    () => undefined
  );

  queues.set(key, completion);
  void completion.finally(() => {
    if (queues.get(key) === completion) {
      queues.delete(key);
    }
  });

  return next;
}

function isSquadState(data: unknown): data is SquadState {
  return (
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    typeof (data as SquadState).id === 'string' &&
    'agents' in data &&
    Array.isArray((data as SquadState).agents)
  );
}

function isActiveSquadRecord(data: unknown): data is ActiveSquadRecord {
  return (
    typeof data === 'object' &&
    data !== null &&
    'squadId' in data &&
    (typeof (data as ActiveSquadRecord).squadId === 'string' ||
      (data as ActiveSquadRecord).squadId === null)
  );
}

function getActiveSquadPath(): string {
  return path.join(getSquadsDir(), 'active.json');
}

function getSquadDir(squadId: string): string {
  return path.join(getSquadsDir(), squadId);
}

export function getSquadStatePath(squadId: string): string {
  return path.join(getSquadDir(squadId), 'state.json');
}

export function getSquadChannelsDir(squadId: string): string {
  return path.join(getSquadDir(squadId), 'channels');
}

export function getSquadDmsDir(squadId: string): string {
  return path.join(getSquadDir(squadId), 'dms');
}

export function getSquadNotificationsDir(squadId: string): string {
  return path.join(getSquadDir(squadId), 'notifications');
}

export function getSquadLanesPath(squadId: string): string {
  return path.join(getSquadDir(squadId), 'lanes.json');
}

function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}

function readState(squadId: string): SquadState | null {
  const statePath = getSquadStatePath(squadId);
  return loadJsonFileWithBackup<SquadState | null>(
    statePath,
    backupPath(statePath),
    isSquadState,
    () => null
  );
}

function readActiveSquadRecord(): ActiveSquadRecord | null {
  const activePath = getActiveSquadPath();
  return loadJsonFileWithBackup<ActiveSquadRecord | null>(
    activePath,
    backupPath(activePath),
    isActiveSquadRecord,
    () => null
  );
}

function writeState(squadId: string, state: SquadState): void {
  const statePath = getSquadStatePath(squadId);
  saveJsonFileAtomic(statePath, backupPath(statePath), state, {
    throwOnError: true,
  });
}

function writeActiveSquadRecord(record: ActiveSquadRecord): void {
  const activePath = getActiveSquadPath();
  saveJsonFileAtomic(activePath, backupPath(activePath), record, {
    throwOnError: true,
  });
}

async function ensureSquadDirs(squadId: string): Promise<void> {
  await fs.mkdir(getSquadChannelsDir(squadId), { recursive: true });
  await fs.mkdir(getSquadDmsDir(squadId), { recursive: true });
  await fs.mkdir(getSquadNotificationsDir(squadId), { recursive: true });
}

function buildDefaultRoster(): SquadAgent[] {
  return [
    {
      agentId: 'orchestrator',
      name: 'Orchestrator',
      role: SquadRole.Orchestrator,
      status: SquadAgentStatus.Pending,
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      agentId: `worker-${index + 1}`,
      name: `Worker ${index + 1}`,
      role: SquadRole.Worker,
      status: SquadAgentStatus.Pending,
    })),
  ];
}

async function ensureGeneralChannelExists(squadId: string): Promise<void> {
  const channelPath = path.join(
    getSquadChannelsDir(squadId),
    `${SQUAD_GENERAL_CHANNEL}.jsonl`
  );
  await fs.writeFile(channelPath, '', { flag: 'a' });
}

function saveSquadState(state: SquadState): void {
  writeState(state.id, state);
}

function buildNextRuntimeState(
  runtime: SquadRuntimeState | undefined,
  updates: SquadRuntimeState
): SquadRuntimeState | undefined {
  const nextRuntime: SquadRuntimeState = {
    ...runtime,
    ...updates,
  };

  if (!nextRuntime.wakeupOwnerPid && !nextRuntime.wakeupHeartbeatAt) {
    return undefined;
  }

  return nextRuntime;
}

function setActiveSquadId(squadId: string | null): void {
  writeActiveSquadRecord({ squadId });
}

export function getActiveSquadId(): string | null {
  return readActiveSquadRecord()?.squadId ?? null;
}

export function getSquadState(squadId: string): SquadState | null {
  return readState(squadId);
}

export function getActiveSquad(): SquadState | null {
  const activeSquadId = getActiveSquadId();
  if (!activeSquadId) {
    return null;
  }

  return getSquadState(activeSquadId);
}

export async function createSquad(params: {
  goal: string;
  cwd: string;
}): Promise<SquadState> {
  const squadId = `squad-${generateUUID().slice(0, 8)}`;
  const state: SquadState = {
    id: squadId,
    goal: params.goal,
    cwd: params.cwd,
    status: SquadStatus.Starting,
    createdAt: new Date().toISOString(),
    agents: buildDefaultRoster(),
  };

  await ensureSquadDirs(squadId);
  await ensureGeneralChannelExists(squadId);
  saveJsonFileAtomic(
    getSquadLanesPath(squadId),
    backupPath(getSquadLanesPath(squadId)),
    [],
    { throwOnError: true }
  );
  await Promise.all(
    state.agents.map((agent) =>
      fs.writeFile(
        path.join(getSquadNotificationsDir(squadId), `${agent.agentId}.jsonl`),
        '',
        { flag: 'a' }
      )
    )
  );
  saveSquadState(state);
  setActiveSquadId(state.id);
  return state;
}

export async function updateSquadStatus(
  squadId: string,
  status: SquadState['status']
): Promise<SquadState | null> {
  return withSerializedOperation(squadOperationQueues, squadId, async () => {
    const state = getSquadState(squadId);
    if (!state) {
      return null;
    }

    const nextState: SquadState = {
      ...state,
      status,
      ...(status === SquadStatus.Running && !state.startedAt
        ? { startedAt: new Date().toISOString() }
        : {}),
      ...(status === SquadStatus.Stopped
        ? { stoppedAt: new Date().toISOString() }
        : {}),
    };
    saveSquadState(nextState);
    return nextState;
  });
}

export async function assignAgentSession(params: {
  squadId: string;
  agentId: string;
  sessionId: string;
}): Promise<void> {
  await withSerializedOperation(
    squadOperationQueues,
    params.squadId,
    async () => {
      const state = getSquadState(params.squadId);
      if (!state) {
        return;
      }

      const nextState: SquadState = {
        ...state,
        agents: state.agents.map((agent) =>
          agent.agentId === params.agentId
            ? {
                ...agent,
                sessionId: params.sessionId,
                status: SquadAgentStatus.Running,
              }
            : agent
        ),
      };
      saveSquadState(nextState);
    }
  );
}

export async function recordAgentActivity(params: {
  squadId: string;
  agentId: string;
  timestamp?: string;
  introduced?: boolean;
}): Promise<void> {
  await withSerializedOperation(
    squadOperationQueues,
    params.squadId,
    async () => {
      const state = getSquadState(params.squadId);
      if (!state) {
        return;
      }

      const timestamp = params.timestamp ?? new Date().toISOString();
      const nextState: SquadState = {
        ...state,
        agents: state.agents.map((agent) => {
          if (agent.agentId !== params.agentId) {
            return agent;
          }

          return {
            ...agent,
            lastActivityAt: timestamp,
            ...(params.introduced && !agent.introducedAt
              ? { introducedAt: timestamp }
              : {}),
          };
        }),
      };

      saveSquadState(nextState);
    }
  );
}

export async function stopSquad(squadId: string): Promise<void> {
  await withSerializedOperation(squadOperationQueues, squadId, async () => {
    const state = getSquadState(squadId);
    if (!state) {
      return;
    }

    const nextState: SquadState = {
      ...state,
      status: SquadStatus.Stopped,
      stoppedAt: new Date().toISOString(),
      agents: state.agents.map((agent) => ({
        ...agent,
        status:
          agent.status === SquadAgentStatus.Error
            ? SquadAgentStatus.Error
            : SquadAgentStatus.Stopped,
      })),
    };
    saveSquadState(nextState);
  });
}

export async function prepareStoppedSquadForResume(
  squadId: string
): Promise<SquadState | null> {
  return withSerializedOperation(squadOperationQueues, squadId, async () => {
    const state = getSquadState(squadId);
    if (!state || state.status !== SquadStatus.Stopped) {
      return null;
    }

    const nextState: SquadState = {
      ...state,
      status: SquadStatus.Starting,
      startedAt: undefined,
      stoppedAt: undefined,
      runtime: undefined,
      agents: state.agents.map((agent) => ({
        ...agent,
        sessionId: undefined,
        status: SquadAgentStatus.Pending,
      })),
    };

    saveSquadState(nextState);
    setActiveSquadId(squadId);
    return nextState;
  });
}

export function clearActiveSquadIfStopped(): void {
  const active = getActiveSquad();
  if (!active || active.status !== SquadStatus.Stopped) {
    return;
  }

  setActiveSquadId(null);
}

export async function markAgentErrored(params: {
  squadId: string;
  agentId: string;
}): Promise<void> {
  await withSerializedOperation(
    squadOperationQueues,
    params.squadId,
    async () => {
      const state = getSquadState(params.squadId);
      if (!state) {
        logWarn(
          '[SquadStateService] Tried to mark missing squad agent as errored',
          {
            teamId: params.squadId,
            droolId: params.agentId,
          }
        );
        return;
      }

      const nextState: SquadState = {
        ...state,
        agents: state.agents.map((agent) =>
          agent.agentId === params.agentId
            ? { ...agent, status: SquadAgentStatus.Error }
            : agent
        ),
      };
      saveSquadState(nextState);
    }
  );
}

export async function recordSquadWakeupHeartbeat(params: {
  squadId: string;
  ownerPid: number;
  heartbeatAt?: string;
}): Promise<void> {
  await withSerializedOperation(
    squadOperationQueues,
    params.squadId,
    async () => {
      const state = getSquadState(params.squadId);
      if (!state) {
        return;
      }

      const nextState: SquadState = {
        ...state,
        runtime: buildNextRuntimeState(state.runtime, {
          wakeupOwnerPid: params.ownerPid,
          wakeupHeartbeatAt: params.heartbeatAt ?? new Date().toISOString(),
        }),
      };

      saveSquadState(nextState);
    }
  );
}

export async function clearSquadWakeupHeartbeat(params: {
  squadId: string;
  ownerPid?: number;
}): Promise<void> {
  await withSerializedOperation(
    squadOperationQueues,
    params.squadId,
    async () => {
      const state = getSquadState(params.squadId);
      if (!state?.runtime) {
        return;
      }

      if (
        params.ownerPid !== undefined &&
        state.runtime.wakeupOwnerPid !== params.ownerPid
      ) {
        return;
      }

      const nextState: SquadState = {
        ...state,
        runtime: buildNextRuntimeState(state.runtime, {
          wakeupOwnerPid: undefined,
          wakeupHeartbeatAt: undefined,
        }),
      };

      saveSquadState(nextState);
    }
  );
}
