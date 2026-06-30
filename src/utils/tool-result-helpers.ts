import {
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
} from '@industry/drool-sdk-ext/protocol/drool';

import type { ToolResultContent } from '@/hooks/types';
import { isStringResult } from '@/utils/isStringResult';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

/**
 * Remove system-reminder blocks from text content
 */
function stripSystemReminders(text: string): string {
  let result = text;
  let startIdx = result.indexOf(SYSTEM_REMINDER_START);
  while (startIdx !== -1) {
    const endIdx = result.indexOf(SYSTEM_REMINDER_END, startIdx);
    if (endIdx === -1) {
      // No closing tag, remove everything from start tag onwards
      result = result.slice(0, startIdx).trimEnd();
      break;
    }
    // Remove the entire block including tags
    result =
      result.slice(0, startIdx) +
      result.slice(endIdx + SYSTEM_REMINDER_END.length);
    startIdx = result.indexOf(SYSTEM_REMINDER_START);
  }
  return result.trim();
}

/**
 * Safely extract text content from a tool result
 * Handles both string results and content block arrays
 * Filters out system-reminder blocks that are meant only for the LLM
 * Shows placeholder text for images in the display
 */
export function getTextContent(result: ToolResultContent | undefined): string {
  if (!result) return '';

  if (isStringResult(result)) {
    return stripSystemReminders(result);
  }

  // It's an array of content blocks - process each block
  const displayParts = result.map((block) => {
    if (block.type === 'text') {
      return 'text' in block ? block.text : '';
    }
    if (block.type === 'image') {
      // Show placeholder for images in UI display
      const mediaType =
        'source' in block && block.source ? block.source.mediaType : 'unknown';
      return `[Image: ${mediaType}]`;
    }
    return '';
  });

  const combinedText = displayParts.filter((part) => part).join('\n');
  return stripSystemReminders(combinedText);
}

type JsonDisplayContainer = Record<string, unknown> | unknown[];

function isJsonDisplayContainer(value: unknown): value is JsonDisplayContainer {
  return (
    Array.isArray(value) ||
    (value !== null && typeof value === 'object' && !Array.isArray(value))
  );
}

function formatJsonScalarForMarkdown(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = value.replaceAll('\r\n', '\n');
    return normalized.includes('\n')
      ? normalized.replaceAll('\n', '\\n')
      : normalized;
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value) ?? String(value);
}

function indentMarkdownLines(value: string): string {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatJsonValueAsMarkdown(value: JsonDisplayContainer): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }

    return value
      .map((item, index) =>
        isJsonDisplayContainer(item)
          ? `* ${index + 1}:\n${indentMarkdownLines(formatJsonValueAsMarkdown(item))}`
          : `* ${formatJsonScalarForMarkdown(item)}`
      )
      .join('\n');
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return '{}';
  }

  return entries
    .map(([key, nestedValue]) =>
      isJsonDisplayContainer(nestedValue)
        ? `* ${key}:\n${indentMarkdownLines(formatJsonValueAsMarkdown(nestedValue))}`
        : `* ${key}: ${formatJsonScalarForMarkdown(nestedValue)}`
    )
    .join('\n');
}

/**
 * Convert a JSON object/array result string into a markdown bullet list for UI
 * rendering. Returns `undefined` when the value is not a JSON object/array (so
 * callers fall back to the raw text path). String scalars keep newlines inline
 * as literal `\n` so multi-line values do not break the bullet structure.
 *
 * The rendered markdown is sanitized before return: `JSON.parse` turns escaped
 * terminal-control text (e.g. `\u001b]52;…`) back into real OSC/CSI bytes, so
 * sanitizing only the raw input upstream is not enough to keep them out of the
 * Ink-rendered output. Connector/MCP JSON values are untrusted display content,
 * so SGR sequences are also stripped (`stripSgr`) to defeat conceal-based
 * spoofing (e.g. `\x1b[8m...`) that the default sanitizer would preserve.
 */
export function formatJsonResultAsMarkdown(value: string): string | undefined {
  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith('{') && !trimmedValue.startsWith('[')) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmedValue);
    if (!isJsonDisplayContainer(parsed)) {
      return undefined;
    }

    return sanitizeTerminalDisplayText(formatJsonValueAsMarkdown(parsed), {
      stripSgr: true,
    });
  } catch {
    return undefined;
  }
}
