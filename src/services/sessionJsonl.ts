import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import {
  convertMessageEventToIndustryDroolMessage,
  type DroolMessageEvent,
} from '@industry/common/session';
import { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  MALFORMED_JSONL_LINE_WARNING,
  parseSessionJsonlLine,
} from '@industry/utils/session';

import type {
  CompactionTruncatedResult,
  DroolSession,
  ReadSessionJsonlOptions,
  CompactionStateEvent,
  DroolSessionEvent,
} from '@/services/types';
import { executeRipgrep, getRipgrepPath } from '@/utils/grep-utils';

import type { SessionSummaryEvent } from '@industry/common/session/summary';

export function buildDroolSessionFromJsonlResult(params: {
  sessionMetadata: SessionSummaryEvent;
  messages: IndustryDroolMessage[];
}): DroolSession {
  const { sessionMetadata, messages } = params;

  return {
    id: sessionMetadata.id,
    title: sessionMetadata.title,
    sessionTitle: sessionMetadata.sessionTitle,
    owner: sessionMetadata.owner,
    cwd: sessionMetadata.cwd,
    decompSessionType: sessionMetadata.decompSessionType,
    decompMissionId: sessionMetadata.decompMissionId,
    messages,
  };
}

async function readSessionSummaryAndMessageEventsFromJsonl(
  options: ReadSessionJsonlOptions
): Promise<{
  sessionMetadata: SessionSummaryEvent;
  messageEvents: DroolMessageEvent[];
  targetMessageIndex?: number;
}> {
  const { sessionPath, targetMessageId } = options;

  if (!fs.existsSync(sessionPath)) {
    throw new MetaError('Session file not found', { filePath: sessionPath });
  }

  const messageEvents: DroolMessageEvent[] = [];
  let sessionMetadata: SessionSummaryEvent | null = null;
  let targetMessageIndex: number | undefined;

  const fileStream = fs.createReadStream(sessionPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      const { event, error } = parseSessionJsonlLine(line);
      if (!event) {
        logWarn(MALFORMED_JSONL_LINE_WARNING, {
          filePath: sessionPath,
          errorMessage: error?.message,
        });
        continue;
      }

      if (event.type === 'session_start') {
        sessionMetadata = event;
        continue;
      }

      if (event.type !== 'message') {
        continue;
      }

      if (targetMessageId && event.id === targetMessageId) {
        messageEvents.push(event);
        targetMessageIndex = messageEvents.length;
        break;
      }

      messageEvents.push(event);
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  if (!sessionMetadata) {
    throw new MetaError('Invalid session file: missing session_start event', {
      filePath: sessionPath,
    });
  }

  return { sessionMetadata, messageEvents, targetMessageIndex };
}

export async function readSessionSummaryAndMessagesFromJsonl(
  options: ReadSessionJsonlOptions
): Promise<{
  sessionMetadata: SessionSummaryEvent;
  messages: IndustryDroolMessage[];
  targetMessageIndex?: number;
}> {
  const { sessionMetadata, messageEvents, targetMessageIndex } =
    await readSessionSummaryAndMessageEventsFromJsonl(options);

  return {
    sessionMetadata,
    messages: messageEvents.map(convertMessageEventToIndustryDroolMessage),
    targetMessageIndex,
  };
}

/**
 * Find byte offsets of compaction_state lines using the embedded ripgrep binary.
 * Returns array of { byteOffset } sorted by file position.
 * Returns empty array if ripgrep is unavailable.
 */
async function findCompactionByteOffsets(
  sessionPath: string
): Promise<Array<{ byteOffset: number }>> {
  const rgPath = getRipgrepPath();
  if (!rgPath) return [];

  try {
    const { stdout } = await executeRipgrep(
      [
        '-b',
        '--no-line-number',
        '--no-filename',
        '^\\{"type":"compaction_state"',
        sessionPath,
      ],
      path.dirname(sessionPath)
    );
    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split('\n')
      .map((entry) => {
        const colonIdx = entry.indexOf(':');
        return { byteOffset: parseInt(entry.slice(0, colonIdx), 10) };
      });
  } catch {
    return [];
  }
}

/**
 * Read session_start metadata from the first line of the file.
 */
async function readSessionStart(
  sessionPath: string
): Promise<SessionSummaryEvent> {
  const stream = fs.createReadStream(sessionPath, { end: 64 * 1024 });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const { event } = parseSessionJsonlLine(line);
      if (event?.type === 'session_start') return event;
      break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  throw new MetaError('Invalid session file: missing session_start event', {
    filePath: sessionPath,
  });
}

/**
 * Read messages and compaction events from a session file starting at a given byte offset.
 */
async function readFromCompactionOffset(
  sessionPath: string,
  byteOffset: number
): Promise<{
  messages: IndustryDroolMessage[];
  latestCompaction: CompactionStateEvent | null;
  secondToLastCompaction: CompactionStateEvent | null;
}> {
  const stream = fs.createReadStream(sessionPath, { start: byteOffset });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const messages: IndustryDroolMessage[] = [];
  let latestCompaction: CompactionStateEvent | null = null;
  let secondToLastCompaction: CompactionStateEvent | null = null;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as DroolSessionEvent;
        if (event.type === 'compaction_state') {
          secondToLastCompaction = latestCompaction;
          latestCompaction = event as CompactionStateEvent;
        } else if (event.type === 'message') {
          messages.push(
            convertMessageEventToIndustryDroolMessage(event as DroolMessageEvent)
          );
        }
      } catch {
        // skip malformed lines
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { messages, latestCompaction, secondToLastCompaction };
}

/**
 * Inner fast-path: returns a CompactionTruncatedResult when truncation
 * is possible, or null to signal that the caller should do a full read.
 */
async function readWithCompactionFastPath(
  sessionPath: string
): Promise<CompactionTruncatedResult | null> {
  const compactionOffsets = await findCompactionByteOffsets(sessionPath);
  if (compactionOffsets.length < 2) return null;

  const sessionMetadata = await readSessionStart(sessionPath);

  const MIN_MESSAGES_AFTER_TRUNCATION = 200;
  let seekIndex = Math.max(0, compactionOffsets.length - 2);
  let result = await readFromCompactionOffset(
    sessionPath,
    compactionOffsets[seekIndex].byteOffset
  );

  while (
    result.messages.length < MIN_MESSAGES_AFTER_TRUNCATION &&
    seekIndex > 0
  ) {
    seekIndex--;
    result = await readFromCompactionOffset(
      sessionPath,
      compactionOffsets[seekIndex].byteOffset
    );
  }

  if (result.messages.length < MIN_MESSAGES_AFTER_TRUNCATION) return null;

  const startOffset = compactionOffsets[seekIndex].byteOffset;

  logInfo('[sessionJsonl] Loaded session with compaction truncation', {
    count: compactionOffsets.length,
    index: startOffset,
    currentCount: seekIndex,
    messageCount: result.messages.length,
  });

  return {
    sessionMetadata,
    messages: result.messages,
    latestCompaction: result.latestCompaction,
    secondToLastCompaction: result.secondToLastCompaction,
    wasTruncated: true,
  };
}

/**
 * Compaction-aware session reader.
 *
 * Uses ripgrep to find byte offsets of compaction_state lines, then reads
 * only from the second-to-last compaction onward using
 * fs.createReadStream({ start: byteOffset }). The session_start metadata
 * is always read from the first line separately.
 *
 * Falls back to the full reader when:
 * - ripgrep is unavailable
 * - the file has fewer than 2 compaction events
 * - a targetMessageId is specified (needs full scan)
 */
export async function readSessionWithCompactionTruncation(
  options: ReadSessionJsonlOptions
): Promise<CompactionTruncatedResult> {
  const { sessionPath, targetMessageId } = options;

  if (!fs.existsSync(sessionPath)) {
    throw new MetaError('Session file not found', { filePath: sessionPath });
  }

  // When a targetMessageId is specified we must scan the whole file
  if (targetMessageId) {
    const full = await readSessionSummaryAndMessagesFromJsonl(options);
    return {
      sessionMetadata: full.sessionMetadata,
      messages: full.messages,
      latestCompaction: null,
      secondToLastCompaction: null,
      wasTruncated: false,
    };
  }

  // Attempt the fast path (ripgrep + partial read). If anything goes wrong
  // (bad byte offsets, corrupted stream, ripgrep failure, etc.) fall back
  // to the full sequential reader which is always correct.
  try {
    const truncated = await readWithCompactionFastPath(sessionPath);
    if (truncated) return truncated;
  } catch (error) {
    logWarn(
      '[sessionJsonl] Compaction fast-path failed, falling back to full read',
      { cause: error }
    );
  }

  const full = await readSessionSummaryAndMessagesFromJsonl(options);
  return {
    sessionMetadata: full.sessionMetadata,
    messages: full.messages,
    latestCompaction: null,
    secondToLastCompaction: null,
    wasTruncated: false,
  };
}
