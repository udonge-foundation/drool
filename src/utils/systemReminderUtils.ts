import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';

import { IdeContextState } from '@/hooks/types';
import { getFileTimestampTracker } from '@/services/FileTimestampTracker';

import type { WorktreeSessionInfo } from '@industry/utils/git';

/**
 * Wraps text in system reminder tags.
 * @param text - The text to wrap
 * @returns Text wrapped in SYSTEM_REMINDER_START and SYSTEM_REMINDER_END tags
 */
export function wrapInSystemReminder(text: string): string {
  return `${SYSTEM_REMINDER_START}${text}${SYSTEM_REMINDER_END}`;
}

function getUtcDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function formatCurrentDateReminder(date = new Date()): string {
  const today = getUtcDateString(date);
  return wrapInSystemReminder(
    `IMPORTANT - Current date for web search relevance:\n- Today's date is ${today}. Use this date when WebSearch needs the current year for recent information, documentation, or current events.`
  );
}

export function isCurrentDateReminderForDate(
  text: string,
  date = new Date()
): boolean {
  return (
    text.includes('IMPORTANT - Current date for web search relevance:') &&
    text.includes(`Today's date is ${getUtcDateString(date)}.`)
  );
}

/**
 * Formats IDE context information into a system reminder message
 * @param activeFile - The currently active file in the IDE
 * @param selection - Optional selection information for the active file
 * @returns Formatted system reminder message, or empty string if no active file
 */
export function formatIdeContextMessage(
  activeFile: IdeContextState['activeFile'],
  selection?: IdeContextState['activeFileSelection']
): string {
  if (!activeFile) return '';

  let message = `The user opened the file ${activeFile.path} in the IDE.`;

  // Add selection context if available
  if (selection && selection.selectedText) {
    const lineCount = selection.endLine - selection.startLine + 1;
    const charCount = selection.selectedText.length;
    const MAX_CHARS = 4000;

    let textToShow = selection.selectedText;
    let truncationNote = '';

    if (charCount > MAX_CHARS) {
      textToShow = selection.selectedText.slice(0, MAX_CHARS);
      truncationNote = `\n... (truncated, showing ${MAX_CHARS} of ${charCount} characters)`;
    }

    if (lineCount === 1) {
      message += ` The user has selected text on line ${selection.startLine + 1}:\n${textToShow}${truncationNote}`;
    } else {
      message += ` The user has selected ${lineCount} lines (${selection.startLine + 1}-${selection.endLine + 1}):\n${textToShow}${truncationNote}`;
    }
  }

  message += '\nThis may or may not be related to the current task.';
  return message;
}

/**
 * Generates a system reminder for files that have been changed externally
 * @returns Formatted system reminder about external file changes, or empty string if no changes
 */
export async function formatFileChangeReminder(): Promise<string> {
  const tracker = getFileTimestampTracker();
  const changedFiles = await tracker.getRecentlyChangedFiles();

  if (changedFiles.length === 0) {
    return '';
  }

  if (changedFiles.length === 1) {
    return `IMPORTANT: The file ${changedFiles[0]} has been modified externally since you last accessed it. It's strongly advised to use the Read tool to review the latest version before making any edits.`;
  }

  const fileList = changedFiles.map((f) => `  - ${f}`).join('\n');
  return `IMPORTANT: The following files have been modified externally since you last accessed them:\n${fileList}\nIt's strongly advised to use the Read tool to review the latest versions before making any edits.`;
}

/**
 * Formats a system reminder for git worktree sessions.
 * Tells the model it is operating in an isolated worktree and should not
 * navigate back to the original repository root.  When the worktree was
 * freshly created, also hints that project dependencies may need to be
 * installed before builds or tests will work.
 */
export function formatWorktreeReminder(
  worktreeInfo: WorktreeSessionInfo
): string {
  let message =
    `You are working inside a git worktree at ${worktreeInfo.path} (branch: ${worktreeInfo.branch}). ` +
    `This is an isolated working copy of the repository. ` +
    `Always run commands from this directory — do not change into the original repository root at ${worktreeInfo.repoRoot}.`;

  if (worktreeInfo.isNewlyCreated) {
    message +=
      `\nThis worktree was just created and may not have project dependencies installed. ` +
      `If builds, tests, or tooling fail with missing-module errors, install dependencies first.`;
  }

  return message;
}

/**
 * Body of the system reminder appended to a tool result when the secret
 * scrubber actually modified its output. Tells the model what the asterisks
 * mean, not to infer redacted content, and how to preserve a redaction
 * through edit tools.
 */
export function formatSecretRedactionReminder(): string {
  return [
    'Some `*` characters in this output may be redactions, not literal asterisks.',
    'Do not infer or rewrite redacted content.',
    'To preserve a redaction when editing this content, copy the `*` run verbatim into `old_str` — edit tools match against the redacted view and write the original bytes to disk.',
  ].join(' ');
}
