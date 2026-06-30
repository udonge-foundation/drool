import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_LINES_TO_VIEW,
  MAX_CHARS_TO_VIEW,
} from '@industry/drool-core/tools/definitions';
import { sliceContentByLines } from '@industry/drool-core/tools/utils/line-slice-utils';
import {
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  TextBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logWarn } from '@industry/logging';

import { fetchFileContent } from '@/tools/executors/client/file-tools/utils';
import { extractTaggedFiles } from '@/utils/extractTaggedFiles';

// Maximum number of items to show in a directory listing
const MAX_DIRECTORY_ITEMS = 100;

/**
 * Build system reminder blocks for any files or directories tagged in the user message.
 * Returns pairs of reminders per item: (1) tag notice, (2) contents or error.
 */
export async function buildTaggedPathReminderBlocks(
  userMessage: string,
  cwd: string
): Promise<TextBlock[]> {
  const blocks: TextBlock[] = [];
  const startTime = performance.now();

  try {
    const taggedFiles = extractTaggedFiles(userMessage, cwd);
    if (taggedFiles.length === 0) return blocks;

    for (const file of taggedFiles) {
      if (file.isDirectory) {
        // Handle directory
        blocks.push({
          type: MessageContentBlockType.Text,
          text: `${SYSTEM_REMINDER_START}\nUser tagged directory: ${file.absolutePath}\n${SYSTEM_REMINDER_END}`,
        });

        try {
          const contents = await fs.promises.readdir(file.absolutePath);

          // Truncate large directories
          const totalItems = contents.length;
          const itemsToShow = contents.slice(0, MAX_DIRECTORY_ITEMS);
          const isTruncated = totalItems > MAX_DIRECTORY_ITEMS;

          // Sort and annotate directories with trailing slash
          const annotatedItems: string[] = [];
          for (const item of itemsToShow.sort()) {
            const fullPath = path.join(file.absolutePath, item);
            try {
              const itemStats = await fs.promises.stat(fullPath);
              annotatedItems.push(itemStats.isDirectory() ? `${item}/` : item);
            } catch {
              // If we can't stat, just add the item without annotation
              annotatedItems.push(item);
            }
          }

          const listing = annotatedItems.join('\n');
          const truncationNote = isTruncated
            ? ` [showing first ${MAX_DIRECTORY_ITEMS} of ${totalItems}]`
            : '';
          const header = `Contents of directory ${file.absolutePath} (${totalItems} item${totalItems === 1 ? '' : 's'}${truncationNote}):\n`;

          blocks.push({
            type: MessageContentBlockType.Text,
            text: `${SYSTEM_REMINDER_START}\n${header}${listing}\n${SYSTEM_REMINDER_END}`,
          });
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : 'Unable to list directory';
          blocks.push({
            type: MessageContentBlockType.Text,
            text: `${SYSTEM_REMINDER_START}\nCould not list contents of ${file.absolutePath}: ${errMsg}\n${SYSTEM_REMINDER_END}`,
          });
        }
      } else {
        // Handle file
        blocks.push({
          type: MessageContentBlockType.Text,
          text: `${SYSTEM_REMINDER_START}\nUser tagged file: ${file.absolutePath}\n${SYSTEM_REMINDER_END}`,
        });

        // Include file contents (truncated to MAX_LINES_TO_VIEW)
        const relativeToCwd = path
          .relative(cwd, file.absolutePath)
          .replace(/\\/g, '/');
        const result = await fetchFileContent({
          repoPath: cwd,
          filePath: relativeToCwd,
        });

        if (result.success && typeof result.content === 'string') {
          const slice = sliceContentByLines(result.content, {
            maxLines: MAX_LINES_TO_VIEW,
            maxChars: MAX_CHARS_TO_VIEW,
          });
          const header = `Contents of ${file.absolutePath} (lines ${slice.actualStart}–${slice.actualEnd} of ${slice.totalLines}${slice.isTruncated ? ' [truncated]' : ''}):\n`;
          blocks.push({
            type: MessageContentBlockType.Text,
            text: `${SYSTEM_REMINDER_START}\n${header}${slice.content}\n${SYSTEM_REMINDER_END}`,
          });
        } else {
          const errMsg = result.error?.userError || 'Unable to read file';
          blocks.push({
            type: MessageContentBlockType.Text,
            text: `${SYSTEM_REMINDER_START}\nCould not include contents of ${file.absolutePath}: ${errMsg}\n${SYSTEM_REMINDER_END}`,
          });
        }
      }
    }

    logInfo('[TaggedPathReminders] Built reminders', {
      count: blocks.length,
      durationMs: Math.round(performance.now() - startTime),
      fileCount: taggedFiles.length,
    });
  } catch (e) {
    logWarn('[TaggedPathReminders] Failed building reminders', { error: e });
  }

  return blocks;
}
