import * as fs from 'fs/promises';
import * as path from 'path';

import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  SandboxOperationType,
  ToolConfirmationOutcome,
} from '@industry/drool-sdk-ext/protocol/drool';
import { logError, Metrics } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';
import { isNewSessionOutcome } from '@industry/utils';

import type { ExitSpecModeResult } from '@/agent/types';
import { enforceSandboxFileAccess } from '@/sandbox/sandboxGuard';
import { getSettingsService } from '@/services/SettingsService';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';
import {
  calculateSpecFilePath,
  findNearestProjectIndustryDir,
  getUserIndustryDir,
  saveSpecFileAtPath,
} from '@/utils/industryPaths';
import {
  getUnresolvedSpecOptionsLlmError,
  hasUnresolvedSpecOptions,
} from '@/utils/specPlanValidation';

// Metrics counter names
const METRICS = {
  SPEC_SAVED: 'spec_saved',
  SPEC_SAVE_FAILED: 'spec_save_failed',
} as const;

interface ExitSpecModeParameters {
  plan: string;
  title?: string;
}

async function detectTemplateSource(): Promise<'project' | 'user' | 'none'> {
  try {
    const projectIndustryDir = findNearestProjectIndustryDir(process.cwd());
    const projectTemplate = projectIndustryDir
      ? path.join(projectIndustryDir, 'SPEC_TEMPLATE.md')
      : null;
    if (projectTemplate) {
      await fs.access(projectTemplate);
      return 'project';
    }
  } catch {
    // ignore
  }
  try {
    const userTemplate = path.join(getUserIndustryDir(), 'SPEC_TEMPLATE.md');
    await fs.access(userTemplate);
    return 'user';
  } catch {
    // ignore
  }
  return 'none';
}

export class ExitSpecModeExecutor
  implements
    ClientToolExecutor<CliClientSpecificToolDependencies, ExitSpecModeResult>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    _parameters: ExitSpecModeParameters
  ): AsyncGenerator<DraftToolFeedback<ExitSpecModeResult>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    // Check if user chose to edit the spec
    const isEditMode =
      dependencies.confirmationOutcome === ToolConfirmationOutcome.ProceedEdit;
    const editedSpecContent = dependencies.editedSpecContent;
    const hasEditedSpecContent = typeof editedSpecContent === 'string';
    const isNewSessionMode =
      dependencies.confirmationOutcome != null &&
      isNewSessionOutcome(dependencies.confirmationOutcome);

    let filePath: string | undefined;
    let effectivePlan = _parameters.plan;
    let editStatus: ExitSpecModeResult['editStatus'];
    let specSaveSucceeded = false;

    if (isEditMode && !hasEditedSpecContent) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError:
          'Manual spec edit was approved, but no edited specification content was provided.',
        llmError:
          'Manual spec edit was approved, but the client did not provide editedSpecContent.',
      };
      return;
    }

    if (hasEditedSpecContent) {
      effectivePlan = editedSpecContent;
      editStatus = 'complete';
    }

    if (hasUnresolvedSpecOptions(effectivePlan)) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        userError:
          'The proposed specification still contains multiple unresolved options. Please choose one option with AskUser before proposing the final spec.',
        llmError: getUnresolvedSpecOptionsLlmError(),
      };
      return;
    }

    try {
      const title = (_parameters.title || '').trim();
      const specDirSetting = getSettingsService().getSpecSaveDir();
      const checkedSpecFilePath = await calculateSpecFilePath(
        specDirSetting,
        title,
        effectivePlan
      );
      const sandboxCheckContext = {
        toolCallId: dependencies.toolCallId ?? 'exit-spec-mode',
        toolName: 'ExitSpecMode',
        toolInput: {
          plan: effectivePlan,
          ...(title ? { title } : {}),
        },
        requestPermissionFn: dependencies.requestPermissionFn,
      };
      const fileSandboxDenial = await enforceSandboxFileAccess(
        checkedSpecFilePath,
        SandboxOperationType.Write,
        sandboxCheckContext
      );

      if (fileSandboxDenial) {
        Metrics.addToCounter(METRICS.SPEC_SAVE_FAILED, 1);
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          userError: fileSandboxDenial,
          llmError: fileSandboxDenial,
        };
        return;
      }

      filePath = await saveSpecFileAtPath(effectivePlan, checkedSpecFilePath);
      specSaveSucceeded = filePath.trim().length > 0;

      // Telemetry
      if (specSaveSucceeded) {
        const templateSource = await detectTemplateSource();
        Metrics.addToCounter(METRICS.SPEC_SAVED, 1, {
          reason: `template:${templateSource}`,
        });
      } else {
        Metrics.addToCounter(METRICS.SPEC_SAVE_FAILED, 1);
      }
    } catch (_error) {
      // Log error but continue
      logError('Failed to save spec file', { error: _error });
      Metrics.addToCounter(METRICS.SPEC_SAVE_FAILED, 1);
    }

    // Return appropriate message based on edit mode
    const title = (_parameters.title || '').trim();
    let message = '';

    if (hasEditedSpecContent) {
      message = specSaveSucceeded
        ? 'The plan has been saved and edited. Read the updated specification from disk before proceeding.'
        : 'The plan was edited and approved, but it could not be saved. Continue using unsavedEditedSpecContent from this result.';
    } else {
      const userComment = dependencies.exitSpecModeComment;
      if (isNewSessionMode) {
        message = specSaveSucceeded
          ? userComment
            ? `Specification was approved and saved. Start implementation in a new session and incorporate the user comment.\n\nUser comment: ${userComment}`
            : 'Specification has been approved and saved. Start implementation in a new session.'
          : userComment
            ? `Specification was approved but could not be saved. Start implementation in a new session and incorporate the user comment.\n\nUser comment: ${userComment}`
            : 'Specification has been approved but could not be saved. Start implementation in a new session.';
      } else {
        message = specSaveSucceeded
          ? userComment
            ? `Specification was approved but the user has left a required comment to address in the plan. Continue with the implementation.\n\nUser comment: ${userComment}`
            : 'Spec mode exited. The user approved the plan. Continue with the implementation.'
          : userComment
            ? `Specification was approved but could not be saved. The user has left a required comment to address in the plan. Continue with the implementation.\n\nUser comment: ${userComment}`
            : 'Spec mode exited. The user approved the plan, but it could not be saved. Continue with the implementation.';
      }
    }

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: {
        approved: true,
        message,
        filePath: filePath || '',
        userComment: dependencies.exitSpecModeComment,
        ...(hasEditedSpecContent && !specSaveSucceeded
          ? { unsavedEditedSpecContent: effectivePlan }
          : {}),
        handoff: isNewSessionMode
          ? {
              plan: effectivePlan,
              title: title || undefined,
              userComment: dependencies.exitSpecModeComment,
              isNewSession: true,
            }
          : undefined,
        isEdited: hasEditedSpecContent,
        editStatus,
      },
    };
  }
}
