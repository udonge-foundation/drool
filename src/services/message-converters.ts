import Anthropic from '@anthropic-ai/sdk';
/**
 * CLI-local message conversion helpers. Follow-up PRs should relocate:
 *   - Anthropic provider converter + streaming-block converter → drool-core
 *   - LocallyPersisted forward converter → `@industry/common/session/jsonl`
 * The PDF helpers stay here (disk-backed, CLI-only).
 */

import { ANTHROPIC_TOOL_NAME_MAX_LENGTH } from '@industry/drool-core/llms/client/constants';
import { StreamingContentBlockType } from '@industry/drool-core/llms/client/enums';
import { sanitizeToolNameForProvider } from '@industry/drool-core/llms/client/tool-call-ids';
import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import {
  type ContentBlock,
  type DocumentBlock,
  DocumentSourceType,
  type IndustryDroolMessage,
  type IndustryDroolMessageWithCaching,
  MessageContentBlockType,
  type RedactedThinkingBlock,
  type ToolUseBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import { populatePdfDataFromDisk } from '@/services/populatePdfDataFromDisk';
import type {
  LocallyPersistedDocumentBlock,
  LocallyPersistedDroolMessage,
  LocallyPersistedImageBlock,
  LocallyPersistedTextBlock,
  LocallyPersistedToolResultBlock,
  LocallyPersistedToolUseBlock,
} from '@/services/types';
import { sanitizeToolCallId } from '@/utils/toolCallIdSanitization';

import type {
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  StreamingContentBlock,
  ToolUse,
} from '@industry/drool-core/llms/client/types';

const convertTextBlock = (
  block: Extract<ContentBlock, { type: 'text' }>
): LocallyPersistedTextBlock => {
  const result: LocallyPersistedTextBlock = {
    type: 'text',
    text: block.text,
  };

  return result;
};

const convertImageBlock = (
  block: Extract<ContentBlock, { type: 'image' }>
): LocallyPersistedImageBlock => {
  const result: LocallyPersistedImageBlock = {
    type: 'image',
    source: {
      type: 'base64',
      data: block.source.data,
      media_type: block.source.mediaType,
    },
  };

  return result;
};

const convertToolResultContentBlock = (
  block: Extract<ContentBlock, { type: 'text' | 'image' }>
): LocallyPersistedTextBlock | LocallyPersistedImageBlock =>
  block.type === 'text' ? convertTextBlock(block) : convertImageBlock(block);

export function convertDroolMessageWithCachingContentToAnthropicContent(
  content: IndustryDroolMessageWithCaching['content']
): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') {
    return content;
  }

  const cacheEntry = {
    cache_control: {
      type: 'ephemeral' as const,
    },
  };

  return content.flatMap((block) => {
    switch (block.type) {
      case MessageContentBlockType.Text:
        return {
          ...convertTextBlock(block),
          ...(block.cache_control && cacheEntry),
        };
      case MessageContentBlockType.Image:
        return {
          ...convertImageBlock(block),
          ...(block.cache_control && cacheEntry),
        };
      case MessageContentBlockType.Thinking: {
        // Defense-in-depth: non-Anthropic thinking blocks should have been
        // filtered in prepareMessagesWithCaching, but if they slip through,
        // convert them to text to avoid API rejection
        const isNonAnthropicSignature =
          (block.signatureProvider &&
            block.signatureProvider !== ModelProvider.ANTHROPIC) ||
          (!block.signatureProvider && block.signature?.startsWith('{'));
        if (isNonAnthropicSignature) {
          const text = block.thinking?.trim() || '';
          if (!text) {
            return [];
          }
          return {
            type: 'text' as const,
            text,
            ...(block.cache_control && cacheEntry),
          };
        }
        return {
          type: 'thinking',
          signature: block.signature,
          thinking: block.thinking,
          ...(block.cache_control && cacheEntry),
        };
      }
      case MessageContentBlockType.RedactedThinking:
        return {
          type: 'redacted_thinking',
          data: block.data,
          ...(block.cache_control && cacheEntry),
        };
      case MessageContentBlockType.ToolUse: {
        const sanitizedId = sanitizeToolCallId(block.id);
        const result: LocallyPersistedToolUseBlock = {
          type: 'tool_use',
          // Use sanitized ID; fall back to a deterministic placeholder when
          // the ID is empty/whitespace-only so we never emit an invalid ID.
          id: sanitizedId || 'unknown_tool_id',
          // Historical tool_use blocks emitted before provider-safe tool name
          // sanitization can exceed provider limits or contain invalid chars,
          // so sanitize replayed names before sending them back to Anthropic.
          name: sanitizeToolNameForProvider(
            block.name,
            ANTHROPIC_TOOL_NAME_MAX_LENGTH
          ),
          input: block.input,
          ...(block.cache_control && cacheEntry),
        };

        return result;
      }
      case MessageContentBlockType.ToolResult: {
        const sanitizedId = sanitizeToolCallId(block.toolUseId);
        const result: ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: sanitizedId || 'unknown_tool_id',
        };

        if (block.isError !== undefined) {
          result.is_error = block.isError;
        }

        if (block.content !== undefined) {
          if (typeof block.content === 'string') {
            result.content = block.content;
          } else {
            // Map tool result content, converting DocumentBlocks to native Anthropic format
            const mappedContent: Array<
              TextBlockParam | ImageBlockParam | DocumentBlockParam
            > = [];

            for (const innerBlock of block.content) {
              if (
                innerBlock.type === MessageContentBlockType.Document &&
                innerBlock.source.type === DocumentSourceType.Base64 &&
                innerBlock.source.mediaType === 'application/pdf' &&
                innerBlock.source.data
              ) {
                mappedContent.push({
                  type: 'document' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: 'application/pdf' as const,
                    data: innerBlock.source.data,
                  },
                  ...(innerBlock.source.name && {
                    title: innerBlock.source.name,
                  }),
                });
              } else if (innerBlock.type === MessageContentBlockType.Text) {
                mappedContent.push({
                  type: 'text' as const,
                  text: innerBlock.text,
                });
              } else if (
                innerBlock.type === MessageContentBlockType.Image &&
                innerBlock.source.type === 'base64'
              ) {
                mappedContent.push({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    data: innerBlock.source.data,
                    media_type: innerBlock.source.mediaType,
                  },
                });
              }
            }

            result.content = mappedContent;
          }
        }
        if (block.cache_control) {
          Object.assign(result, cacheEntry);
        }

        return result;
      }
      case MessageContentBlockType.Document: {
        // Send native PDF document blocks to Anthropic
        if (
          block.source.type === DocumentSourceType.Base64 &&
          block.source.mediaType === 'application/pdf' &&
          block.source.data
        ) {
          return {
            type: 'document' as const,
            source: {
              type: 'base64' as const,
              media_type: 'application/pdf' as const,
              data: block.source.data,
            },
            ...(block.source.name && { title: block.source.name }),
            ...(block.cache_control && cacheEntry),
          };
        }
        // Fallback to text for non-PDF documents or PDFs without base64 data
        const fileContent =
          block.source.mediaType === 'application/pdf'
            ? block.source.parsedData
            : block.source.data;
        const filename = block.source.name ?? 'unknown';
        const fileContext = fileContent
          ? `<attached-file name="${filename}" type="${block.source.mediaType}">\n${fileContent}\n</attached-file>`
          : `<attached-file name="${filename}" type="${block.source.mediaType}">[File content unavailable]</attached-file>`;
        return {
          type: 'text',
          text: fileContext,
        };
      }
      default: {
        const exhaustiveCheck: never = block;
        return exhaustiveCheck;
      }
    }
  });
}

export function convertDroolMessageContentToLocallyPersistedMessageContent(
  content: IndustryDroolMessage['content']
): LocallyPersistedDroolMessage['content'] {
  if (typeof content === 'string') {
    return content;
  }

  return content.map((block) => {
    switch (block.type) {
      case MessageContentBlockType.Text:
        return convertTextBlock(block);
      case MessageContentBlockType.Image:
        return convertImageBlock(block);
      case MessageContentBlockType.Thinking:
        return {
          type: 'thinking',
          signature: block.signature,
          ...(block.signatureProvider && {
            signatureProvider: block.signatureProvider,
          }),
          ...(block.durationMs !== undefined && {
            durationMs: block.durationMs,
          }),
          thinking: block.thinking,
        };
      case MessageContentBlockType.RedactedThinking:
        return {
          type: 'redacted_thinking',
          data: block.data,
        };
      case MessageContentBlockType.ToolUse: {
        const result: LocallyPersistedToolUseBlock = {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        };

        if (block.thoughtSignature) {
          result.thought_signature = block.thoughtSignature;
        }

        return result;
      }
      case MessageContentBlockType.ToolResult: {
        const result: LocallyPersistedToolResultBlock = {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
        };

        if (block.isError !== undefined) {
          result.is_error = block.isError;
        }

        if (block.content !== undefined) {
          if (typeof block.content === 'string') {
            result.content = block.content;
          } else {
            // Filter to text/image blocks only -- DocumentBlocks are not persisted
            // (large binary data handled separately via PDF data persistence on disk)
            const persistable = block.content.filter(
              (c): c is Extract<ContentBlock, { type: 'text' | 'image' }> =>
                c.type === MessageContentBlockType.Text ||
                c.type === MessageContentBlockType.Image
            );
            result.content = persistable.map((innerBlock) =>
              convertToolResultContentBlock(innerBlock)
            );
          }
        }

        return result;
      }
      case MessageContentBlockType.Document: {
        // Preserve document block as-is for local persistence
        const docBlock = block;
        const result: LocallyPersistedDocumentBlock =
          docBlock.source.mediaType === 'application/pdf'
            ? {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: '', // Ensure this is an empty str for now since the actual file data is persisted elsewhere
                  parsed_data: docBlock.source.parsedData,
                  name: docBlock.source.name,
                  path: docBlock.source.path,
                },
              }
            : {
                type: 'document',
                source: {
                  type: 'text',
                  media_type: 'text/plain',
                  data: docBlock.source.data,
                  name: docBlock.source.name,
                  mime: docBlock.source.mime,
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

/**
 * Strip PDF base64 data from a message before sending to external APIs.
 * This prevents large PDF data from being uploaded to backend services.
 * The PDF data is stored separately on disk and can be loaded when needed.
 */
export function stripPdfDataFromMessage(
  message: IndustryDroolMessage
): IndustryDroolMessage {
  if (typeof message.content === 'string') {
    return message;
  }

  const stripPdfDocument = (doc: DocumentBlock): DocumentBlock => {
    if (doc.source.mediaType !== 'application/pdf') {
      return doc;
    }
    const name = doc.source.name ?? 'document.pdf';
    const filePath = doc.source.path;
    const placeholder = filePath
      ? `[PDF: ${name} — stored at ${filePath}]`
      : `[PDF: ${name}]`;
    return {
      ...doc,
      source: {
        ...doc.source,
        data: '',
        parsedData: placeholder,
      },
    };
  };

  const strippedContent = message.content.map((block: ContentBlock) => {
    if (block.type === MessageContentBlockType.Document) {
      return stripPdfDocument(block);
    }
    if (
      block.type === MessageContentBlockType.ToolResult &&
      Array.isArray(block.content)
    ) {
      return {
        ...block,
        content: block.content.map((inner) => {
          if (inner.type === MessageContentBlockType.Document) {
            return stripPdfDocument(inner);
          }
          return inner;
        }),
      };
    }
    return block;
  });

  return {
    ...message,
    content: strippedContent,
  };
}

/**
 * Populates PDF content in all document blocks within messages.
 * Called during session load to restore PDF data for frontend display.
 */
export async function populateMessagesWithPdfContent(
  messages: IndustryDroolMessage[]
): Promise<IndustryDroolMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (typeof message.content === 'string') {
        return message;
      }

      const updatedContent = await Promise.all(
        message.content.map(async (block: ContentBlock) => {
          if (block.type !== MessageContentBlockType.Document) {
            return block;
          }
          return populatePdfDataFromDisk(block);
        })
      );

      return {
        ...message,
        content: updatedContent,
      };
    })
  );
}

/**
 * Pure function: converts StreamingContentBlock[] + ToolUse[] into ContentBlock[]
 * preserving exact interleaved ordering from the streaming API.
 *
 * This is used for both:
 * 1. Building the persistence message in useAgent (JSONL)
 * 2. Updating in-memory conversation history in ConversationStateManager
 *
 * The function is intentionally stateless -- it does NOT read from or write to
 * conversationHistory, avoiding the mutation hazard in getConversationHistory().
 */
export function convertStreamingBlocksToContentBlocks(
  contentBlocks: StreamingContentBlock[],
  toolUses: ToolUse[]
): ContentBlock[] {
  const sorted = contentBlocks
    .filter((b) => b && (b.content || b.data || b.toolUseId))
    .sort((a, b) => a.index - b.index);

  const toolUseMap = new Map(toolUses.map((t) => [t.id, t]));
  const result: ContentBlock[] = [];

  for (const block of sorted) {
    switch (block.type) {
      case StreamingContentBlockType.Thinking:
        if (block.content) {
          result.push({
            type: MessageContentBlockType.Thinking,
            thinking: block.content,
            signature: block.signature ?? '',
            signatureProvider: block.signatureProvider,
            ...(block.durationMs !== undefined && {
              durationMs: block.durationMs,
            }),
          });
        }
        break;
      case StreamingContentBlockType.RedactedThinking:
        if (block.data) {
          result.push({
            type: MessageContentBlockType.RedactedThinking,
            data: block.data,
          } as RedactedThinkingBlock);
        }
        break;
      case StreamingContentBlockType.Text:
        if (block.content) {
          result.push({
            type: MessageContentBlockType.Text,
            text: block.content,
          });
        }
        break;
      case StreamingContentBlockType.ToolUse:
        if (block.toolUseId) {
          const toolUse = toolUseMap.get(block.toolUseId);
          if (toolUse) {
            const toolUseBlock: ToolUseBlock = {
              type: MessageContentBlockType.ToolUse,
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input,
              ...(toolUse.thoughtSignature && {
                thoughtSignature: toolUse.thoughtSignature,
              }),
            };
            result.push(toolUseBlock);
          }
        }
        break;
      default:
        break;
    }
  }

  return result;
}
