/**
 * Utility module for discovering and identifying subagent sessions,
 * and parsing subagent transcripts to extract activity items.
 *
 * Subagent sessions are spawned by the Task tool and write their own JSONL
 * transcript files. The first line of each file is a `session_start` event
 * that contains a `callingToolUseId` linking back to the parent Task tool_use
 * block that spawned the subagent.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import { SubagentState } from '@/components/mission-control/enums';
import type {
  SessionEndData,
  SubagentActivityItem,
  SubagentSessionInfo,
  SubagentStateInput,
  SubagentStats,
  SubagentStatsInput,
  SubagentTranscriptResult,
} from '@/components/mission-control/types';
import { getCompactToolParams } from '@/components/mission-control/utils/compactToolParams';
import { formatDurationCompact } from '@/utils/format';

/** Tool name used by the Task tool for spawning subagents */
const TASK_TOOL_NAME = 'Task';

/** Cache discovered subagent transcript file paths across all callers */
const discoveredSubagentSessionPaths = new Map<string, string>();

/** Preserve session IDs for O(1) cache hits without reopening transcript files */
const discoveredSubagentSessionIds = new Map<string, string>();

/**
 * Cache misses briefly so concurrent 500ms pollers do not rescan the entire
 * sessions directory when a subagent transcript has not appeared yet.
 */
const missingSubagentSessionUntil = new Map<string, number>();

const MISSING_SUBAGENT_SESSION_TTL_MS = 1_000;

function clearCachedSubagentSession(toolUseId: string): void {
  discoveredSubagentSessionPaths.delete(toolUseId);
  discoveredSubagentSessionIds.delete(toolUseId);
}

function getCachedSubagentSession(
  toolUseId: string
): SubagentSessionInfo | null | undefined {
  const filePath = discoveredSubagentSessionPaths.get(toolUseId);
  if (!filePath) {
    return undefined;
  }

  if (!fs.existsSync(filePath)) {
    clearCachedSubagentSession(toolUseId);
    return undefined;
  }

  return {
    sessionId:
      discoveredSubagentSessionIds.get(toolUseId) ??
      path.basename(filePath, '.jsonl'),
    filePath,
  };
}

function cacheSubagentSession(
  toolUseId: string,
  sessionInfo: SubagentSessionInfo
): void {
  discoveredSubagentSessionPaths.set(toolUseId, sessionInfo.filePath);
  discoveredSubagentSessionIds.set(toolUseId, sessionInfo.sessionId);
  missingSubagentSessionUntil.delete(toolUseId);
}

function hasFreshNegativeCache(toolUseId: string, now: number): boolean {
  const cachedUntil = missingSubagentSessionUntil.get(toolUseId);
  if (cachedUntil === undefined) {
    return false;
  }

  if (cachedUntil > now) {
    return true;
  }

  missingSubagentSessionUntil.delete(toolUseId);
  return false;
}

export function resetSubagentSessionDiscoveryCacheForTests(): void {
  discoveredSubagentSessionPaths.clear();
  discoveredSubagentSessionIds.clear();
  missingSubagentSessionUntil.clear();
}

/**
 * Discover a subagent session JSONL file by scanning a sessions directory
 * for a file whose `session_start` event has a `callingToolUseId` matching
 * the given Task tool_use ID.
 *
 * @param toolUseId - The `id` of the Task tool_use content block in the parent transcript
 * @param sessionsDir - Absolute path to the sessions directory to scan
 * @returns The matching subagent session info, or null if not found
 */
export function discoverSubagentSession(
  toolUseId: string,
  sessionsDir: string
): SubagentSessionInfo | null {
  const cachedSessionInfo = getCachedSubagentSession(toolUseId);
  if (cachedSessionInfo) {
    return cachedSessionInfo;
  }

  const now = Date.now();
  if (hasFreshNegativeCache(toolUseId, now)) {
    return null;
  }

  // Handle missing directory gracefully
  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir) as string[];
  } catch {
    // Permission denied or other read error — return null without crashing
    return null;
  }

  for (const entry of entries) {
    // Only process .jsonl files (skip .settings.json, .txt, etc.)
    if (!entry.endsWith('.jsonl')) {
      continue;
    }

    const filePath = path.join(sessionsDir, entry);

    try {
      // Read only the first ~4KB of the file to extract the first line.
      // JSONL session_start lines are well under 4KB, so this avoids
      // pulling multi-MB transcript files into memory.
      const fd = fs.openSync(filePath, 'r');
      let firstLine: string;
      try {
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const head = buf.toString('utf-8', 0, bytesRead);
        const firstNewline = head.indexOf('\n');
        firstLine = firstNewline >= 0 ? head.slice(0, firstNewline) : head;
      } finally {
        fs.closeSync(fd);
      }

      if (!firstLine.trim()) {
        continue;
      }

      const parsed = JSON.parse(firstLine) as {
        type?: string;
        id?: string;
        callingToolUseId?: string;
      };

      if (
        parsed.type === 'session_start' &&
        parsed.callingToolUseId === toolUseId
      ) {
        const sessionInfo = {
          sessionId: parsed.id ?? entry.replace(/\.jsonl$/, ''),
          filePath,
        };
        cacheSubagentSession(toolUseId, sessionInfo);
        return sessionInfo;
      }
    } catch {
      // Malformed file or read error — skip without crashing
      continue;
    }
  }

  missingSubagentSessionUntil.set(
    toolUseId,
    now + MISSING_SUBAGENT_SESSION_TTL_MS
  );
  return null;
}

/**
 * Check if a tool_use content block is a Task tool invocation (subagent spawn).
 *
 * @param toolName - The `name` field from the tool_use content block
 * @returns true if the tool is the Task tool, false otherwise
 */
export function isTaskToolUse(toolName: string): boolean {
  return toolName === TASK_TOOL_NAME;
}

// ---------------------------------------------------------------------------
// Subagent Transcript Parsing
// ---------------------------------------------------------------------------

/** Maximum bytes to read from the end of a subagent transcript for tail reading */
const MAX_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024; // 2MB

/** Upper bound when backing up to find a newline boundary in very large files */
const MAX_TRANSCRIPT_TAIL_BYTES_CAP = 8 * 1024 * 1024; // 8MB

/** Maximum number of non-empty lines to parse from the tail */
const MAX_TRANSCRIPT_TAIL_LINES = 10_000;

/** Avoid blocking JSON.parse on extremely large single-line events */
const MAX_LINE_LENGTH_TO_PARSE = 200_000;

/**
 * Read the tail portion of a file as text.
 * For files smaller than maxBytes, reads the entire file.
 * For larger files, reads the last maxBytes and skips the first partial line.
 */
async function readFileTailText(
  filePath: string,
  initialMaxBytes: number
): Promise<string> {
  const stat = await fsp.stat(filePath);
  const size = stat.size;
  const start = Math.max(0, size - initialMaxBytes);
  const length = size - start;

  if (length <= 0) return '';

  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf-8');

    if (start === 0) {
      return text;
    }

    // We started mid-file — skip the first partial line
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0 && firstNewline + 1 < text.length) {
      return text.slice(firstNewline + 1);
    }

    // Landed inside a very large single line; back up further (bounded)
    if (initialMaxBytes >= MAX_TRANSCRIPT_TAIL_BYTES_CAP) {
      return '';
    }

    return readFileTailText(
      filePath,
      Math.min(MAX_TRANSCRIPT_TAIL_BYTES_CAP, initialMaxBytes * 2)
    );
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Task Param Summary
// ---------------------------------------------------------------------------

/**
 * Format a Task tool_use input as 'subagent_type: description'.
 *
 * @param input — the Task tool_use input params
 * @returns Formatted summary string (e.g., 'worker: build feature')
 */
export function getTaskParamSummary(input: Record<string, unknown>): string {
  const subagentType =
    typeof input.subagent_type === 'string' ? input.subagent_type : '';
  const description =
    typeof input.description === 'string' ? input.description : '';

  if (subagentType && description) {
    return `${subagentType}: ${description}`;
  }
  if (subagentType) {
    return subagentType;
  }
  if (description) {
    return description;
  }
  return '';
}

/**
 * Parse a subagent session JSONL file and extract activity items.
 *
 * Each activity item includes the tool name, a compact parameter summary,
 * and the timestamp from the parent DroolMessageEvent. Items are returned
 * in chronological order.
 *
 * Handles:
 * - Messages with multiple tool_use blocks (each becomes a separate item)
 * - Text-only messages (skipped)
 * - Empty / session-start-only files (returns empty list)
 * - Non-JSON lines (skipped gracefully)
 * - Partially written last lines (skipped)
 * - Large files (tail reading via MAX_TRANSCRIPT_TAIL_BYTES)
 *
 * @param filePath - Absolute path to the subagent's JSONL transcript file
 * @returns Activity items and optional session_end data
 */
export async function parseSubagentTranscript(
  filePath: string
): Promise<SubagentTranscriptResult> {
  let content: string;
  try {
    content = await readFileTailText(filePath, MAX_TRANSCRIPT_TAIL_BYTES);
  } catch {
    // File doesn't exist or can't be read — return empty result
    return { activityItems: [], sessionEnd: null };
  }

  if (!content) return { activityItems: [], sessionEnd: null };

  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-MAX_TRANSCRIPT_TAIL_LINES);

  const items: SubagentActivityItem[] = [];
  let sessionEnd: SessionEndData | null = null;

  for (const line of lines) {
    if (line.length > MAX_LINE_LENGTH_TO_PARSE) {
      continue;
    }

    let parsed: {
      type?: string;
      timestamp?: string;
      durationMs?: number;
      toolCount?: number;
      finalText?: string;
      message?: {
        role?: string;
        content?:
          | string
          | Array<{
              type?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
      };
    };

    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      // Non-JSON line or partially written line — skip gracefully
      continue;
    }

    // Detect session_end events
    if (parsed.type === 'session_end') {
      sessionEnd = {
        durationMs:
          typeof parsed.durationMs === 'number' ? parsed.durationMs : 0,
        toolCount: typeof parsed.toolCount === 'number' ? parsed.toolCount : 0,
        finalText: typeof parsed.finalText === 'string' ? parsed.finalText : '',
      };
      continue;
    }

    // Only process message events with assistant role
    if (parsed.type !== 'message') {
      continue;
    }

    const { message, timestamp } = parsed;
    if (!message || !timestamp) {
      continue;
    }

    if (message.role !== 'assistant') {
      continue;
    }

    const { content: messageContent } = message;
    if (!Array.isArray(messageContent)) {
      // String content = text-only message, skip
      continue;
    }

    // Extract tool_use blocks and create activity items
    for (const block of messageContent) {
      if (block.type === 'tool_use' && block.name) {
        const input = block.input || {};
        let paramSummary: string;

        if (block.name === TASK_TOOL_NAME) {
          // Task tool uses dedicated formatter: 'subagent_type: description'
          paramSummary = getTaskParamSummary(input);
        } else {
          paramSummary = getCompactToolParams(block.name, input);
          // Execute tool commands are prefixed with '$ '
          if (block.name === 'Execute' && paramSummary) {
            paramSummary = `$ ${paramSummary}`;
          }
        }

        items.push({
          toolName: block.name,
          paramSummary,
          timestamp,
        });
      }
    }
  }

  return { activityItems: items, sessionEnd };
}

/**
 * Parse a subagent session JSONL file and extract activity items.
 *
 * Convenience wrapper around `parseSubagentTranscript` that returns only
 * activity items (ignoring session_end data).
 *
 * @param filePath - Absolute path to the subagent's JSONL transcript file
 * @returns Activity items in chronological order
 */
export async function parseSubagentActivity(
  filePath: string
): Promise<SubagentActivityItem[]> {
  const result = await parseSubagentTranscript(filePath);
  return result.activityItems;
}

// ---------------------------------------------------------------------------
// State Detection
// ---------------------------------------------------------------------------

/**
 * Determine the current state of a subagent.
 *
 * State priority:
 * 1. `completed` — if parent transcript has tool_result for the Task tool_use.
 *    This is a terminal state and ALWAYS overrides other states.
 * 2. `live_activity` — if subagent JSONL has tool_use events and no tool_result
 *    exists in the parent transcript.
 * 3. `initializing` — if Task tool_use is executing but no subagent file/activity
 *    found yet.
 *
 * This is a pure function; parallel subagents are tracked independently by
 * calling it once per Task tool_use block with that block's specific data.
 *
 * @param input — subagent state input data
 * @returns The subagent state
 */
export function getSubagentState(input: SubagentStateInput): SubagentState {
  // Completed is always terminal — overrides everything
  if (input.hasToolResult) {
    return SubagentState.Completed;
  }

  // session_end means the subagent process exited — completed even without tool_result
  if (input.hasSessionEnd) {
    return SubagentState.Completed;
  }

  // Live activity when subagent has tool calls
  if (input.subagentSessionInfo && input.activityItems.length > 0) {
    return SubagentState.LiveActivity;
  }

  // No file or no activity yet — still initializing
  return SubagentState.Initializing;
}

// ---------------------------------------------------------------------------
// Derived Data
// ---------------------------------------------------------------------------

/**
 * Compute derived stats for a subagent.
 *
 * - `toolCount`: total tool_use content blocks (not unique tool names)
 * - `elapsedMs`: `Date.now() - taskToolUseTimestamp` when executing/initializing,
 *   or `toolResultTimestamp - taskToolUseTimestamp` when completed
 * - `formattedElapsed`: human-readable duration (e.g., '2m 34s')
 * - `formattedStats`: 'N tools · Xm Ys' with correct pluralization and · separator
 * - `activityItems`: pass-through of the input activity items
 *
 * @param input — stats input data
 * @returns Computed subagent stats
 */
export function computeSubagentStats(input: SubagentStatsInput): SubagentStats {
  const {
    activityItems,
    taskToolUseTimestamp,
    toolResultTimestamp,
    state,
    sessionEnd,
  } = input;

  const toolCount = activityItems.length;

  // Compute elapsed time
  let elapsedMs: number;
  const startMs = new Date(taskToolUseTimestamp).getTime();

  if (state === SubagentState.Completed && toolResultTimestamp) {
    // Fixed duration when completed via parent tool_result
    const endMs = new Date(toolResultTimestamp).getTime();
    elapsedMs = endMs - startMs;
  } else if (
    state === SubagentState.Completed &&
    sessionEnd &&
    sessionEnd.durationMs > 0
  ) {
    // Fixed duration when completed via session_end (no parent tool_result yet)
    elapsedMs = sessionEnd.durationMs;
  } else {
    // Ticking duration when executing or initializing
    elapsedMs = Date.now() - startMs;
  }

  // Ensure non-negative
  elapsedMs = Math.max(0, elapsedMs);

  const formattedElapsed = formatDurationCompact(elapsedMs);

  // Pluralize: '1 tool' vs 'N tools'
  const toolLabel = toolCount === 1 ? '1 tool' : `${toolCount} tools`;
  const formattedStats = `${toolLabel} · ${formattedElapsed}`;

  return {
    toolCount,
    elapsedMs,
    formattedElapsed,
    formattedStats,
    activityItems,
  };
}

// ---------------------------------------------------------------------------
// Recent Activity Items
// ---------------------------------------------------------------------------

/**
 * Return the last N activity items in chronological order.
 *
 * @param items — all activity items (already in chronological order)
 * @param n — maximum number of items to return
 * @returns The last N items, preserving chronological order
 */
export function getRecentActivityItems(
  items: SubagentActivityItem[],
  n: number
): SubagentActivityItem[] {
  if (n <= 0) return [];
  return items.slice(-n);
}

// ---------------------------------------------------------------------------
// Timestamp Formatting
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 timestamp or epoch number as HH:MM:SS in 24-hour local time.
 * Zero-pads hours, minutes, and seconds.
 *
 * @param timestamp — ISO 8601 string or epoch milliseconds
 * @returns Formatted time string (e.g., '14:32:01')
 */
export function formatTimestamp(timestamp: string | number): string {
  const date = new Date(timestamp);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
