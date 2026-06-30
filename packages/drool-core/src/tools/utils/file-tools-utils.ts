import { normalizeChangeLineEndings } from './normalize-line-endings';
import {
  FileEditChange,
  FileEditResult,
  FileEditResultWithDiff,
} from './types';

/**
 * Preserves the newline ending convention of the original file content.
 * If the original had a trailing newline and the new doesn't, adds it.
 * If the original didn't have a trailing newline and the new does, removes it.
 *
 * @param originalContent The original file content
 * @param newContent The new content to be written
 * @returns The new content with preserved newline ending
 */
export function preserveNewlineEnding(
  originalContent: string,
  newContent: string
): string {
  const originalHasNewline = originalContent.endsWith('\n');
  const newHasNewline = newContent.endsWith('\n');

  if (originalHasNewline && !newHasNewline) {
    return `${newContent}\n`;
  }
  if (!originalHasNewline && newHasNewline) {
    return newContent.slice(0, -1);
  }
  return newContent;
}

export function validateChange(
  content: string,
  change: FileEditChange,
  changeIndex?: number
): FileEditResult {
  const prefix = changeIndex !== undefined ? `Change ${changeIndex + 1}: ` : '';
  const normalizedChange = normalizeChangeLineEndings(content, change);

  // Special case: if old_str is empty and file is empty, this is creating a new file
  if (normalizedChange.old_str === '' && content === '') {
    return {
      success: true,
      message: '',
      changesApplied: 1,
    };
  }

  if (!content.includes(normalizedChange.old_str)) {
    return {
      success: false,
      message: `${prefix}Error: The text to replace was not found in the file. Please ensure the old_str parameter matches the exact text in the file, including whitespace and line breaks.`,
    };
  }

  const occurrences = content.split(normalizedChange.old_str).length - 1;

  if (occurrences > 1 && !normalizedChange.change_all) {
    return {
      success: false,
      message: `${prefix}Error: Found ${occurrences} occurrences of the specified text, but change_all is false. Either:\n1. Provide more context in old_str to make it unique\n2. Set change_all to true if you want to replace all ${occurrences} occurrences`,
    };
  }

  return {
    success: true,
    message: '',
    changesApplied: normalizedChange.change_all ? occurrences : 1,
  };
}

export function applyChange(content: string, change: FileEditChange): string {
  const normalizedChange = normalizeChangeLineEndings(content, change);

  if (normalizedChange.change_all) {
    // Use split and join for compatibility
    return content
      .split(normalizedChange.old_str)
      .join(normalizedChange.new_str);
  }
  return content.replace(
    normalizedChange.old_str,
    () => normalizedChange.new_str
  );
}

/**
 * Like `applyChange`, but locates `old_str` in `matching` while splicing the
 * replacement into `original`. Used when the caller saw a length-preserving
 * transformed view of the file (e.g. via a secret scrubber) but writes must
 * land in the untransformed bytes on disk.
 *
 * Falls back to `applyChange(original, change)` when length parity is broken
 * or `old_str` is empty.
 */
export function applyChangeByOffset(
  original: string,
  matching: string,
  change: FileEditChange
): string {
  if (original.length !== matching.length) {
    return applyChange(original, change);
  }

  const normalizedChange = normalizeChangeLineEndings(matching, change);
  const oldStr = normalizedChange.old_str;
  const newStr = normalizedChange.new_str;

  if (oldStr === '') {
    return applyChange(original, change);
  }

  const positions: number[] = [];
  let pos = matching.indexOf(oldStr);
  while (pos !== -1) {
    positions.push(pos);
    if (!normalizedChange.change_all) break;
    pos = matching.indexOf(oldStr, pos + oldStr.length);
  }

  if (positions.length === 0) {
    return original;
  }

  // Splice from end to start so earlier indices stay valid.
  let result = original;
  for (let i = positions.length - 1; i >= 0; i--) {
    const p = positions[i]!;
    result = result.slice(0, p) + newStr + result.slice(p + oldStr.length);
  }
  return result;
}

/**
 * Computes a preview of file edits with validation.
 * This ensures both the confirmation phase and execution phase use the same logic.
 *
 * @param content The current file content
 * @param changes Array of changes to apply
 * @returns Result with success status, message, and optionally the old/new content
 */
export function computeEditPreview(
  content: string,
  changes: FileEditChange[]
): FileEditResultWithDiff {
  let newContent = content;
  const results: string[] = [];
  let totalChanges = 0;

  // Apply each change with validation
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];

    // Validate the change first
    const validation = validateChange(newContent, change, i);
    if (!validation.success) {
      return {
        success: false,
        message: validation.message,
        oldContent: content,
        newContent: undefined, // Important: undefined indicates validation failure
      };
    }

    // Apply the change
    newContent = applyChange(newContent, change);
    totalChanges += validation.changesApplied!;
    results.push(
      `Change ${i + 1}: Replaced ${validation.changesApplied} occurrence${validation.changesApplied! > 1 ? 's' : ''}`
    );
  }

  return {
    success: true,
    message: results.join('\n'),
    oldContent: content,
    newContent,
    changesApplied: totalChanges,
  };
}
