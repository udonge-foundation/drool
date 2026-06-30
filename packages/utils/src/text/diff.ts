import * as diffLib from 'diff';

import { logException } from '@industry/logging';

const NO_CHANGE_DIFF_PLACEHOLDER = '<file contents unchanged>';
const REMOVED_DIFF_PLACEHOLDER = '<user has removed this diff>';
const USER_DELETED_CONTENT_PLACEHOLDER =
  '<user has removed the result of this tool call>';

interface GetDiffParams {
  originalContent: string;
  editedContent: string;
  contextLines?: number;
}

export function getDiff({
  originalContent,
  editedContent,
  contextLines = 3,
}: GetDiffParams): string {
  if (
    originalContent === USER_DELETED_CONTENT_PLACEHOLDER ||
    editedContent === USER_DELETED_CONTENT_PLACEHOLDER
  ) {
    return REMOVED_DIFF_PLACEHOLDER;
  }
  if (originalContent === editedContent) {
    return NO_CHANGE_DIFF_PLACEHOLDER;
  }

  try {
    let patch = diffLib.createTwoFilesPatch(
      'previous',
      'current',
      originalContent,
      editedContent,
      '',
      '',
      { context: contextLines, ignoreWhitespace: true }
    );

    // Remove the first line if it only contains ===
    const lines = patch.split('\n');
    if (lines[0]?.match(/^=+$/)) {
      patch = lines.slice(1).join('\n');
    }

    // Strip leading/trailing whitespace
    patch = patch.trim();

    return patch;
  } catch (error) {
    logException(error, 'Error generating diff');
    return '(diff unavailable)';
  }
}
