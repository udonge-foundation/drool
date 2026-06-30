import * as path from 'path';

import { ToolExecutionErrorType } from '@industry/common/session';
import { CreateCliParams } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { logException, Metrics } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { SettingsManager } from '@industry/runtime/settings';

import {
  validateFileForCreate,
  writeFileContent,
} from '@/agent/file-edit/utils';
import { SKILL_CREATION_TITLE_MARKER } from '@/hooks/skill-creation/constants';
import { isMissionWorkerSession } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { getFileSnapshotService } from '@/services/snapshots/FileSnapshotService';
import { VSCodeIdeClient } from '@/services/VSCodeIdeClient';
import {
  fetchDiagnostics,
  formatDiagnosticsForSystemReminder,
} from '@/tools/executors/client/file-tools/diagnostics-utils';
import {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import { isPathInArtifactsDir } from '@/utils/artifactsProtection';
import {
  isMissionSystemFile,
  isMissionWorkerProtectedFile,
} from '@/utils/missionFileProtection';
import { validateMissionFileContent } from '@/utils/missionFileValidation';

/**
 * Check if a file path is a skill file (SKILL.md in a .industry or .industry-dev skills directory)
 */
function isSkillFile(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  // Match both .industry and .industry-dev, absolute and relative paths
  return /(^|[/\\])\.industry(-dev)?[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/i.test(
    normalized
  );
}

export class CreateCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: CreateCliParams
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { file_path: filePath, content } = parameters;

    if (!filePath || typeof filePath !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'file_path is required and must be a string',
        userError: 'Invalid file path provided',
      };
      return;
    }

    if (content === undefined || content === null) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'content is required',
        userError: 'Missing content parameter',
      };
      return;
    }

    // Prevent writes to artifacts directory
    if (isPathInArtifactsDir(filePath)) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          'Cannot write to artifacts directory. This directory is reserved for system-generated outputs.',
        userError: 'Cannot write to artifacts directory',
      };
      return;
    }

    // Prevent writes to mission system files.
    if (isMissionSystemFile(filePath)) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          'Cannot write to mission system files (state.json, progress_log.jsonl, model-settings.json). These files are managed by the system.',
        userError: 'Cannot write to mission system files',
      };
      return;
    }

    if (
      isMissionWorkerSession(getSessionService().getCurrentSessionTags?.()) &&
      isMissionWorkerProtectedFile(filePath)
    ) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          'Cannot write to features.json from a mission worker or validator session. features.json is managed by the orchestrator; report results with EndFeatureRun or return control to the orchestrator.',
        userError: 'Cannot write to features.json from a worker session',
      };
      return;
    }

    try {
      const createValidation = await validateFileForCreate(filePath);
      if (!createValidation.success) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError: createValidation.message,
          userError: createValidation.message,
        };
        return;
      }

      // If the target is a known on-disk mission artifact
      // (features.json / runtime-custom-models.json / handoffs/*.json / state.json),
      // enforce the mission artifact schema before persisting. Malformed
      // mission artifacts corrupt the scheduler (see issue #974), so we refuse
      // the write and return an actionable error for the LLM to self-correct.
      const missionValidation = validateMissionFileContent(filePath, content);
      if (!missionValidation.ok) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError:
            missionValidation.llmError ?? 'Mission artifact validation failed.',
          userError: 'Mission artifact validation failed',
        };
        return;
      }

      const writeResult = await writeFileContent({
        filePath,
        content,
        toolCallId: dependencies.toolCallId,
        ensureTrailingNewline: true,
      });

      if (!writeResult.success) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          llmError: writeResult.message,
          userError: 'Failed to write file',
        };
        return;
      }

      // Snapshot for rewind: on overwrite, stash the prior content so rewind
      // restores it; on fresh create, track the creation so rewind deletes it.
      void getFileSnapshotService()
        .captureToolFileChange({
          filePath,
          content: writeResult.wasNewFile ? '' : (writeResult.oldContent ?? ''),
          toolCallId: dependencies.toolCallId || 'unknown',
          operation: writeResult.wasNewFile ? 'create' : 'edit',
        })
        .catch(() => {
          // Fire-and-forget: silently ignore snapshot errors
        });

      // Auto-register skills and open in IDE when a SKILL.md file is created
      if (isSkillFile(filePath)) {
        const sessionTitle = getSessionService().getSessionTitle();
        if (sessionTitle?.includes(SKILL_CREATION_TITLE_MARKER)) {
          Metrics.addToCounter(Metric.SKILL_CREATE_SESSION_SUCCESS_COUNT, 1);
        }

        try {
          // Refresh settings cache so the new skill is picked up
          SettingsManager.getInstance().refresh();
        } catch (error) {
          logException(
            error,
            'Failed to refresh settings after skill creation'
          );
        }

        // Open the skill file in the IDE
        if (dependencies.ideClient?.isConnected()) {
          try {
            const absolutePath = path.isAbsolute(filePath)
              ? filePath
              : path.resolve(filePath);
            if (dependencies.ideClient instanceof VSCodeIdeClient) {
              await dependencies.ideClient.openFile(absolutePath, false);
            } else {
              await dependencies.ideClient.callTool('openFile', {
                filePath: absolutePath,
                waitForSave: false,
              });
            }
          } catch (error) {
            logException(error, 'Failed to open skill file in IDE');
          }
        }
      }

      // Fetch diagnostics after file creation if IDE is available
      // Use fetchDiagnostics with retry logic for new files
      const diagnosticsAfter = await fetchDiagnostics(
        dependencies.ideClient,
        filePath,
        1, // maxRetries
        500 // delayMs
      );

      // For newly created files, all diagnostics are new
      const newDiagnostics = diagnosticsAfter;

      // Format system reminder if there are new errors
      const systemReminder = formatDiagnosticsForSystemReminder(
        newDiagnostics,
        filePath
      );

      const resultPayload: {
        success: true;
        file_path: string;
        systemReminder?: string;
      } = {
        success: true,
        file_path: filePath,
      };

      if (systemReminder) {
        resultPayload.systemReminder = systemReminder;
      }

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: JSON.stringify(resultPayload),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Error writing file: ${errorMessage}`,
        userError: 'Failed to write file',
      };
    }
  }
}
