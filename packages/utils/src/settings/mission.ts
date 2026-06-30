import type { MissionWorkerRole } from './types';

export function missionWorkerRoleModelKey<T extends MissionWorkerRole>(
  role: T
): `${T}Model` {
  return `${role}Model`;
}

export function missionWorkerRoleReasoningKey<T extends MissionWorkerRole>(
  role: T
): `${T}ReasoningEffort` {
  return `${role}ReasoningEffort`;
}
