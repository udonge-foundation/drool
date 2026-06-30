import type { SerializeOptions } from '@/hooks/compaction/types';

import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

const MAX_THINKING_CHARS = 500;

/**
 * Serializes a single content block to a string representation
 */
function serializeContentBlock(
  block: IndustryDroolMessage['content'][number],
  options: SerializeOptions
): string {
  const { abbreviateTools = false } = options;

  switch (block.type) {
    case 'text':
      return block.text;

    case 'tool_use':
      if (abbreviateTools) {
        return `[Tool: ${block.name}]`;
      }
      return `TOOL_CALL: ${block.name} input=${JSON.stringify(block.input)}`;

    case 'tool_result': {
      if (abbreviateTools) {
        return `[Tool result]`;
      }
      const content =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .map((c) => (c.type === 'text' ? c.text : '[Image]'))
                .join('\n')
            : '';
      return `TOOL_RESULT: ${content}`;
    }

    case 'thinking':
      return `[Thinking: ${block.thinking.slice(0, MAX_THINKING_CHARS)}${block.thinking.length > MAX_THINKING_CHARS ? '...' : ''}]`;

    case 'redacted_thinking':
      return '[Redacted thinking]';

    case 'image':
      return '[Image attached]';

    default: {
      // Fallback for any unknown block types
      const unknownBlock = block as { type: string };
      return `[Unknown block type: ${unknownBlock.type}]`;
    }
  }
}

/**
 * Serializes a single message to a string representation
 */
function serializeMessage(
  message: IndustryDroolMessage,
  options: SerializeOptions
): string {
  const { role, content } = message;
  const roleLabel = role.toUpperCase();

  // Handle string content (shouldn't happen with proper types, but handle defensively)
  if (typeof content === 'string') {
    return `${roleLabel}: ${content}`;
  }

  // Handle array content
  if (Array.isArray(content)) {
    const formattedBlocks = content.map((block) =>
      serializeContentBlock(block, options)
    );
    return `${roleLabel}: ${formattedBlocks.join('\n')}`;
  }

  return `${roleLabel}: [Complex content]`;
}

/**
 * Serializes an array of messages into a readable transcript format.
 * This is used for compaction summaries and provider switch context injection.
 *
 * @param messages - Array of IndustryDroolMessage to serialize
 * @param options - Serialization options
 * @returns A string transcript of the conversation
 */
export function serializeConversation(
  messages: IndustryDroolMessage[],
  options: SerializeOptions = {}
): string {
  return messages
    .map((msg) => serializeMessage(msg, options))
    .join('\n\n---\n\n');
}
