import { VALIDATION_SKILL_NAMES } from '@/skills/builtin/constants';
import {
  MissionFailureCategory,
  MissionFailureReasonCode,
} from '@/telemetry/customer/enums';

const VALIDATION_SKILL_NAME_SET = new Set(VALIDATION_SKILL_NAMES);

export function getMissionRoleFromSkillName(
  skillName?: string | null
): 'implementation_worker' | 'validation_worker' {
  if (skillName && VALIDATION_SKILL_NAME_SET.has(skillName)) {
    return 'validation_worker';
  }
  return 'implementation_worker';
}

/**
 * Specific bounded failure code used for drill-down and debugging.
 * This is more granular than failure category.
 */
export function getMissionFailureReasonCode(
  reason: string
): MissionFailureReasonCode {
  const normalized = reason.toLowerCase();

  if (normalized.includes('daemon_unreachable')) {
    return MissionFailureReasonCode.DAEMON_UNREACHABLE;
  }
  if (normalized.includes('timed out waiting for industryd')) {
    return MissionFailureReasonCode.DAEMON_RPC_TIMEOUT;
  }
  if (normalized.includes('industryd appears to be unavailable')) {
    return MissionFailureReasonCode.DAEMON_UNAVAILABLE_DURING_RUN;
  }
  if (normalized.includes('industryd is not reachable')) {
    return MissionFailureReasonCode.DAEMON_NOT_REACHABLE;
  }
  if (normalized.includes('spawn error')) {
    return MissionFailureReasonCode.WORKER_SPAWN_ERROR;
  }
  if (normalized.includes('load session error')) {
    return MissionFailureReasonCode.WORKER_LOAD_SESSION_ERROR;
  }
  if (normalized.includes('resume error')) {
    return MissionFailureReasonCode.WORKER_RESUME_ERROR;
  }
  if (normalized.includes('inactivity')) {
    return MissionFailureReasonCode.WORKER_INACTIVITY_TIMEOUT;
  }
  if (normalized.includes('process exited')) {
    return MissionFailureReasonCode.WORKER_PROCESS_EXIT;
  }
  if (normalized.includes('orphan_cleanup')) {
    return MissionFailureReasonCode.WORKER_ORPHAN_CLEANUP;
  }
  if (normalized.includes('killed by user')) {
    return MissionFailureReasonCode.WORKER_KILLED_BY_USER;
  }
  if (normalized.includes('missing missionid')) {
    return MissionFailureReasonCode.MISSING_MISSION_ID;
  }
  if (normalized.includes('worker interrupted')) {
    return MissionFailureReasonCode.WORKER_INTERRUPTED;
  }
  if (normalized.includes('timed out')) {
    return MissionFailureReasonCode.TIMEOUT;
  }

  return MissionFailureReasonCode.OTHER;
}

/**
 * High-level grouping used for dashboarding and alerting.
 * Multiple reason codes can map to the same category.
 */
export function getMissionFailureCategoryFromReasonCode(
  reasonCode: MissionFailureReasonCode
): MissionFailureCategory {
  switch (reasonCode) {
    case MissionFailureReasonCode.DAEMON_UNREACHABLE:
    case MissionFailureReasonCode.DAEMON_RPC_TIMEOUT:
    case MissionFailureReasonCode.DAEMON_UNAVAILABLE_DURING_RUN:
    case MissionFailureReasonCode.DAEMON_NOT_REACHABLE:
      return MissionFailureCategory.DAEMON_CONNECTIVITY;

    case MissionFailureReasonCode.WORKER_SPAWN_ERROR:
    case MissionFailureReasonCode.WORKER_PROCESS_EXIT:
      return MissionFailureCategory.WORKER_EXECUTION;

    case MissionFailureReasonCode.WORKER_LOAD_SESSION_ERROR:
    case MissionFailureReasonCode.WORKER_RESUME_ERROR:
    case MissionFailureReasonCode.WORKER_ORPHAN_CLEANUP:
      return MissionFailureCategory.WORKER_SESSION;

    case MissionFailureReasonCode.WORKER_KILLED_BY_USER:
    case MissionFailureReasonCode.WORKER_INTERRUPTED:
      return MissionFailureCategory.USER_ACTION;

    case MissionFailureReasonCode.MISSING_MISSION_ID:
      return MissionFailureCategory.MISSION_STATE;

    case MissionFailureReasonCode.WORKER_INACTIVITY_TIMEOUT:
    case MissionFailureReasonCode.TIMEOUT:
      return MissionFailureCategory.TIMEOUT;

    case MissionFailureReasonCode.OTHER:
    default:
      return MissionFailureCategory.OTHER;
  }
}
