import {
  type ContentBlock,
  type DocumentBlock,
  DocumentSourceType,
  type IndustryDroolMessage,
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import type {
  DroolMessageEvent,
  LocallyPersistedDocumentBlock,
  LocallyPersistedDroolMessage,
  LocallyPersistedImageBlock,
  LocallyPersistedRedactedThinkingBlock,
  LocallyPersistedTextBlock,
  LocallyPersistedThinkingBlock,
  LocallyPersistedToolResultBlock,
  LocallyPersistedToolUseBlock,
} from './types';

// ---------------------------------------------------------------------------
// Internal helpers – snake_case (persisted) → camelCase (ContentBlock)
// ---------------------------------------------------------------------------

const convertLocallyPersistedTextBlock = (
  block: LocallyPersistedTextBlock
): Extract<ContentBlock, { type: 'text' }> => {
  const result: Extract<ContentBlock, { type: 'text' }> = {
    type: MessageContentBlockType.Text,
    text: block.text,
  };

  if (block.id !== undefined) {
    result.id = block.id;
  }

  return result;
};

const convertLocallyPersistedImageBlock = (
  block: LocallyPersistedImageBlock
): Extract<ContentBlock, { type: 'image' }> => {
  const result: Extract<ContentBlock, { type: 'image' }> = {
    type: MessageContentBlockType.Image,
    source: {
      type: 'base64',
      data: block.source.data,
      mediaType: block.source.media_type,
    },
  };

  if (block.id !== undefined) {
    result.id = block.id;
  }

  return result;
};

const convertLocallyPersistedThinkingBlock = (
  block: LocallyPersistedThinkingBlock
): Extract<ContentBlock, { type: 'thinking' }> => {
  const result: Extract<ContentBlock, { type: 'thinking' }> = {
    type: MessageContentBlockType.Thinking,
    thinking: block.thinking,
    signature: block.signature,
    ...(block.signatureProvider && {
      signatureProvider: block.signatureProvider,
    }),
    ...(block.durationMs !== undefined && {
      durationMs: block.durationMs,
    }),
  };

  if (block.id !== undefined) {
    result.id = block.id;
  }

  return result;
};

const convertLocallyPersistedRedactedThinkingBlock = (
  block: LocallyPersistedRedactedThinkingBlock
): Extract<ContentBlock, { type: 'redacted_thinking' }> => {
  const result: Extract<ContentBlock, { type: 'redacted_thinking' }> = {
    type: MessageContentBlockType.RedactedThinking,
    data: block.data,
  };

  if (block.id !== undefined) {
    result.id = block.id;
  }

  return result;
};

type ToolResultConvertibleBlock =
  | LocallyPersistedTextBlock
  | LocallyPersistedImageBlock;

const convertLocallyPersistedToolResultContentBlock = (
  block: ToolResultConvertibleBlock
):
  | Extract<ContentBlock, { type: 'text' }>
  | Extract<ContentBlock, { type: 'image' }> => {
  switch (block.type) {
    case 'text':
      return convertLocallyPersistedTextBlock(block);
    case 'image':
      return convertLocallyPersistedImageBlock(block);
    default: {
      const exhaustiveCheck: never = block;
      return exhaustiveCheck;
    }
  }
};

const convertLocallyPersistedToolUseBlock = (
  block: LocallyPersistedToolUseBlock
): Extract<ContentBlock, { type: 'tool_use' }> => ({
  type: MessageContentBlockType.ToolUse,
  id: block.id,
  input: block.input,
  name: block.name === 'MultiEdit' ? 'Edit' : block.name,
  ...(block.thought_signature
    ? { thoughtSignature: block.thought_signature }
    : {}),
});

const convertLocallyPersistedToolResultBlock = (
  block: LocallyPersistedToolResultBlock
): Extract<ContentBlock, { type: 'tool_result' }> => {
  const result: Extract<ContentBlock, { type: 'tool_result' }> = {
    type: MessageContentBlockType.ToolResult,
    toolUseId: block.tool_use_id,
  };

  if (block.id !== undefined) {
    result.id = block.id;
  }

  if (block.is_error !== undefined) {
    result.isError = block.is_error;
  }

  if (block.content !== undefined) {
    result.content =
      typeof block.content === 'string'
        ? block.content
        : block.content.map((innerBlock) =>
            convertLocallyPersistedToolResultContentBlock(innerBlock)
          );
  }

  return result;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts locally-persisted (snake_case) message content to the in-memory
 * camelCase `ContentBlock[]` representation used throughout the application.
 *
 * Handles all block types: text, image, thinking, redacted_thinking, tool_use,
 * tool_result, and document.  Also renames the legacy "MultiEdit" tool to "Edit".
 */
// eslint-disable-next-line no-restricted-syntax -- co-located with the JSONL types it converts
export function convertLocallyPersistedMessageContentToDroolMessageContent(
  content: LocallyPersistedDroolMessage['content']
): ContentBlock[] {
  if (typeof content === 'string') {
    return [
      {
        type: MessageContentBlockType.Text,
        text: content,
      },
    ];
  }

  return content.map((block) => {
    switch (block.type) {
      case 'text':
        return convertLocallyPersistedTextBlock(block);
      case 'image':
        return convertLocallyPersistedImageBlock(block);
      case 'thinking':
        return convertLocallyPersistedThinkingBlock(block);
      case 'redacted_thinking':
        return convertLocallyPersistedRedactedThinkingBlock(block);
      case 'tool_use':
        return convertLocallyPersistedToolUseBlock(block);
      case 'tool_result':
        return convertLocallyPersistedToolResultBlock(block);
      case 'document': {
        // Convert locally persisted document block back to DocumentBlock
        const docBlock: LocallyPersistedDocumentBlock = block;
        const result: DocumentBlock =
          docBlock.source.media_type === 'application/pdf'
            ? {
                type: MessageContentBlockType.Document,
                source: {
                  type: DocumentSourceType.Base64,
                  mediaType: 'application/pdf',
                  data: docBlock.source.data ?? '',
                  parsedData:
                    'parsed_data' in docBlock.source
                      ? docBlock.source.parsed_data
                      : undefined,
                  name: docBlock.source.name,
                  path: docBlock.source.path,
                },
              }
            : {
                type: MessageContentBlockType.Document,
                source: {
                  type: DocumentSourceType.Text,
                  mediaType: 'text/plain',
                  data: docBlock.source.data ?? '',
                  name: docBlock.source.name,
                  mime:
                    'mime' in docBlock.source
                      ? docBlock.source.mime
                      : undefined,
                },
              };
        return result;
      }
      default: {
        const exhaustiveCheck: never = block;
        return exhaustiveCheck;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers for convertMessageEventToIndustryDroolMessage
// ---------------------------------------------------------------------------

function hasToolResultsInLocallyPersistedContent(
  content: LocallyPersistedDroolMessage['content']
): boolean {
  if (typeof content === 'string') return false;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => typeof block !== 'string' && block.type === 'tool_result'
  );
}

/**
 * Converts a `DroolMessageEvent` (a single JSONL message line) into a
 * `IndustryDroolMessage`, performing:
 *
 * - snake_case → camelCase content block conversion
 * - Role normalisation: `User` messages whose content consists of
 *   `tool_result` blocks are re-mapped to `MessageRole.Tool`
 * - Legacy "MultiEdit" → "Edit" tool rename
 */
// eslint-disable-next-line no-restricted-syntax -- co-located with the JSONL types it converts
export function convertMessageEventToIndustryDroolMessage(
  event: DroolMessageEvent
): IndustryDroolMessage {
  const timestamp = new Date(event.timestamp).getTime();

  const isToolMessage =
    event.message.role === MessageRole.User &&
    hasToolResultsInLocallyPersistedContent(event.message.content);

  return {
    id: event.id,
    parentId: event.parentId,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...event.message,
    ...(isToolMessage ? { role: MessageRole.Tool } : {}),
    content: convertLocallyPersistedMessageContentToDroolMessageContent(
      event.message.content
    ),
  };
}
