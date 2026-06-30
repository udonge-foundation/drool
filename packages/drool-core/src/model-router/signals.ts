import { RECENT_MESSAGE_COUNT } from './constants';

import type {
  ClassifierSignalsInput,
  ClassifierSignals,
  ConversationMessage,
  RecentMessage,
} from './types';

/** Remove every `<system-reminder>…</system-reminder>` block from text. */
function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

/** Extract the inner text of every `<system-reminder>` block in text. */
function extractSystemReminderBlocks(text: string): string[] {
  const matches = Array.from(
    text.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)
  );
  return matches.map((m) => (m[1] ?? '').trim()).filter(Boolean);
}

/** Join all `text` blocks in a message into a single string. */
function extractMessageText(message: ConversationMessage): string {
  return message.content
    .filter((b): b is typeof b & { text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Build {@link ClassifierSignals} from a Drool conversation history.
 *
 * This is the canonical implementation: the CLI calls it before every
 * routing decision and the offline eval harness replays it on saved
 * session JSONL files.  Keep it pure — no side effects, no I/O.
 */
export function buildClassifierSignalsFromHistory(
  args: ClassifierSignalsInput
): ClassifierSignals {
  const { conversationHistory, surface, isSubAgent, turnNumber, sessionId } =
    args;

  let hasImages = false;
  const toolCalls: Array<{ name: string; status: 'success' | 'error' }> = [];

  // Pass 1: scan for tool calls + image flags.
  for (const message of conversationHistory) {
    for (const block of message.content) {
      if (block.type === 'image') {
        hasImages = true;
      }
      if (block.type === 'tool_use') {
        toolCalls.push({ name: block.name ?? 'unknown', status: 'success' });
      }
      if (block.type === 'tool_result') {
        const last = toolCalls[toolCalls.length - 1];
        if (last && block.isError) {
          last.status = 'error';
        }
      }
    }
  }

  // Pass 2: walk forward — first user message + initial system info.
  let systemInfo: string | undefined;
  let firstUserMessage: string | undefined;
  for (const message of conversationHistory) {
    if (message.role !== 'user') continue;
    const fullText = extractMessageText(message);
    if (!systemInfo) {
      const reminders = extractSystemReminderBlocks(fullText);
      if (reminders.length > 0) {
        systemInfo = reminders.join('\n\n');
      }
    }
    const userText = stripSystemReminders(fullText);
    if (userText) {
      firstUserMessage = userText;
      break;
    }
  }

  // Pass 3: walk backward — current user message (latest non-empty
  // user turn after stripping system reminders).
  let currentUserMessage = '';
  for (let i = conversationHistory.length - 1; i >= 0; i -= 1) {
    const message = conversationHistory[i]!;
    if (message.role !== 'user') continue;
    const userText = stripSystemReminders(extractMessageText(message));
    if (userText) {
      currentUserMessage = userText;
      break;
    }
  }

  // Pass 4: recent messages (user + assistant) oldest-first, bounded
  // by RECENT_MESSAGE_COUNT. The current user message is excluded.
  const recentMessages: RecentMessage[] = [];
  let skippedCurrent = false;
  for (
    let i = conversationHistory.length - 1;
    i >= 0 && recentMessages.length < RECENT_MESSAGE_COUNT;
    i -= 1
  ) {
    const message = conversationHistory[i]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = stripSystemReminders(extractMessageText(message));
    if (!text) continue;
    if (
      !skippedCurrent &&
      message.role === 'user' &&
      text === currentUserMessage
    ) {
      skippedCurrent = true;
      continue;
    }
    recentMessages.unshift({
      role: message.role as 'user' | 'assistant',
      text,
    });
  }

  return {
    sessionId,
    surface,
    isSubAgentSession: isSubAgent,
    turnCount: turnNumber,
    hasImages,
    recentToolCalls: toolCalls.slice(-10),
    hasFailedToolCalls: toolCalls.some((t) => t.status === 'error'),
    currentUserMessage,
    firstUserMessage:
      firstUserMessage && firstUserMessage !== currentUserMessage
        ? firstUserMessage
        : undefined,
    systemInfo,
    recentMessages: recentMessages.length > 0 ? recentMessages : undefined,
  };
}
