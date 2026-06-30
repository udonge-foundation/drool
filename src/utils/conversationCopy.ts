import {
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageVisibility,
  TextBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import { MessageRole } from '@/hooks/enums';
import { getConversationStateManager } from '@/services/ConversationStateManager';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import type { ConversationTurn } from '@/utils/types';

const TURN_PREVIEW_LENGTH = 80;

/**
 * Extract plain text from a IndustryDroolMessage. Concatenates all text blocks
 * with newlines; non-text blocks (tool calls, images, thinking) are ignored.
 */
export function extractMessageText(message: IndustryDroolMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .filter(
      (block): block is TextBlock =>
        block.type === MessageContentBlockType.Text &&
        typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('\n');
}

/**
 * Count non-empty lines in a block of text (treating the trailing newline as
 * not a line of its own).
 */
export function countLines(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
  if (!normalized) {
    return 0;
  }
  return normalized.split('\n').length;
}

/**
 * Load the current conversation history for copy operations. Prefers the
 * daemon's SessionStateManager when a session is active, and falls back to
 * the local ConversationStateManager.
 */
export function getConversationHistoryForCopy(): IndustryDroolMessage[] {
  const currentSessionId = getSessionService().getCurrentSessionId();
  if (currentSessionId) {
    try {
      const adapter = getTuiDaemonAdapter();
      const ssm = adapter.getSessionStateManager();
      const mgr = ssm.getSessionManager(currentSessionId);
      if (mgr) {
        const msgs = mgr.getStore().getMessages();
        if (msgs.length > 0) {
          return msgs;
        }
      }
    } catch {
      // Fall through to ConversationStateManager
    }
  }
  return getConversationStateManager().getConversationHistory();
}

/**
 * Return true if the message is user-facing (not LLM-only) and carries a
 * role that should appear in copyable transcripts.
 */
function isVisibleCopyableMessage(message: IndustryDroolMessage): boolean {
  if (message.visibility === MessageVisibility.LLMOnly) {
    return false;
  }
  return (
    message.role === MessageRole.User || message.role === MessageRole.Assistant
  );
}

/**
 * Find the last non-empty text from a message matching the given role.
 */
export function findLastTextByRole(
  history: IndustryDroolMessage[],
  role: MessageRole
): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== role) {
      continue;
    }
    if (message.visibility === MessageVisibility.LLMOnly) {
      continue;
    }
    const text = extractMessageText(message);
    if (text.trim()) {
      return text;
    }
  }
  return null;
}

function truncateInline(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

/**
 * Group visible user/assistant messages into turns. A turn starts with a user
 * prompt and includes the subsequent assistant responses (up to the next user
 * prompt). An assistant-only tail (no preceding user prompt) is dropped.
 */
export function buildConversationTurns(
  history: IndustryDroolMessage[]
): ConversationTurn[] {
  const visible = history.filter(isVisibleCopyableMessage);
  const turns: ConversationTurn[] = [];

  let currentUserTexts: string[] = [];
  let currentAssistantTexts: string[] = [];
  let hasUser = false;

  const pushTurn = () => {
    if (!hasUser) {
      return;
    }
    const userText = currentUserTexts.join('\n').trim();
    const assistantText = currentAssistantTexts.join('\n').trim();
    if (!userText && !assistantText) {
      return;
    }
    turns.push({
      turnNumber: turns.length + 1,
      userText,
      assistantText,
      userPreview: truncateInline(userText, TURN_PREVIEW_LENGTH),
      assistantPreview: truncateInline(assistantText, TURN_PREVIEW_LENGTH),
    });
  };

  for (const message of visible) {
    const text = extractMessageText(message);
    if (message.role === MessageRole.User) {
      // Starting a new turn; flush the previous one
      pushTurn();
      currentUserTexts = text ? [text] : [];
      currentAssistantTexts = [];
      hasUser = true;
    } else if (message.role === MessageRole.Assistant) {
      if (!hasUser) {
        // Ignore assistant output with no prior user prompt (e.g. greeter).
        continue;
      }
      if (text) {
        currentAssistantTexts.push(text);
      }
    }
  }
  pushTurn();

  return turns;
}

/**
 * Format a single turn or inclusive range of turns as a human-readable
 * transcript. Turn numbers reference `ConversationTurn.turnNumber` and the
 * range is ordered chronologically regardless of input order.
 */
export function formatTurnRangeTranscript(
  turns: ConversationTurn[],
  anchorTurn: number,
  cursorTurn: number
): string {
  if (turns.length === 0) {
    return '';
  }
  const lo = Math.min(anchorTurn, cursorTurn);
  const hi = Math.max(anchorTurn, cursorTurn);
  const sections: string[] = [];
  for (const turn of turns) {
    if (turn.turnNumber < lo || turn.turnNumber > hi) {
      continue;
    }
    const blocks: string[] = [];
    blocks.push(`Turn ${turn.turnNumber}`);
    if (turn.userText) {
      blocks.push(`User:\n${turn.userText}`);
    }
    if (turn.assistantText) {
      blocks.push(`Assistant:\n${turn.assistantText}`);
    }
    sections.push(blocks.join('\n\n'));
  }
  return sections.join('\n\n---\n\n');
}
