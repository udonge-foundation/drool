import equal from 'fast-deep-equal';

import {
  ToolExecutionRenderStatus,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

const DEFAULT_MAX_TEXT_LENGTH = 500;

function truncateSessionText(
  text: string,
  maxLength = DEFAULT_MAX_TEXT_LENGTH
): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function parseRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function stringifySessionToolInput(input: unknown): string {
  const values = parseRecord(input);
  if (!values) return '';
  if (typeof values.command === 'string') return `$ ${values.command}`;
  if (typeof values.summary === 'string') return values.summary;
  if (typeof values.file_path === 'string') return values.file_path;
  return truncateSessionText(JSON.stringify(values), 180);
}

function extractSessionToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = parseRecord(block);
      if (!record) return '';
      if (record.type === MessageContentBlockType.Text) {
        return typeof record.text === 'string' ? record.text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractSessionMessageText(message: IndustryDroolMessage): string {
  return message.content
    .map((block) => {
      if (block.type === MessageContentBlockType.Text) return block.text;
      if (block.type === MessageContentBlockType.Thinking) {
        return block.thinking;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function sessionMessageHasToolUse(message: IndustryDroolMessage): boolean {
  return message.content.some(
    (block) => block.type === MessageContentBlockType.ToolUse
  );
}

export function areToolStreamingUpdatesEqual(
  left: ToolStreamingUpdate,
  right: ToolStreamingUpdate
): boolean {
  const { timestamp: _lt, ...leftRest } = left;
  const { timestamp: _rt, ...rightRest } = right;
  return equal(leftRest, rightRest);
}

export function isToolExecutionInProgress(
  status: ToolExecutionRenderStatus | undefined
): boolean {
  return (
    status === ToolExecutionRenderStatus.Streaming ||
    status === ToolExecutionRenderStatus.Pending ||
    status === ToolExecutionRenderStatus.Executing
  );
}

export function getLatestStatusUpdateWithText(
  updates: ToolStreamingUpdate[]
): ToolStreamingUpdate | undefined {
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i];
    if (update.type === 'status' && update.text) {
      return update;
    }
  }
  return undefined;
}

export function getStreamingOutputText(
  updates: ToolStreamingUpdate[]
): string | undefined {
  const latestStatusUpdate = getLatestStatusUpdateWithText(updates);
  if (!latestStatusUpdate) {
    return undefined;
  }

  return latestStatusUpdate.fullOutput || latestStatusUpdate.text;
}

export function formatToolProgressDetails(
  details: string | undefined,
  maxLength = 60
): string | undefined {
  if (!details) {
    return undefined;
  }

  if (details.length <= maxLength) {
    return details;
  }

  const match = details.match(/([^/\\]+)$/);
  if (match && match[1].length + 4 < details.length) {
    return `.../${match[1]}`;
  }

  return `${details.substring(0, maxLength - 3)}...`;
}

export function buildTaskToolProgressEntries(
  updates: ToolStreamingUpdate[]
): Array<{
  toolName: string;
  details: string;
  status: 'running' | 'complete' | 'error';
  timestamp: number;
}> {
  const entries: Array<{
    toolName: string;
    details: string;
    status: 'running' | 'complete' | 'error';
    timestamp: number;
  }> = [];
  const entryIndexByKey = new Map<string, number>();

  for (const update of updates) {
    if (!update.toolName) {
      continue;
    }

    const details = formatToolProgressDetails(update.details);
    const key = `${update.toolName}:${update.details ?? ''}`;
    const status: 'running' | 'complete' | 'error' =
      update.type === 'error' || update.status === 'error'
        ? 'error'
        : update.type === 'tool_result' || update.status === 'completed'
          ? 'complete'
          : 'running';

    const existingIndex = entryIndexByKey.get(key);
    if (existingIndex !== undefined) {
      entries[existingIndex] = {
        ...entries[existingIndex],
        status,
        timestamp: update.timestamp ?? entries[existingIndex].timestamp,
      };
      continue;
    }

    entryIndexByKey.set(key, entries.length);
    entries.push({
      toolName: update.toolName,
      details: details ?? '',
      status,
      timestamp: update.timestamp ?? entries.length,
    });
  }

  return entries;
}

export function buildSessionToolProgressUpdates(
  messages: IndustryDroolMessage[],
  options: { maxUpdates?: number; maxTextLength?: number } = {}
): ToolStreamingUpdate[] {
  const updates: ToolStreamingUpdate[] = [];
  const toolNamesById = new Map<string, string>();
  for (const message of messages) {
    const timestamp = message.updatedAt || message.createdAt || Date.now();
    for (const block of message.content) {
      if (
        message.role === MessageRole.Assistant &&
        block.type === MessageContentBlockType.ToolUse
      ) {
        toolNamesById.set(block.id, block.name);
        updates.push({
          type: 'tool_call',
          toolName: block.name,
          status: 'running',
          text: block.name,
          details: stringifySessionToolInput(block.input),
          parameters: block.input,
          timestamp,
        });
      } else if (
        message.role === MessageRole.Assistant &&
        block.type === MessageContentBlockType.Text
      ) {
        const messageText = truncateSessionText(
          block.text,
          options.maxTextLength
        );
        if (messageText) {
          updates.push({
            type: 'message',
            text: messageText,
            details: messageText,
            timestamp,
          });
        }
      } else if (block.type === MessageContentBlockType.ToolResult) {
        const details = truncateSessionText(
          extractSessionToolResultText(block.content),
          options.maxTextLength
        );
        if (details) {
          updates.push({
            type: 'tool_result',
            toolName: toolNamesById.get(block.toolUseId) ?? block.toolUseId,
            status: block.isError ? 'error' : 'completed',
            text: details,
            details,
            timestamp,
          });
        }
      }
    }
  }

  return options.maxUpdates ? updates.slice(-options.maxUpdates) : updates;
}

export function getLatestSessionAssistantText(
  messages: IndustryDroolMessage[]
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== MessageRole.Assistant) continue;
    if (sessionMessageHasToolUse(message)) continue;

    const text = extractSessionMessageText(message).trim();
    if (text) return text;
  }

  return '';
}
