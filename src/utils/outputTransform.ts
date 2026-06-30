import {
  IndustryDroolMessage,
  MessageRole,
  ToolResultBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { getNameAndMessage, logInfo, logWarn } from '@industry/logging';

import { getTUIToolRegistry } from '@/tools/registry';

/**
 * Strip trailing assistant messages from a conversation history so the final
 * turn is always a user (or tool) message.
 *
 * Anthropic models (e.g. claude-opus-4-6) reject requests where the
 * conversation ends with an assistant message, returning:
 *   "This model does not support assistant message prefill.
 *    The conversation must end with a user message."
 *
 * Tool results map to the `user` role in Anthropic's wire format, so only
 * genuine Assistant-role turns at the tail are removed. A conversation can
 * legitimately end with an Assistant turn during partial response recovery,
 * after provider switches, or after upstream filtering steps (e.g. orphaned
 * tool_use removal) empty the following user/tool turn — cases where we
 * must sanitize the history before sending.
 *
 * This utility is pure and safe to call on any conversation history; it is
 * a no-op when the history already ends with a user or tool message.
 *
 * See: FAC-17179.
 */
export function stripTrailingAssistantMessages(
  messages: IndustryDroolMessage[]
): IndustryDroolMessage[] {
  let lastKeepIndex = messages.length - 1;
  while (
    lastKeepIndex >= 0 &&
    messages[lastKeepIndex].role === MessageRole.Assistant
  ) {
    logWarn(
      '[stripTrailingAssistantMessages] Removing trailing assistant message to avoid Anthropic prefill rejection',
      {
        messageId: messages[lastKeepIndex].id,
      }
    );
    lastKeepIndex--;
  }

  if (lastKeepIndex === messages.length - 1) {
    return messages;
  }

  return messages.slice(0, lastKeepIndex + 1);
}

/**
 * Apply outgoing-conversation transforms before handing history to the LLM:
 *
 *   1. Per-tool output formatters (e.g. reformat tool_result payloads).
 *   2. Strip trailing assistant messages so Anthropic doesn't reject the
 *      request with "assistant message prefill" (FAC-17179).
 *
 * @param history - Conversation history containing messages with potential tool results
 * @returns A new conversation history with transforms applied
 */
export function applyOutputTransforms(
  history: IndustryDroolMessage[]
): IndustryDroolMessage[] {
  const idToName = new Map<string, string>();

  // Build map of tool_use id -> name
  history.forEach((msg) => {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content.forEach((block) => {
        if (block.type === 'tool_use') {
          idToName.set(block.id, block.name);
        }
      });
    }
  });

  const registry = getTUIToolRegistry();
  const tools = Array.from(
    (
      registry as unknown as {
        registry: Map<
          string,
          {
            tool: {
              llmId?: string;
              id: string;
              outputTransform?: (output: unknown) => string;
            };
          }
        >;
      }
    ).registry.values()
  );

  const findToolTransform = (toolName?: string) => {
    if (!toolName) return undefined;
    const impl = tools.find(
      (t) => t.tool.llmId === toolName || t.tool.id === toolName
    );
    return impl?.tool.outputTransform;
  };

  // Produce transformed copy
  const transformed = history.map((msg) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    const transformedBlocks = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block;

      const toolName = idToName.get(block.toolUseId);
      const transform = findToolTransform(toolName);

      if (!transform) return block;

      try {
        const contentStr = (block.content as unknown as string) || '';

        // Skip transformation for empty content or error messages
        if (!contentStr || contentStr.startsWith('Error:')) {
          return block;
        }

        let payload: unknown = contentStr;

        // Try to parse JSON if the content looks like JSON
        if (typeof contentStr === 'string') {
          const trimmed = contentStr.trim();
          if (
            (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))
          ) {
            try {
              payload = JSON.parse(trimmed);
            } catch {
              // Fall back to string if parsing fails
            }
          }
        }

        const newContent = transform(payload);

        return {
          ...block,
          content: newContent,
        } as ToolResultBlock;
      } catch (e) {
        logInfo('Failed to apply output transform', {
          toolName,
          errorMessage: getNameAndMessage(e),
        });
        return block;
      }
    });

    return {
      ...msg,
      content: transformedBlocks,
    };
  });

  return stripTrailingAssistantMessages(transformed);
}
