import {
  validateChange,
  applyChangeByOffset,
  preserveNewlineEnding,
} from '@industry/drool-core/tools/utils/file-tools-utils';
import { FileEditChange } from '@industry/drool-core/tools/utils/types';
import { scrubSecrets } from '@industry/utils/secretScrubber';

import type { EditFileWithDiffResult } from '@/agent/file-edit/types';
import {
  validateFileForEdit,
  readFileContent,
  writeFileContent,
} from '@/agent/file-edit/utils';

export async function editFileWithDiff(params: {
  filePath: string;
  oldStr: string;
  newStr: string;
  changeAll?: boolean;
  toolCallId?: string;
  /**
   * Optional post-apply validator. Runs against the fully-applied new file
   * content BEFORE it's written to disk. If it returns `{ ok: false }`, the
   * edit is aborted, the original file on disk is left untouched, and
   * `message` is the caller-supplied `llmError` so the surrounding tool
   * executor can forward an actionable error to the LLM.
   */
  validateContent?: (content: string) => { ok: boolean; llmError?: string };
}): Promise<EditFileWithDiffResult> {
  const {
    filePath,
    oldStr,
    newStr,
    changeAll = false,
    toolCallId,
    validateContent,
  } = params;

  try {
    // Validate file for editing (includes external change detection)
    const validation = await validateFileForEdit(filePath, toolCallId);
    if (!validation.success) {
      return {
        success: false,
        message: validation.message,
        filePath,
      };
    }

    // Read file content
    const fileResult = await readFileContent(filePath);
    if (fileResult.error) {
      return {
        success: false,
        message: fileResult.error,
        filePath,
      };
    }

    const originalContent = fileResult.content!;
    const change: FileEditChange = {
      old_str: oldStr,
      new_str: newStr,
      change_all: changeAll,
    };

    // The model's view of the file is filtered through scrubSecrets, so
    // oldStr may contain `*` runs that aren't on disk. Match against the
    // scrubbed view; splice into the original.
    const matchingContent = scrubSecrets(originalContent);

    const changeValidation = validateChange(matchingContent, change);
    if (!changeValidation.success) {
      return {
        success: false,
        message: changeValidation.message,
        oldContent: originalContent,
        filePath,
      };
    }

    const newContent = applyChangeByOffset(
      originalContent,
      matchingContent,
      change
    );

    const contentToWrite = preserveNewlineEnding(originalContent, newContent);

    // Post-apply validation hook: used by tool executors to block writes
    // that would corrupt a structured on-disk artifact (e.g. mission
    // features.json). Runs against the fully-applied content, so the
    // original file stays untouched if validation fails. Tag the failure
    // with `failureKind: 'validation'` so callers can classify this as an
    // LLM-fixable `InvalidParameterLLMError` rather than a `ToolInternalError`.
    if (validateContent) {
      const postApplyValidation = validateContent(contentToWrite);
      if (!postApplyValidation.ok) {
        return {
          success: false,
          message:
            postApplyValidation.llmError ??
            'Edit aborted: post-apply validation failed.',
          oldContent: originalContent,
          newContent: contentToWrite,
          filePath,
          failureKind: 'validation',
        };
      }
    }

    // Write the file with toolCallId for timestamp tracking
    const writeResult = await writeFileContent({
      filePath,
      content: contentToWrite,
      toolCallId,
    });
    if (!writeResult.success) {
      return {
        success: false,
        message: writeResult.message,
        oldContent: originalContent,
        newContent: contentToWrite,
        filePath,
      };
    }

    const message = `${writeResult.message}\nReplaced ${changeValidation.changesApplied} occurrence${changeValidation.changesApplied! > 1 ? 's' : ''} of the specified text.`;

    return {
      success: true,
      message,
      oldContent: originalContent,
      newContent: contentToWrite,
      filePath,
      changesApplied: changeValidation.changesApplied,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error editing file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      filePath,
    };
  }
}
