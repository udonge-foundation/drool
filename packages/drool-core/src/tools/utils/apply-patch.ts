import { logException, logInfo } from '@industry/logging';
import { getDiff } from '@industry/utils/text';

import { convertTextToPatch, applyPatchToFiles } from './apply-patch-core';
import { PATCH_END_MARKER, PATCH_START_MARKER } from './constants';
import { FileOperation } from './enums';
import { PatchApplicationError } from './errors';
import { ApplyPatchResult } from './types';

export const FILE_PATH_PARSE_FAILURE_MESSAGE = `
Failed to extract file path from patch. 
The required format is '[ACTION] File: [path/to/file]' -> ACTION must be either Add or Update.
`.trim();

export function extractFilePathFromPatch(
  patchText: string
): string | undefined {
  // Look for the file path in the patch (only supports single file)
  const updateFilePattern = /\*\*\* Update File:\s*(.+)/;
  const addFilePattern = /\*\*\* Add File:\s*(.+)/;

  let match = patchText.match(updateFilePattern);
  if (!match) {
    match = patchText.match(addFilePattern);
  }

  return match?.[1]?.trim();
}

export const FILE_OPERATION_TYPE_PARSE_FAILURE_MESSAGE = `
Failed to extract file action type from patch. 
The required format is '[ACTION] File: [path/to/file]' -> ACTION must be either Add or Update.
`.trim();

/**
 * Determines the FileOperation type from the patch text
 *
 * @param patchText - The patch text to analyze
 * @returns FileOperation type (Create or Update)
 */
export function getFileOperationFromPatch(
  patchText: string
): FileOperation | undefined {
  const addFilePattern = /\*\*\* Add File:\s*(.+)/;
  const updateFilePattern = /\*\*\* Update File:\s*(.+)/;
  let operationType: FileOperation | undefined;
  if (patchText.match(addFilePattern)) {
    operationType = FileOperation.Create;
  } else if (patchText.match(updateFilePattern)) {
    operationType = FileOperation.Update;
  }

  return operationType;
}

interface ProcessApplyPatchOperation {
  operationType: FileOperation;
  filePath: string;
  patchText: string;
  fileContentRecord: Record<string, string>;
  /**
   * Optional record used for parsing the patch's context lines. When the
   * caller's view of the file is filtered through a length-preserving
   * transform (e.g. a secret scrubber) but the splice must land in the
   * original bytes, pass the transformed view here. Defaults to
   * `fileContentRecord`.
   */
  matchingContentRecord?: Record<string, string>;
}

export function processApplyPatchOperation({
  operationType,
  filePath,
  patchText,
  fileContentRecord,
  matchingContentRecord,
}: ProcessApplyPatchOperation): ApplyPatchResult {
  let result: ApplyPatchResult;
  try {
    // Guard: Prevent creating a file if it already exists in the record
    // This is a defensive check - the executors should handle this first
    if (
      operationType === FileOperation.Create &&
      fileContentRecord &&
      fileContentRecord[filePath] !== undefined
    ) {
      throw new PatchApplicationError(
        'Cannot create file: file already exists in the content record',
        { filePath }
      );
    }

    // Add missing patch markers if needed (including newlines)
    let normalizedPatchText = patchText;

    // Handle start marker: '*** Begin Patch\n'
    if (!normalizedPatchText.startsWith(PATCH_START_MARKER)) {
      // Check if it has the marker without the trailing newline
      if (normalizedPatchText.startsWith(PATCH_START_MARKER.trim())) {
        // Has marker but missing newline - replace with full marker
        normalizedPatchText =
          PATCH_START_MARKER +
          normalizedPatchText.slice(PATCH_START_MARKER.trim().length);
      } else {
        // No marker at all - prepend full marker
        normalizedPatchText = PATCH_START_MARKER + normalizedPatchText;
      }
    }

    // Handle end marker: '\n*** End Patch'
    if (!normalizedPatchText.endsWith(PATCH_END_MARKER)) {
      // Check if it has the marker without the leading newline
      if (normalizedPatchText.endsWith(PATCH_END_MARKER.trim())) {
        // Has marker but missing leading newline - replace with full marker
        normalizedPatchText =
          normalizedPatchText.slice(0, -PATCH_END_MARKER.trim().length) +
          PATCH_END_MARKER;
      } else {
        // No marker at all - append full marker
        normalizedPatchText += PATCH_END_MARKER;
      }
    }

    const [parsedPatch, _] = convertTextToPatch(
      normalizedPatchText,
      matchingContentRecord ?? fileContentRecord
    );
    if (operationType === FileOperation.Create) {
      // For Create operation, we don't need to fetch the file content
      logInfo('Creating new file from patch', {
        filePath,
      });

      logInfo('Patch parsed successfully for new file', {
        filePath,
      });

      // Extract the new content from the parsed patch
      const fileAction = parsedPatch.actions[filePath];
      if (!fileAction) {
        throw new PatchApplicationError('No create action found in patch', {
          filePath,
        });
      }

      // For Create operations, all lines are in the first chunk's linesToInsert
      const firstChunk = fileAction.chunks[0];
      if (!firstChunk || !firstChunk.linesToInsert) {
        throw new PatchApplicationError('No content found for new file');
      }

      result = { success: true, content: firstChunk.linesToInsert.join('\n') };
    } else {
      logInfo('Patch parsed successfully', {
        filePath,
      });

      const commit = applyPatchToFiles(parsedPatch, fileContentRecord);
      const change = commit.changes[filePath];

      logInfo('Patch applied successfully', {
        filePath,
      });

      // typeof check (not truthiness) so an empty string — a patch that
      // deletes every line — is treated as a valid result.
      if (
        !change ||
        change.type !== FileOperation.Update ||
        typeof change.newContent !== 'string'
      ) {
        throw new PatchApplicationError(
          'No valid changes found in patch result'
        );
      }

      const diff = getDiff({
        originalContent: fileContentRecord[filePath] || '',
        editedContent: change.newContent,
      });
      result = {
        success: true,
        content: change.newContent,
        diff,
      };
    }
  } catch (error) {
    logException(error, 'Failed to apply patch');
    result = {
      success: false,
      error,
    };
  }
  return result;
}
