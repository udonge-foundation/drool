import { ConnectionState, SessionLoadState } from '@industry/common/daemon';
import {
  MISSION_SESSION_TAG,
  SESSION_TAG_AUTOMATION,
  SESSION_TAG_MISSION_ORCHESTRATOR,
  SESSION_TAG_MISSION_WORKER,
  SESSION_TAG_SUBAGENT,
} from '@industry/common/session';
import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';

import { sanitizeStringToWellFormed } from '../text/unicode';

import type { AutomationTemplateId } from '@industry/common/automations';
import type { DroolSessionEvent } from '@industry/common/session';
import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';

export { getPermissionToolInputForDisplay } from './permissionToolInput';

/** Returns whether the session tags identify a Task-spawned subagent session. */
export function hasSubagentSessionTag(
  tags: readonly Pick<SessionTag, 'name'>[] | undefined
): boolean {
  return tags?.some((tag) => tag.name === SESSION_TAG_SUBAGENT) ?? false;
}

/** Returns whether the session tags identify an automation (scheduled/QA) session. */
export function hasAutomationSessionTag(
  tags: readonly Pick<SessionTag, 'name'>[] | undefined
): boolean {
  return tags?.some((tag) => tag.name === SESSION_TAG_AUTOMATION) ?? false;
}

/**
 * Resolves the title of the subagent a pending permission belongs to, or
 * undefined for a main-session permission. Pure and browser-safe so both the
 * CLI and the frontend can share a single source of truth.
 */
export function resolveSubagentSessionTitle(params: {
  permissionSessionId: string | undefined;
  associatedSessionIds: readonly string[] | undefined;
  mainSessionId: string | null;
  getTitleForSession: (sessionId: string) => string | undefined;
  getActiveForegroundChildSessionId?: (
    parentSessionId: string
  ) => string | undefined;
}): string | undefined {
  const {
    permissionSessionId,
    associatedSessionIds,
    mainSessionId,
    getTitleForSession,
    getActiveForegroundChildSessionId,
  } = params;

  if (permissionSessionId && permissionSessionId !== mainSessionId) {
    const title = getTitleForSession(permissionSessionId);
    if (title) return title;
  }

  const associatedSubagentId = associatedSessionIds?.find(
    (id) => id !== permissionSessionId && id !== mainSessionId
  );
  if (associatedSubagentId) {
    const title = getTitleForSession(associatedSubagentId);
    if (title) return title;
  }

  const parentSessionId = permissionSessionId ?? mainSessionId ?? undefined;
  if (parentSessionId && getActiveForegroundChildSessionId) {
    const childSessionId = getActiveForegroundChildSessionId(parentSessionId);
    if (childSessionId) return getTitleForSession(childSessionId);
  }

  return undefined;
}

function formatSubagentTypeForTitle(subagentType: string): string {
  if (!subagentType) return 'Subagent';
  return `${subagentType.charAt(0).toUpperCase()}${subagentType.slice(1)}`;
}

/**
 * Builds the canonical display title for a Task-spawned subagent session.
 * Use for UI/session labels derived from Task metadata rather than store state.
 */
export function buildSubagentSessionTitle({
  subagentType,
  taskTitle,
}: {
  subagentType: string;
  taskTitle: string | undefined;
}): string {
  const formattedSubagentType = formatSubagentTypeForTitle(subagentType);
  return taskTitle
    ? `${formattedSubagentType}: ${taskTitle}`
    : formattedSubagentType;
}

/**
 * Checks if the connection/session is in a loading state.
 * Used for determining loading UI states across components.
 */
export function isLoadingState(
  connectionState: ConnectionState,
  sessionLoadState: SessionLoadState
): boolean {
  return (
    connectionState === ConnectionState.Connecting ||
    connectionState === ConnectionState.LookingUpMachine ||
    connectionState === ConnectionState.StartingMachine ||
    connectionState === ConnectionState.LoadingSession ||
    sessionLoadState === SessionLoadState.Loading
  );
}

// Firestore has a 1MB limit per property value; 500 chars is a safe cap for titles.
const MAX_SESSION_TITLE_LENGTH = 500;

/**
 * Returns a title safe to write to Firestore: capped to MAX_SESSION_TITLE_LENGTH
 * and free of unpaired surrogates (which .slice on UTF-16 code units can produce
 * and which Firestore rejects with INVALID_ARGUMENT).
 */
export function sanitizeSessionTitle(title: string): string {
  return sanitizeStringToWellFormed(title.slice(0, MAX_SESSION_TITLE_LENGTH));
}

const MISSION_SESSION_TAG_NAMES = new Set([
  MISSION_SESSION_TAG,
  SESSION_TAG_MISSION_ORCHESTRATOR,
  SESSION_TAG_MISSION_WORKER,
]);

export function isMissionSessionTag(tag: Pick<SessionTag, 'name'>): boolean {
  return MISSION_SESSION_TAG_NAMES.has(tag.name);
}

export function withAutomationTemplateMetadata(
  tags: SessionTag[] | undefined,
  templateId: AutomationTemplateId | undefined
): SessionTag[] {
  if (!templateId) {
    return tags ?? [];
  }
  return (tags ?? []).map((tag) => {
    if (tag.name !== SESSION_TAG_AUTOMATION) {
      return tag;
    }
    return {
      ...tag,
      metadata: {
        ...tag.metadata,
        templateId,
      },
    };
  });
}

type AutomationSessionType = 'create' | 'run' | 'improve' | 'unknown';

interface AutomationSessionInfo {
  automationId: string;
  /**
   * Stable automation UUID (the synced `config.id`). Preferred for navigation
   * since backend/owned/shared automation cards are keyed by UUID, while the
   * local daemon id (`automationId`) is the on-disk directory slug.
   */
  automationUuid?: string;
  automationName?: string;
  type: AutomationSessionType;
}

function toAutomationSessionType(value: unknown): AutomationSessionType {
  if (value === 'create' || value === 'run' || value === 'improve') {
    return value;
  }
  return 'unknown';
}

/**
 * Returns automation linkage info for a session whose tags include the
 * `automation` tag (set on automation creation, run, and improve sessions).
 * Returns undefined when no usable automation tag is present.
 */
export function getAutomationSessionInfo(
  tags: SessionTag[] | undefined
): AutomationSessionInfo | undefined {
  const automationTag = tags?.find(
    (tag) => tag.name === SESSION_TAG_AUTOMATION
  );
  if (!automationTag) return undefined;
  const automationId = automationTag.metadata?.automationId;
  if (typeof automationId !== 'string' || automationId.length === 0) {
    return undefined;
  }
  const automationName = automationTag.metadata?.automationName;
  const automationUuid = automationTag.metadata?.automationUuid;
  return {
    automationId,
    ...(typeof automationUuid === 'string' && automationUuid.length > 0
      ? { automationUuid }
      : {}),
    ...(typeof automationName === 'string' && automationName.length > 0
      ? { automationName }
      : {}),
    type: toAutomationSessionType(automationTag.metadata?.type),
  };
}

export function getSubagentCallingMetadata(tags: SessionTag[] | undefined): {
  callingSessionId?: string;
  callingToolUseId?: string;
} {
  const metadata = tags?.find(
    (tag) => tag.name === SESSION_TAG_SUBAGENT
  )?.metadata;

  return {
    callingSessionId: metadata?.callingSessionId,
    callingToolUseId: metadata?.callingToolUseId,
  };
}

function toDecompSessionType(role: unknown): DecompSessionType | undefined {
  if (role === DecompSessionType.Orchestrator) {
    return DecompSessionType.Orchestrator;
  }
  if (role === DecompSessionType.Worker) {
    return DecompSessionType.Worker;
  }
  return undefined;
}

export function getMissionSessionRoleFromTags(
  tags: SessionTag[] | undefined
): DecompSessionType | undefined {
  const missionTag = tags?.find((tag) => tag.name === MISSION_SESSION_TAG);
  const missionTagRole = toDecompSessionType(missionTag?.metadata?.role);
  const missionTagMissionId = missionTag?.metadata?.missionId;

  if (
    missionTagRole &&
    typeof missionTagMissionId === 'string' &&
    missionTagMissionId.length > 0
  ) {
    return missionTagRole;
  }

  const legacyOrchestratorTag = tags?.find(
    (tag) => tag.name === SESSION_TAG_MISSION_ORCHESTRATOR
  );
  const legacyWorkerTag = tags?.find(
    (tag) => tag.name === SESSION_TAG_MISSION_WORKER
  );
  const legacyMissionId =
    legacyOrchestratorTag?.metadata?.missionId ??
    legacyWorkerTag?.metadata?.missionId;

  if (typeof legacyMissionId !== 'string' || legacyMissionId.length === 0) {
    return undefined;
  }

  if (legacyOrchestratorTag) {
    return DecompSessionType.Orchestrator;
  }

  if (legacyWorkerTag) {
    return DecompSessionType.Worker;
  }

  return undefined;
}

export function isMissionSessionMetadata({
  decompSessionType,
  tags,
}: {
  decompSessionType?: DecompSessionType;
  tags?: SessionTag[];
}): boolean {
  return Boolean(decompSessionType ?? getMissionSessionRoleFromTags(tags));
}

export function upsertMissionSessionTag(
  tags: SessionTag[] | undefined,
  sessionId: string
): SessionTag[] {
  const remainingTags = tags?.filter((tag) => !isMissionSessionTag(tag));
  return [
    ...(remainingTags ?? []),
    {
      name: MISSION_SESSION_TAG,
      metadata: {
        role: DecompSessionType.Orchestrator,
        missionId: sessionId,
      },
    },
  ];
}

export function removeMissionSessionTag(
  tags: SessionTag[] | undefined
): SessionTag[] {
  return tags?.filter((tag) => !isMissionSessionTag(tag)) ?? [];
}

type MaybePromise<T> = T | Promise<T>;

export async function isMissionSessionOrDescendant<TSession>({
  session,
  getSessionId,
  getCallingSessionId,
  getParentSession,
  isDirectMissionSession,
}: {
  session: TSession;
  getSessionId: (candidate: TSession) => string;
  getCallingSessionId: (candidate: TSession) => string | null | undefined;
  getParentSession: (
    sessionId: string
  ) => MaybePromise<TSession | null | undefined>;
  isDirectMissionSession: (candidate: TSession) => MaybePromise<boolean>;
}): Promise<boolean> {
  const visitedSessionIds = new Set<string>();
  let currentSession: TSession | null | undefined = session;

  while (currentSession) {
    const sessionId = getSessionId(currentSession);
    if (visitedSessionIds.has(sessionId)) {
      return false;
    }
    visitedSessionIds.add(sessionId);

    if (await isDirectMissionSession(currentSession)) {
      return true;
    }

    const callingSessionId = getCallingSessionId(currentSession);
    if (!callingSessionId) {
      return false;
    }

    currentSession = await getParentSession(callingSessionId);
  }

  return false;
}

export { MALFORMED_JSONL_LINE_WARNING } from './constants';

export function parseSessionJsonlLine(line: string): {
  event: DroolSessionEvent | null;
  error: Error | null;
} {
  try {
    const event: unknown = JSON.parse(line);
    return { event: event as DroolSessionEvent, error: null };
  } catch (error) {
    logWarn('Failed to parse session JSONL line', { cause: error });
    return {
      event: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export {
  areToolStreamingUpdatesEqual,
  buildSessionToolProgressUpdates,
  buildTaskToolProgressEntries,
  formatToolProgressDetails,
  getLatestStatusUpdateWithText,
  getLatestSessionAssistantText,
  getStreamingOutputText,
  isToolExecutionInProgress,
} from './toolStreaming';
