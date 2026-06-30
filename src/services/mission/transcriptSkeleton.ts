import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import type {
  DroolMessageEvent,
  LocallyPersistedDroolMessage,
} from '@/services/types';

const STRING_TRUNCATE_THRESHOLD = 200;
const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Strip <system-reminder>...</system-reminder> blocks from text.
 * These are injected system content that shouldn't appear in the skeleton.
 */
function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_REGEX, '').trim();
}

interface ToolCall {
  name: string;
  params: Record<string, unknown>;
}

/**
 * Recursively truncate long string values in an object.
 * Short strings (like file paths) are preserved.
 * Long strings (like file contents) are replaced with "[N chars]".
 */
function truncateValue(value: unknown, threshold: number): unknown {
  if (typeof value === 'string') {
    return value.length > threshold ? `[${value.length} chars]` : value;
  }

  if (Array.isArray(value)) {
    if (value.length > 10) {
      return `[array: ${value.length} items]`;
    }
    return value.map((item) => truncateValue(item, threshold));
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = truncateValue(v, threshold);
    }
    return result;
  }

  return value;
}

function extractTextContent(
  content: LocallyPersistedDroolMessage['content']
): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === MessageContentBlockType.Text &&
        'text' in part
      ) {
        parts.push(String(part.text));
      }
    }
    return parts.join('\n');
  }

  return '';
}

function extractToolCalls(
  content: LocallyPersistedDroolMessage['content']
): ToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const part of content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === MessageContentBlockType.ToolUse &&
      'name' in part &&
      'input' in part
    ) {
      toolCalls.push({
        name: part.name,
        params: part.input,
      });
    }
  }

  return toolCalls;
}

function extractToolResultContent(
  content: LocallyPersistedDroolMessage['content']
): { isToolResult: boolean; text: string } {
  if (!Array.isArray(content)) {
    return { isToolResult: false, text: '' };
  }

  for (const part of content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === MessageContentBlockType.ToolResult
    ) {
      // Extract text from tool result content
      const resultContent = (part as { content?: unknown }).content;
      if (typeof resultContent === 'string') {
        return { isToolResult: true, text: resultContent };
      }
      if (Array.isArray(resultContent)) {
        const textParts: string[] = [];
        for (const item of resultContent) {
          if (
            typeof item === 'object' &&
            item !== null &&
            'type' in item &&
            item.type === MessageContentBlockType.Text &&
            'text' in item
          ) {
            textParts.push(String(item.text));
          }
        }
        return { isToolResult: true, text: textParts.join('\n') };
      }
      return { isToolResult: true, text: '' };
    }
  }

  return { isToolResult: false, text: '' };
}

/**
 * Generates a condensed "skeleton" of a worker session transcript.
 *
 * The skeleton includes:
 * - Assistant text (reasoning/explanations)
 * - User messages (but NOT system messages)
 * - Tool calls with truncated params (long strings replaced with char count)
 * - Placeholders for tool results
 *
 * This allows validators to verify worker claims against actual tool usage
 * without the bulk of file contents.
 */
export function generateTranscriptSkeleton(
  messageEvents: DroolMessageEvent[],
  threshold: number = STRING_TRUNCATE_THRESHOLD
): string {
  const lines: string[] = [];
  let skippedFirstUserMessage = false;

  for (const event of messageEvents) {
    const { message } = event;
    if (!message) continue;

    const { role } = message;

    // Skip the first user message (bootstrap/startup message)
    if (role === MessageRole.User && !skippedFirstUserMessage) {
      skippedFirstUserMessage = true;
      continue;
    }

    if (role === MessageRole.Assistant) {
      const text = extractTextContent(message.content);
      if (text) {
        lines.push('## Assistant');
        lines.push(text);
        lines.push('');
      }

      const toolCalls = extractToolCalls(message.content);
      for (const toolCall of toolCalls) {
        lines.push(`## Tool: ${toolCall.name}`);
        const truncatedParams = truncateValue(toolCall.params, threshold);
        lines.push(JSON.stringify(truncatedParams, null, 2));
        lines.push('');
      }
    } else if (role === MessageRole.User) {
      const toolResult = extractToolResultContent(message.content);
      if (toolResult.isToolResult) {
        if (toolResult.text.length > 0 && toolResult.text.length <= threshold) {
          lines.push('## Tool Result');
          lines.push(toolResult.text);
          lines.push('');
        } else {
          lines.push(`[tool_result: ${toolResult.text.length} chars]`);
          lines.push('');
        }
      } else {
        const rawText = extractTextContent(message.content);
        const text = stripSystemReminders(rawText);
        if (text) {
          lines.push('## User');
          lines.push(text);
          lines.push('');
        }
      }
    }
  }

  return lines.join('\n').trim();
}
