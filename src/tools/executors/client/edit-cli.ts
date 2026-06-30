import { ToolExecutionErrorType } from '@industry/common/session';
import { EditCliParams } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { ToolAbortError } from '@industry/logging/errors';

import { editFileWithDiff } from '@/agent/file-edit/edit';
import { isMissionWorkerSession } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { getFileSnapshotService } from '@/services/snapshots/FileSnapshotService';
import {
  compareDiagnostics,
  fetchDiagnostics,
  formatDiagnosticsForSystemReminder,
} from '@/tools/executors/client/file-tools/diagnostics-utils';
import {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import { isPathInArtifactsDir } from '@/utils/artifactsProtection';
import { generateUnifiedDiff } from '@/utils/diff-utils';
import {
  isMissionSystemFile,
  isMissionWorkerProtectedFile,
} from '@/utils/missionFileProtection';
import { validateMissionFileContent } from '@/utils/missionFileValidation';

export class EditCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: EditCliParams
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const {
      file_path: filePath,
      old_str: oldStr,
      new_str: newStr,
      change_all: changeAll,
    } = parameters;

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

    if (oldStr === undefined || oldStr === null) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'old_str is required',
        userError: 'Missing old_str parameter',
      };
      return;
    }

    if (newStr === undefined || newStr === null) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'new_str is required',
        userError: 'Missing new_str parameter',
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
          'Cannot edit files in artifacts directory. This directory is reserved for system-generated outputs.',
        userError: 'Cannot edit files in artifacts directory',
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
          'Cannot edit mission system files (state.json, progress_log.jsonl, model-settings.json). These files are managed by the system.',
        userError: 'Cannot edit mission system files',
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
          'Cannot edit features.json from a mission worker or validator session. features.json is managed by the orchestrator; report results with EndFeatureRun or return control to the orchestrator.',
        userError: 'Cannot edit features.json from a worker session',
      };
      return;
    }

    try {
      // Fetch diagnostics before the edit if IDE is available
      const diagnosticsBefore = await fetchDiagnostics(
        dependencies.ideClient,
        filePath
      );

      const result = await editFileWithDiff({
        filePath,
        oldStr,
        newStr,
        changeAll,
        toolCallId: dependencies.toolCallId,
        // Schema-gate edits targeting known mission artifacts (features.json,
        // handoffs/*.json, etc.) so a malformed edit cannot corrupt the
        // scheduler's on-disk view. Non-mission paths pass through.
        validateContent: (content) =>
          validateMissionFileContent(filePath, content),
      });

      if (!result.success) {
        // Mission-artifact schema rejections surface with
        // `failureKind: 'validation'` from `editFileWithDiff`. Those are
        // LLM-correctable (the LLM produced content that doesn't match the
        // on-disk schema), so classify them as `InvalidParameterLLMError`
        // to match CreateCliExecutor / ApplyPatchExecutor. Any other
        // failure stays `ToolInternalError`.
        const isValidationFailure = result.failureKind === 'validation';
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: isValidationFailure
            ? ToolExecutionErrorType.InvalidParameterLLMError
            : ToolExecutionErrorType.ToolInternalError,
          llmError: result.message,
          userError: isValidationFailure
            ? 'Mission artifact validation failed'
            : 'Failed to edit file',
        };
        return;
      }

      // Capture OLD content snapshot for rewind (so we can restore to previous state)
      if (result.oldContent) {
        void getFileSnapshotService()
          .captureToolFileChange({
            filePath,
            content: result.oldContent,
            toolCallId: dependencies.toolCallId || 'unknown',
            operation: 'edit',
          })
          .catch(() => {
            // Silently ignore snapshot failures - should not affect tool execution
          });
      }

      // Fetch diagnostics after the edit if IDE is available
      // Use fetchDiagnostics with retry logic
      const diagnosticsAfter = await fetchDiagnostics(
        dependencies.ideClient,
        filePath,
        1, // maxRetries
        500 // delayMs
      );

      // Compare diagnostics to find new errors
      const newDiagnostics = compareDiagnostics(
        diagnosticsBefore,
        diagnosticsAfter
      );

      // Format system reminder if there are new errors
      const systemReminder = formatDiagnosticsForSystemReminder(
        newDiagnostics,
        filePath
      );

      // Generate diff if we have old and new content
      if (result.oldContent && result.newContent) {
        const diffLines = generateUnifiedDiff(
          result.oldContent,
          result.newContent
        );

        const resultValue: Record<string, unknown> = {
          success: true,
          file_path: filePath,
          diffLines,
        };
        if (systemReminder) {
          resultValue.systemReminder = systemReminder;
        }

        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value: JSON.stringify(resultValue),
        };
      } else {
        // Fallback for cases without content
        const resultMessage = systemReminder
          ? `${result.message}\n\n${systemReminder}`
          : result.message;

        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value: resultMessage,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Error editing file: ${errorMessage}`,
        userError: 'Failed to edit file',
      };
    }
  }
}
