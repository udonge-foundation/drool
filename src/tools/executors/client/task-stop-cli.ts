import { ToolExecutionErrorType } from '@industry/common/session';
import { TaskStopParams } from '@industry/drool-core/tools/definitions/cli/taskStopCli';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { AgentTurnCompletionReason } from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';

import { BackgroundTaskStatus } from '@/hooks/enums';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';
import {
  forgetSessionBackedTaskStartTime,
  getSessionBackedTaskFromState,
} from '@/utils/sessionBackedTaskState';

export class TaskStopCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    _dependencies: CliClientToolDependencies,
    parameters: TaskStopParams
  ): AsyncGenerator<DraftToolFeedback<string>> {
    const { task_id: taskId } = parameters;

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

    const adapter = getTuiDaemonAdapter();
    const sessionTask = getSessionBackedTaskFromState(
      adapter.getSessionStateManager(),
      taskId
    );
    if (!sessionTask) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `No task found with ID: ${taskId}. No session-backed tasks found.`,
        userError: `Task "${taskId}" not found`,
      };
      return;
    }

    if (sessionTask.status !== BackgroundTaskStatus.Running) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: `Task "${taskId}" is not running (status: ${sessionTask.status}). No action taken.`,
      };
      return;
    }

    try {
      await adapter.interruptSession(sessionTask.sessionId);
    } catch (error) {
      logWarn('[TaskStopCliExecutor] Failed to interrupt session task', {
        taskId,
        sessionId: sessionTask.sessionId,
        cause: error,
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Failed to stop task "${taskId}".`,
        userError: `Failed to stop task "${taskId}"`,
      };
      return;
    }

    adapter
      .getSessionStateManager()
      .getSessionManager?.(sessionTask.sessionId)
      ?.getStore()
      .setAgentTurnCompletionReason(AgentTurnCompletionReason.Cancelled);
    forgetSessionBackedTaskStartTime(sessionTask.sessionId);
    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: `Task "${taskId}" has been stopped successfully.`,
    };
  }
}
