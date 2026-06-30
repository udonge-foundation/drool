import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  DismissalRecordSchema,
  ProgressLogEntryType,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';

import { getMissionFileService } from '@/services/mission/MissionFileService';
import { getSessionService } from '@/services/SessionService';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type {
  DismissHandoffItemsParams,
  DismissHandoffItemsResult,
} from '@industry/drool-core/tools/definitions';

/**
 * Executor for the dismiss_handoff_items tool (orchestrator).
 *
 * Allows orchestrator to explicitly dismiss handoff items from a worker
 * that don't require action, with required justification.
 *
 * Effects:
 * - Records dismissals in progress_log.jsonl for audit trail
 */
export class DismissHandoffItemsExecutor
  implements
    ClientToolExecutor<
      CliClientSpecificToolDependencies,
      DismissHandoffItemsResult
    >
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: DismissHandoffItemsParams
  ): AsyncGenerator<DraftToolFeedback<DismissHandoffItemsResult>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { dismissals } = parameters;

    const sessionId = dependencies.sessionId;
    if (!sessionId) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'No session ID available',
        llmError: 'Cannot dismiss handoff items without a session ID',
      };
      return;
    }

    const missionSessionId =
      getSessionService().getDecompMissionId() ?? sessionId;
    const missionFileService = getMissionFileService(missionSessionId);

    const exists = await missionFileService.missionExists();
    if (!exists) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'Mission not found',
        llmError:
          'Mission directory does not exist. This tool is only available for orchestrator sessions with an active mission.',
      };
      return;
    }

    const state = await missionFileService.readState();
    if (!state) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: 'Mission state not found',
        llmError: 'Could not read mission state.json',
      };
      return;
    }

    try {
      // Parse LLM input using zod schema
      const dismissalRecords = dismissals.map((d) =>
        DismissalRecordSchema.parse(d)
      );

      await missionFileService.appendProgressLog({
        timestamp: new Date().toISOString(),
        type: ProgressLogEntryType.HandoffItemsDismissed,
        dismissals: dismissalRecords,
      });
      logInfo('[DismissHandoffItems] Dismissed handoff items', {
        count: dismissals.length,
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: {
          dismissed: true,
          count: dismissals.length,
          message: `Dismissed ${dismissals.length} item(s). You may now call start_mission_run to continue.`,
        },
      };
    } catch (error) {
      logInfo('[DismissHandoffItems] Failed to dismiss items', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError: `Failed to dismiss items: ${error instanceof Error ? error.message : String(error)}`,
        llmError: `Failed to dismiss items: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
