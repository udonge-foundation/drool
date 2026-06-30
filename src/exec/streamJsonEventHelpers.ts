import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import type { ExecEvent } from '@/exec/types';

import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

/**
 * Converts a IndustryDroolMessage into stream-json ExecEvent objects.
 *
 * Handles:
 * - Reasoning content from chatCompletionReasoningContent (generic providers like Nemotron)
 * - Reasoning content from thinking blocks (Anthropic-style extended thinking)
 * - Text messages
 * - Tool calls
 *
 * @param msg The assistant message to convert
 * @param sessionId The session ID to include in events
 * @param toolUseIdMap Optional map to store tool use ID -> tool name mappings for later lookup
 * @returns Array of ExecEvent objects to emit
 */
export function buildExecEventsFromAssistantMessage(
  msg: IndustryDroolMessage,
  sessionId: string,
  toolUseIdMap?: Map<string, string>
): ExecEvent[] {
  const events: ExecEvent[] = [];

  // Emit reasoning from chatCompletionReasoningContent (generic chat completion providers)
  if (msg.chatCompletionReasoningContent?.trim()) {
    events.push({
      type: 'reasoning',
      id: msg.id,
      text: msg.chatCompletionReasoningContent,
      timestamp: msg.createdAt,
      session_id: sessionId,
    });
  }

  // Process content blocks
  for (const block of msg.content) {
    if (
      block.type === MessageContentBlockType.Thinking &&
      block.thinking.trim()
    ) {
      events.push({
        type: 'reasoning',
        id: msg.id,
        text: block.thinking,
        timestamp: msg.createdAt,
        session_id: sessionId,
      });
    } else if (block.type === 'text' && block.text.trim()) {
      events.push({
        type: 'message',
        role: MessageRole.Assistant,
        id: msg.id,
        text: block.text,
        timestamp: msg.createdAt,
        session_id: sessionId,
      });
    } else if (block.type === 'tool_use') {
      // Store the mapping for later lookup in tool results (if map provided)
      if (toolUseIdMap) {
        toolUseIdMap.set(block.id, block.name);
      }
      events.push({
        type: 'tool_call',
        id: block.id,
        messageId: msg.id,
        toolId: block.name,
        toolName: block.name,
        parameters: block.input,
        timestamp: msg.createdAt,
        session_id: sessionId,
      });
    }
  }

  return events;
}
