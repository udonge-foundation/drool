import {
  AgentTurnCompletionReason,
  DroolWorkingState,
  SessionNotificationType,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import { BackgroundTaskStatus } from '@/hooks/enums';
import type { SessionBackedTask } from '@/services/types';
import {
  readSessionFinalTextFromState,
  readSessionProgressFromState,
} from '@/utils/sessionStateProgress';

import type { DaemonSessionNotificationParams } from '@industry/common/daemon';
import type {
  MultiSessionStateManager,
  SessionStateManager,
} from '@industry/daemon-client/session';

const sessionBackedTaskStartTimes = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Cache a session-backed Task's launch time for elapsed-time displays. */
export function rememberSessionBackedTaskStartTime({
  taskId,
  startTime,
}: {
  taskId: string;
  startTime: number;
}): void {
  sessionBackedTaskStartTimes.set(taskId, startTime);
}

/** Drop a cached start time once the Task's session is released. */
export function forgetSessionBackedTaskStartTime(taskId: string): void {
  sessionBackedTaskStartTimes.delete(taskId);
}

function getSessionStartTime(
  manager: SessionStateManager,
  taskId: string
): number {
  const cachedStartTime = sessionBackedTaskStartTimes.get(taskId);
  const messages = manager.getMessages();
  const messageStartTime = messages[0]?.createdAt;
  const startTime = cachedStartTime ?? messageStartTime ?? Date.now();
  sessionBackedTaskStartTimes.set(taskId, startTime);
  return startTime;
}

/**
 * Map an agent-turn completion reason to the Task status shown for a
 * session-backed Task. Use this (not ad-hoc reason checks) wherever a child's
 * terminal state is surfaced as a Task status; a child without a completion
 * reason is still Running and should not reach this mapping.
 */
export function getSessionBackedTaskStatusFromReason(
  completionReason: AgentTurnCompletionReason
): BackgroundTaskStatus {
  switch (completionReason) {
    case AgentTurnCompletionReason.Cancelled:
    case AgentTurnCompletionReason.ProcessExit:
      return BackgroundTaskStatus.Stopped;
    case AgentTurnCompletionReason.Error:
    case AgentTurnCompletionReason.PermissionRejected:
      return BackgroundTaskStatus.Error;
    case AgentTurnCompletionReason.Completed:
    case AgentTurnCompletionReason.SpecHandoff:
      return BackgroundTaskStatus.Completed;
    default:
      return BackgroundTaskStatus.Error;
  }
}

function getTaskStatus(manager: SessionStateManager): BackgroundTaskStatus {
  const completionReason = manager.getStore().getAgentTurnCompletionReason?.();
  return completionReason
    ? getSessionBackedTaskStatusFromReason(completionReason)
    : BackgroundTaskStatus.Running;
}

function getTaskMetadataFromTitle(title: string | null): {
  subagentType?: string;
  description?: string;
} {
  if (!title) {
    return {};
  }
  const separatorIndex = title.indexOf(': ');
  if (separatorIndex === -1) {
    return { subagentType: title };
  }
  return {
    subagentType: title.slice(0, separatorIndex),
    description: title.slice(separatorIndex + 2),
  };
}

function getTaskTitlePrefix(title: string | undefined): string {
  const normalizedTitle = Array.from(title ?? '', (char) => {
    const codePoint = char.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      ? ' '
      : char;
  })
    .join('')
    .trim();

  return normalizedTitle ? `[${normalizedTitle.slice(0, 200)}] ` : '';
}

/**
 * Whether a child Task session was launched with `run_in_background: true`,
 * derived from the parent's recorded Task tool use.
 */
export function isSessionBackedTaskBackground({
  sessionStateManager,
  taskId,
}: {
  sessionStateManager: MultiSessionStateManager | null | undefined;
  taskId: string;
}): boolean {
  const taskManager = sessionStateManager?.getSessionManager(taskId);
  if (!taskManager) return false;

  const store = taskManager.getStore() as {
    getCallingSessionId?: () => string | null | undefined;
    getCallingToolUseId?: () => string | null | undefined;
  };
  if (
    typeof store.getCallingSessionId !== 'function' ||
    typeof store.getCallingToolUseId !== 'function'
  ) {
    return false;
  }
  const parentSessionId = store.getCallingSessionId();
  const toolCallId = store.getCallingToolUseId();
  if (!parentSessionId || !toolCallId) return false;

  const parentManager = sessionStateManager?.getSessionManager(parentSessionId);
  if (!parentManager) return false;

  for (const message of parentManager.getMessages()) {
    if (message.role !== MessageRole.Assistant) continue;
    for (const block of message.content) {
      if (
        block.type !== MessageContentBlockType.ToolUse ||
        block.id !== toolCallId ||
        block.name !== 'Task'
      ) {
        continue;
      }
      return isRecord(block.input) && block.input.run_in_background === true;
    }
  }

  return false;
}

/** Read normalized progress updates from a session-backed Task. */
export function readSessionBackedTaskProgress({
  sessionStateManager,
  taskId,
}: {
  sessionStateManager: MultiSessionStateManager | null | undefined;
  taskId: string;
}): ToolStreamingUpdate[] {
  const progress =
    readSessionProgressFromState({
      sessionId: taskId,
      sessionStateManager,
    }) ?? [];
  return progress.map((update) => ({
    ...update,
    subagentSessionId: update.subagentSessionId ?? taskId,
  }));
}

/** Build a TaskOutput-compatible task view from daemon session state. */
export function getSessionBackedTaskFromState(
  sessionStateManager: MultiSessionStateManager | null | undefined,
  taskId: string
): SessionBackedTask | undefined {
  const manager = sessionStateManager?.getSessionManager(taskId);
  if (!manager) return undefined;

  const store = manager.getStore();
  if (store.getDecompSessionType()) {
    return undefined;
  }
  const parentSessionId = store.getCallingSessionId();
  const toolCallId = store.getCallingToolUseId();
  const title = store.getTitle?.() ?? undefined;
  const metadata = getTaskMetadataFromTitle(title ?? null);

  return {
    taskId,
    sessionId: taskId,
    parentSessionId: parentSessionId ?? '',
    toolCallId: toolCallId ?? '',
    cwd: store.getCwd() ?? undefined,
    status: getTaskStatus(manager),
    completionReason: store.getAgentTurnCompletionReason?.() ?? undefined,
    title,
    subagentType: metadata.subagentType,
    description: metadata.description,
    startTime: getSessionStartTime(manager, taskId),
    progressUpdates: readSessionBackedTaskProgress({
      sessionStateManager,
      taskId,
    }),
  };
}

/**
 * Names of the tool calls whose latest results are errors, read from the most
 * recent tool-result message of a session-backed Task. Used to explain a
 * PermissionRejected turn (the rejected tools carry an error tool result).
 */
export function readSessionBackedTaskRejectedToolNames({
  sessionStateManager,
  taskId,
}: {
  sessionStateManager: MultiSessionStateManager | null | undefined;
  taskId: string;
}): string[] {
  const manager = sessionStateManager?.getSessionManager(taskId);
  if (!manager) return [];

  const messages = manager.getMessages();
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== MessageRole.Assistant) continue;
    for (const block of message.content) {
      if (block.type === MessageContentBlockType.ToolUse) {
        toolNameById.set(block.id, block.name);
      }
    }
  }

  const lastToolMessage = [...messages]
    .reverse()
    .find((message) => message.role === MessageRole.Tool);
  if (!lastToolMessage) return [];

  const names: string[] = [];
  for (const block of lastToolMessage.content) {
    if (block.type !== MessageContentBlockType.ToolResult || !block.isError) {
      continue;
    }
    names.push(toolNameById.get(block.toolUseId) ?? block.toolUseId);
  }
  return Array.from(new Set(names));
}

/** List all session-backed Tasks known to the session state manager. */
export function getSessionBackedTasksFromState(
  sessionStateManager: MultiSessionStateManager | null | undefined,
  parentSessionId?: string
): SessionBackedTask[] {
  const sessionIds = sessionStateManager?.getAllSessionIds() ?? [];
  return sessionIds
    .map((sessionId) =>
      getSessionBackedTaskFromState(sessionStateManager, sessionId)
    )
    .filter((task): task is SessionBackedTask => {
      if (!task) return false;
      if (!task.parentSessionId) return false;
      return parentSessionId ? task.parentSessionId === parentSessionId : true;
    });
}

/** List running session-backed Tasks, optionally scoped to a parent session. */
export function getRunningSessionBackedTasksFromState(
  sessionStateManager: MultiSessionStateManager | null | undefined,
  parentSessionId?: string
): SessionBackedTask[] {
  return getSessionBackedTasksFromState(
    sessionStateManager,
    parentSessionId
  ).filter((task) => task.status === BackgroundTaskStatus.Running);
}

/** Read the latest assistant response from a session-backed Task. */
export function readSessionBackedTaskFinalOutput({
  sessionStateManager,
  taskId,
}: {
  sessionStateManager: MultiSessionStateManager | null | undefined;
  taskId: string;
}): string {
  return readSessionFinalTextFromState({
    sessionId: taskId,
    sessionStateManager,
  });
}

export function buildCompletedSessionBackedTask({
  sessionStateManager,
  taskId,
  reason,
  fallback,
}: {
  sessionStateManager: MultiSessionStateManager | null | undefined;
  taskId: string;
  reason: AgentTurnCompletionReason | undefined;
  fallback?: Partial<SessionBackedTask>;
}): SessionBackedTask | undefined {
  const stateTask = getSessionBackedTaskFromState(sessionStateManager, taskId);
  const baseTask = stateTask ?? fallback;
  if (!baseTask?.parentSessionId || !baseTask.toolCallId) {
    return undefined;
  }

  return {
    taskId,
    sessionId: taskId,
    parentSessionId: baseTask.parentSessionId,
    toolCallId: baseTask.toolCallId,
    startTime: baseTask.startTime ?? Date.now(),
    endTime: Date.now(),
    status: getSessionBackedTaskStatusFromReason(
      reason ?? AgentTurnCompletionReason.Completed
    ),
    title: baseTask.title,
    description: baseTask.description,
    subagentType: baseTask.subagentType,
    cwd: stateTask?.cwd ?? fallback?.cwd,
    progressUpdates:
      stateTask?.progressUpdates ?? fallback?.progressUpdates ?? [],
    finalOutput: readSessionBackedTaskFinalOutput({
      sessionStateManager,
      taskId,
    }),
  };
}

/**
 * Build the LLM-only completion prompt injected into the parent session when
 * a background Task finishes. Carries the task id so wake delivery can stay
 * idempotent.
 */
export function buildSessionBackedTaskCompletionPrompt(
  task: SessionBackedTask
): string {
  const output = task.finalOutput || 'No output available';
  const lines = [
    `${getTaskTitlePrefix(task.title)}Background task ${task.status}.`,
    `task_id: ${task.taskId}`,
    `type: ${task.subagentType ?? 'sub-agent'}`,
  ];

  if (task.description) {
    lines.push(`description: ${task.description}`);
  }

  lines.push(
    `output: ${output}`,
    '',
    `Background task "${task.description || task.subagentType || 'sub-agent'}" (${task.taskId}) just ${task.status}. Review the result above and take any follow-up action if needed.`
  );

  return lines.join('\n');
}

function isParentReadyForSessionBackedTaskCompletionInjection({
  sessionStateManager,
  parentSessionId,
  toolCallId,
}: {
  sessionStateManager: MultiSessionStateManager | null | undefined;
  parentSessionId: string;
  toolCallId: string;
}): boolean {
  const parentManager = sessionStateManager?.getSessionManager(parentSessionId);
  if (!parentManager) {
    return false;
  }
  if (parentManager.getDroolWorkingState() === DroolWorkingState.Idle) {
    return true;
  }

  const messages = parentManager.getMessages();
  const taskResultIndex = messages.findIndex((message) =>
    message.content.some(
      (block) =>
        block.type === MessageContentBlockType.ToolResult &&
        block.toolUseId === toolCallId
    )
  );
  if (taskResultIndex === -1) {
    return false;
  }

  return messages.slice(taskResultIndex + 1).some((message) => {
    if (message.role !== MessageRole.Assistant) {
      return false;
    }
    return message.content.every(
      (block) => block.type !== MessageContentBlockType.ToolUse
    );
  });
}

export function waitForParentReadyForSessionBackedTaskCompletionInjection({
  getSessionStateManager,
  parentSessionId,
  toolCallId,
  subscribeToSessionNotifications,
}: {
  getSessionStateManager: () => MultiSessionStateManager | null | undefined;
  parentSessionId: string;
  toolCallId: string;
  subscribeToSessionNotifications: (
    sessionId: string,
    handler: (
      notification: DaemonSessionNotificationParams['notification']
    ) => void
  ) => () => void;
}): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let readinessPoll: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (readinessPoll) {
        clearInterval(readinessPoll);
      }
      unsubscribe();
      resolve();
    };

    const isReady = () =>
      isParentReadyForSessionBackedTaskCompletionInjection({
        sessionStateManager: getSessionStateManager(),
        parentSessionId,
        toolCallId,
      });

    if (isReady()) {
      finish();
      return;
    }

    unsubscribe = subscribeToSessionNotifications(
      parentSessionId,
      (notification) => {
        if (
          notification.type === SessionNotificationType.AGENT_TURN_COMPLETED ||
          (notification.type ===
            SessionNotificationType.DROOL_WORKING_STATE_CHANGED &&
            notification.newState === DroolWorkingState.Idle)
        ) {
          finish();
        }
      }
    );

    readinessPoll = setInterval(() => {
      if (isReady()) {
        finish();
      }
    }, 500);
  });
}
