import { ToolExecutionErrorType } from '@industry/common/session';
import { TaskOutputParams } from '@industry/drool-core/tools/definitions/cli/taskOutputCli';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  AgentTurnCompletionReason,
  SessionNotificationType,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';

import { BackgroundTaskStatus } from '@/hooks/enums';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';
import {
  getSessionBackedTaskFromState,
  getSessionBackedTasksFromState,
  readSessionBackedTaskFinalOutput,
  readSessionBackedTaskProgress,
  readSessionBackedTaskRejectedToolNames,
} from '@/utils/sessionBackedTaskState';
import { readNewSessionStateProgressUpdates } from '@/utils/sessionStateProgress';

const MAX_TIMEOUT = 1200000;
const TASK_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildTaskOutputMetadataUpdate(task: {
  sessionId?: string;
  subagentType?: string;
  description?: string;
}): ToolStreamingUpdate | undefined {
  if (!task.subagentType && !task.description) {
    return undefined;
  }
  return {
    type: 'status',
    text: 'Reading task output',
    timestamp: Date.now(),
    ...(task.sessionId ? { subagentSessionId: task.sessionId } : {}),
    parameters: {
      ...(task.subagentType ? { subagent_type: task.subagentType } : {}),
      ...(task.description ? { description: task.description } : {}),
    },
  };
}

export class TaskOutputCliExecutor
  implements
    ClientToolExecutor<
      CliClientSpecificToolDependencies,
      string,
      ToolStreamingUpdate
    >
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: TaskOutputParams
  ): AsyncGenerator<DraftToolFeedback<string, ToolStreamingUpdate>> {
    const { task_id: taskId, block = true, timeout = 30000 } = parameters;

    if (!taskId || typeof taskId !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'task_id is required and must be a string',
        userError: 'Invalid task ID provided',
      };
      return;
    }

    const clampedTimeout = Math.min(Math.max(timeout, 0), MAX_TIMEOUT);

    const adapter = getTuiDaemonAdapter();
    const sessionStateManager = adapter.getSessionStateManager();
    const sessionTask = getSessionBackedTaskFromState(
      sessionStateManager,
      taskId
    );
    if (!sessionTask) {
      const availableIds = getSessionBackedTasksFromState(
        sessionStateManager
      ).map((availableTask) => availableTask.taskId);
      const hint =
        availableIds.length > 0
          ? ` Available task IDs: ${availableIds.join(', ')}`
          : ' No session-backed tasks found.';
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `No task found with ID: ${taskId}.${hint}`,
        userError: `Task "${taskId}" not found`,
      };
      return;
    }

    const metadataUpdate = buildTaskOutputMetadataUpdate(sessionTask);
    if (metadataUpdate) {
      yield {
        type: DraftToolFeedbackType.Update,
        value: metadataUpdate,
      };
    }

    if (block && sessionTask.status === BackgroundTaskStatus.Running) {
      const startTime = Date.now();
      const seenProgressKeys = new Set<string>();
      let unsubscribeCompletionListener: () => void = () => {};
      const completionPromise = new Promise<void>((resolve) => {
        unsubscribeCompletionListener = adapter.subscribeToSessionNotifications(
          taskId,
          (notification) => {
            if (
              notification.type ===
                SessionNotificationType.AGENT_TURN_COMPLETED ||
              notification.type === SessionNotificationType.ERROR
            ) {
              unsubscribeCompletionListener();
              resolve();
            }
          }
        );
      });
      try {
        while (Date.now() - startTime < clampedTimeout) {
          if (dependencies.abortSignal?.aborted) {
            yield {
              type: DraftToolFeedbackType.Result,
              isError: true,
              errorType: ToolExecutionErrorType.ToolInternalError,
              llmError: `Task output retrieval cancelled while waiting for task "${taskId}"`,
              userError: 'Task output retrieval cancelled',
            };
            return;
          }
          const current = getSessionBackedTaskFromState(
            sessionStateManager,
            taskId
          );
          if (!current || current.status !== BackgroundTaskStatus.Running) {
            break;
          }
          const progressUpdates =
            readNewSessionStateProgressUpdates({
              sessionId: taskId,
              sessionStateManager,
              seenProgressKeys,
            }) ?? [];
          for (const update of progressUpdates) {
            yield {
              type: DraftToolFeedbackType.Update,
              value: update,
            };
          }
          const waitResult = await Promise.race([
            completionPromise.then(() => 'completed' as const),
            sleep(TASK_POLL_INTERVAL_MS).then(() => 'poll' as const),
          ]);
          if (waitResult === 'completed') {
            break;
          }
        }
      } finally {
        unsubscribeCompletionListener();
      }
    }

    const finalTask =
      getSessionBackedTaskFromState(sessionStateManager, taskId) ?? sessionTask;
    if (finalTask.status !== BackgroundTaskStatus.Running) {
      getSessionService().applyChildInclusiveTokenUsageFromSession(
        finalTask.sessionId,
        finalTask.parentSessionId
      );
    }

    const durationMs = finalTask.endTime
      ? finalTask.endTime - finalTask.startTime
      : Date.now() - finalTask.startTime;

    const durationSec = (durationMs / 1000).toFixed(1);

    const parts: string[] = [
      `Task ID: ${finalTask.taskId}`,
      ...(finalTask.subagentType
        ? [`Subagent Type: ${finalTask.subagentType}`]
        : []),
      ...(finalTask.description
        ? [`Description: ${finalTask.description}`]
        : []),
      `Status: ${finalTask.status}`,
      `Duration: ${durationSec}s`,
    ];

    const finalOutput =
      finalTask.finalOutput ||
      readSessionBackedTaskFinalOutput({
        sessionStateManager,
        taskId,
      });
    const permissionRejected =
      finalTask.completionReason ===
      AgentTurnCompletionReason.PermissionRejected;

    if (finalOutput) {
      parts.push('', finalOutput);
    } else if (finalTask.status === BackgroundTaskStatus.Running) {
      const progress = readSessionBackedTaskProgress({
        sessionStateManager,
        taskId,
      });
      const latestProgress =
        progress[progress.length - 1]?.details ??
        progress[progress.length - 1]?.text;
      if (latestProgress) {
        parts.push('', `Latest progress: ${latestProgress}`);
      }
      parts.push(`Task is still running in session "${finalTask.sessionId}".`);
    } else if (permissionRejected) {
      const rejectedToolNames = readSessionBackedTaskRejectedToolNames({
        sessionStateManager,
        taskId,
      });
      const target =
        rejectedToolNames.length > 0
          ? `the ${rejectedToolNames.join(', ')} tool call(s)`
          : 'a required tool call';
      parts.push(
        '',
        `The user rejected the permission request for ${target}, so the task stopped before completing.`
      );
    } else {
      parts.push('No output available.');
    }

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: parts.join('\n'),
    };
  }
}
