import path from 'path';

import { ToolExecutionErrorType } from '@industry/common/session';
import {
  ApplyPatchCliParams,
  applyPatchCliSchema,
} from '@industry/drool-core/tools/definitions/cli';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { DraftToolFeedback } from '@industry/drool-core/tools/types';
import {
  extractFilePathFromPatch,
  FILE_OPERATION_TYPE_PARSE_FAILURE_MESSAGE,
  FILE_PATH_PARSE_FAILURE_MESSAGE,
  getFileOperationFromPatch,
  processApplyPatchOperation,
} from '@industry/drool-core/tools/utils/apply-patch';
import {
  detectLineEnding,
  normalizeToLF,
  convertLineEndings,
} from '@industry/drool-core/tools/utils/apply-patch-core';
import { FileOperation } from '@industry/drool-core/tools/utils/enums';
import { ApplyPatchTuiResult } from '@industry/drool-core/tools/utils/types';
import { getNameAndMessage, OutcomeRecorder } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { scrubSecrets } from '@industry/utils/secretScrubber';
import { getDiff } from '@industry/utils/text';

import {
  readFileContent,
  validateFileForCreate,
  validateFileForEdit,
  writeFileContent,
} from '@/agent/file-edit/utils';
import { isMissionWorkerSession } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { getFileSnapshotService } from '@/services/snapshots/FileSnapshotService';
import {
  compareDiagnostics,
  fetchDiagnostics,
  formatDiagnosticsForSystemReminder,
} from '@/tools/executors/client/file-tools/diagnostics-utils';
import { validateApplyPatchParameters } from '@/tools/executors/client/utils/apply-patch-validation';
import {
  APPLY_PATCH_INCOMPLETE_INPUT_LLM_ERROR,
  APPLY_PATCH_INCOMPLETE_INPUT_USER_ERROR,
} from '@/tools/executors/client/utils/constants';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';
import { isPathInArtifactsDir } from '@/utils/artifactsProtection';
import {
  isMissionSystemFile,
  isMissionWorkerProtectedFile,
} from '@/utils/missionFileProtection';
import { validateMissionFileContent } from '@/utils/missionFileValidation';

import type { ClientToolExecutor } from '@industry/drool-core/tools/types';

export class ApplyPatchCliExecutor
  implements
    ClientToolExecutor<CliClientSpecificToolDependencies, ApplyPatchTuiResult>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: ApplyPatchCliParams
  ): AsyncGenerator<DraftToolFeedback<ApplyPatchTuiResult>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const outcomeRecorder = new OutcomeRecorder(
      dependencies.toolMessageId,
      Metric.DROOL_MODE_APPLY_PATCH_SUCCESS_COUNT,
      Metric.DROOL_MODE_APPLY_PATCH_ERROR_COUNT,
      'applyPatchSuccess'
    );

    const validation = validateApplyPatchParameters(
      parameters,
      applyPatchCliSchema
    );
    if (validation.error) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: APPLY_PATCH_INCOMPLETE_INPUT_LLM_ERROR,
        userError: APPLY_PATCH_INCOMPLETE_INPUT_USER_ERROR,
      };
      outcomeRecorder.recordOutcome(false, { operationType: 'unknown' });
      return;
    }

    // Ensure parameters have default values applied
    const parsedParameters = validation.data;

    const operationType = getFileOperationFromPatch(parsedParameters.input);
    if (!operationType) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: FILE_OPERATION_TYPE_PARSE_FAILURE_MESSAGE,
        userError: 'Failed to determine file operation',
      };
      outcomeRecorder.recordOutcome(false, { operationType: 'unknown' });
      return;
    }

    // Extract the single file path from the patch input
    const extractedFilePath = extractFilePathFromPatch(parsedParameters.input);
    if (!extractedFilePath) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: FILE_PATH_PARSE_FAILURE_MESSAGE,
        userError: 'Failed to parse file path',
      };
      outcomeRecorder.recordOutcome(false, { operationType });
      return;
    }

    const filePath = path.isAbsolute(extractedFilePath)
      ? extractedFilePath
      : path.resolve(extractedFilePath);

    // Prevent writes to artifacts directory (check for relative paths)
    if (isPathInArtifactsDir(filePath)) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          'Cannot modify files in artifacts directory. This directory is reserved for system-generated outputs.',
        userError: 'Cannot modify files in artifacts directory',
      };
      outcomeRecorder.recordOutcome(false, { operationType });
      return;
    }

    // Prevent writes to mission system files.
    if (isMissionSystemFile(filePath)) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          'Cannot modify mission system files (state.json, progress_log.jsonl, model-settings.json). These files are managed by the system.',
        userError: 'Cannot modify mission system files',
      };
      outcomeRecorder.recordOutcome(false, { operationType });
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
          'Cannot modify features.json from a mission worker or validator session. features.json is managed by the orchestrator; report results with EndFeatureRun or return control to the orchestrator.',
        userError: 'Cannot modify features.json from a worker session',
      };
      outcomeRecorder.recordOutcome(false, { operationType });
      return;
    }

    const fileContentRecord: Record<string, string> = {};

    if (operationType === FileOperation.Update) {
      const fileValidation = await validateFileForEdit(
        filePath,
        dependencies.toolCallId
      );
      if (!fileValidation.success) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          llmError: `Error reading file content: ${fileValidation.message}`,
          userError: 'Error reading file content',
        };
        outcomeRecorder.recordOutcome(false, { operationType });
        return;
      }

      const readResult = await readFileContent(filePath);

      if (readResult.error) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          llmError: readResult.error,
          userError: 'Error reading file content',
        };
        outcomeRecorder.recordOutcome(false, { operationType });
        return;
      }

      const keyPath = extractedFilePath;

      // Detect and store original line ending
      const originalLineEnding = detectLineEnding(readResult.content!);
      // Normalize to LF for patch processing
      fileContentRecord[keyPath] = normalizeToLF(readResult.content!);
      // Store line ending for later restoration
      fileContentRecord[`${keyPath}:lineEnding`] = originalLineEnding;
    }

    // For Create operations, ensure the target is not a directory.
    // Create is allowed to overwrite an existing file — the snapshot capture
    // below uses writeFileContent's returned prior content so rewind works.
    if (operationType === FileOperation.Create) {
      const createValidation = await validateFileForCreate(filePath);
      if (!createValidation.success) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError: createValidation.message,
          userError: createValidation.message,
        };
        outcomeRecorder.recordOutcome(false, { operationType });
        return;
      }
    }

    const patchFilePath = extractedFilePath;
    const patchText = normalizeToLF(parsedParameters.input);

    // Fetch diagnostics before the edit if IDE is available and file exists
    const diagnosticsBefore =
      operationType === FileOperation.Update
        ? await fetchDiagnostics(dependencies.ideClient, filePath)
        : [];

    // Mirror the scrubber the model saw on Read/Grep/shell output so context
    // lines containing `*` runs still resolve to the right file offsets.
    // `:lineEnding` entries are metadata and pass through untouched.
    const matchingContentRecord: Record<string, string> = {};
    for (const [key, value] of Object.entries(fileContentRecord)) {
      matchingContentRecord[key] = key.endsWith(':lineEnding')
        ? value
        : scrubSecrets(value);
    }

    const applyPatchResult = processApplyPatchOperation({
      operationType,
      filePath: patchFilePath, // Use the appropriate path for patch processing
      patchText,
      fileContentRecord,
      matchingContentRecord,
    });

    if (!applyPatchResult.success) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Failed to apply patch: ${getNameAndMessage(applyPatchResult.error)}`,
        userError: 'Failed to apply patch',
      };
      outcomeRecorder.recordOutcome(false, { operationType });
      return;
    }

    // Get original line ending, default to LF for new files
    const lineEndingKey = `${patchFilePath}:lineEnding`;
    const originalLineEnding =
      (fileContentRecord[lineEndingKey] as '\r\n' | '\n') || '\n';
    const contentToWrite = convertLineEndings(
      applyPatchResult.content,
      originalLineEnding
    );

    const missionValidation = validateMissionFileContent(
      filePath,
      contentToWrite
    );
    if (!missionValidation.ok) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          missionValidation.llmError ?? 'Mission artifact validation failed.',
        userError: 'Mission artifact validation failed',
      };
      outcomeRecorder.recordOutcome(false, { operationType });
      return;
    }

    // Save the file using writeFileContent with toolCallId for timestamp tracking
    const writeResult = await writeFileContent({
      filePath,
      content: contentToWrite,
      toolCallId: dependencies.toolCallId,
    });

    if (!writeResult.success) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Failed to save file: ${writeResult.message}`,
        userError: 'Failed to save file',
      };
      outcomeRecorder.recordOutcome(false, { operationType });
      return;
    }

    // Capture snapshot for rewind
    // For Update operations, capture the original content (so we can restore to previous state)
    // For Create operations, track the creation (so we can delete the file on rewind)
    if (operationType === FileOperation.Update) {
      const keyPath = extractedFilePath;
      const originalContent = fileContentRecord[keyPath];
      if (originalContent) {
        // Convert back to original line endings for snapshot
        const originalLineEndingKey = `${keyPath}:lineEnding`;
        const originalLineEndingForSnapshot =
          (fileContentRecord[originalLineEndingKey] as '\r\n' | '\n') || '\n';
        const contentToSnapshot = convertLineEndings(
          originalContent,
          originalLineEndingForSnapshot
        );
        void getFileSnapshotService()
          .captureToolFileChange({
            filePath,
            content: contentToSnapshot,
            toolCallId: dependencies.toolCallId || 'unknown',
            operation: 'apply-patch',
          })
          .catch(() => {
            // Silently ignore snapshot failures - should not affect tool execution
          });
      }
    } else if (operationType === FileOperation.Create) {
      // On overwrite, stash the prior content so rewind restores it.
      // On a fresh create, track the creation so rewind deletes the file.
      void getFileSnapshotService()
        .captureToolFileChange({
          filePath,
          content: writeResult.wasNewFile ? '' : (writeResult.oldContent ?? ''),
          toolCallId: dependencies.toolCallId || 'unknown',
          operation: writeResult.wasNewFile ? 'create' : 'apply-patch',
        })
        .catch(() => {
          // Silently ignore snapshot failures - should not affect tool execution
        });
    }

    // Fetch diagnostics after the edit if IDE is available
    // Use diagnosticsAfter which includes delay and retry logic
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

    const displayOperation =
      operationType === FileOperation.Update || writeResult.wasNewFile === false
        ? FileOperation.Update
        : FileOperation.Create;

    const successResult: ApplyPatchTuiResult =
      displayOperation === FileOperation.Create
        ? {
            success: true,
            file_path: filePath,
            display_operation: FileOperation.Create,
            content: contentToWrite,
            ...(systemReminder ? { systemReminder } : {}),
          }
        : {
            success: true,
            file_path: filePath,
            display_operation: FileOperation.Update,
            diff:
              operationType === FileOperation.Update
                ? (applyPatchResult.diff ?? '')
                : getDiff({
                    originalContent: writeResult.oldContent ?? '',
                    editedContent: contentToWrite,
                  }),
            ...(systemReminder ? { systemReminder } : {}),
          };

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: successResult,
    };
    outcomeRecorder.recordOutcome(true, { operationType });
  }
}
