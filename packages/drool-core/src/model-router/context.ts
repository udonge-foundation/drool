import {
  CHARS_PER_TOKEN_ESTIMATE,
  CONTEXT_LIMIT_TOKENS,
  KEEP_HEAD_LENGTH,
  KEEP_TAIL_LENGTH,
  MAX_RECENT_TOOL_CALLS,
} from './constants';

import type { ClassifierSignals, RecentMessage } from './types';

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function trimMessageHeadTail({
  text,
  headLen = KEEP_HEAD_LENGTH,
  tailLen = KEEP_TAIL_LENGTH,
}: {
  text: string;
  headLen?: number;
  tailLen?: number;
}): string {
  if (text.length <= headLen + tailLen + 40) return text;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  const omitted = text.length - headLen - tailLen;
  return `${head}\n... [${omitted} chars truncated] ...\n${tail}`;
}

type SessionSectionId =
  | 'turn_context'
  | 'current_user_message'
  | 'recent_tool_calls'
  | 'system_info'
  | 'first_user_message'
  | 'conversation_summary'
  | 'recent_messages';

interface SessionContextSection {
  id: SessionSectionId;
  /** Lower = included first when budget is tight. */
  priority: number;
  xml: string;
}

/**
 * Final-output order, decoupled from pack priority so the layout is
 * deterministic regardless of which sections survive. Current user
 * message is rendered last for emphasis.
 */
const OUTPUT_ORDER: SessionSectionId[] = [
  'turn_context',
  'system_info',
  'conversation_summary',
  'first_user_message',
  'recent_messages',
  'recent_tool_calls',
  'current_user_message',
];

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

// Ampersand must be replaced first; otherwise `<` → `&lt;` becomes `&amp;lt;`.
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderTurnContext(signals: ClassifierSignals): string {
  const hasFailedTools =
    signals.hasFailedToolCalls ??
    signals.recentToolCalls.some((tc) => tc.status === 'error');
  const lines = [
    '<turn_context>',
    `  turn_number: ${signals.turnCount}`,
    `  surface: ${signals.surface}`,
    `  sub_agent: ${signals.isSubAgentSession ? 'yes' : 'no'}`,
    `  images_present: ${signals.hasImages ? 'yes' : 'no'}`,
    `  has_failed_tool_calls: ${hasFailedTools ? 'yes' : 'no'}`,
    '</turn_context>',
  ];
  return lines.join('\n');
}

function renderSimpleWrapped({
  tag,
  body,
  headLen,
  tailLen,
}: {
  tag: SessionSectionId;
  body: string;
  headLen: number;
  tailLen: number;
}): string {
  const trimmed = trimMessageHeadTail({ text: body, headLen, tailLen });
  const escaped = escapeXmlText(trimmed);
  return `<${tag}>\n${indent(escaped, '  ')}\n</${tag}>`;
}

function renderRecentMessages(messages: readonly RecentMessage[]): string {
  const blocks = messages.map((message) => {
    const trimmed = trimMessageHeadTail({ text: message.text });
    const escaped = escapeXmlText(trimmed);
    return [
      `  <message role="${message.role}">`,
      indent(escaped, '    '),
      '  </message>',
    ].join('\n');
  });
  return ['<recent_messages>', ...blocks, '</recent_messages>'].join('\n');
}

function renderRecentToolCalls(
  toolCalls: ClassifierSignals['recentToolCalls']
): string {
  const slice = toolCalls.slice(-MAX_RECENT_TOOL_CALLS);
  const lines = slice.map((tc) => `  ${escapeXmlText(tc.name)}: ${tc.status}`);
  return ['<recent_tool_calls>', ...lines, '</recent_tool_calls>'].join('\n');
}

function collectSections(signals: ClassifierSignals): SessionContextSection[] {
  const sections: SessionContextSection[] = [];

  sections.push({
    id: 'turn_context',
    priority: 0,
    xml: renderTurnContext(signals),
  });

  sections.push({
    id: 'current_user_message',
    priority: 1,
    xml: renderSimpleWrapped({
      tag: 'current_user_message',
      body: signals.currentUserMessage || '[empty]',
      headLen: KEEP_HEAD_LENGTH,
      tailLen: KEEP_TAIL_LENGTH,
    }),
  });

  if (signals.recentToolCalls.length > 0) {
    sections.push({
      id: 'recent_tool_calls',
      priority: 2,
      xml: renderRecentToolCalls(signals.recentToolCalls),
    });
  }

  if (signals.systemInfo) {
    sections.push({
      id: 'system_info',
      priority: 3,
      xml: renderSimpleWrapped({
        tag: 'system_info',
        body: signals.systemInfo,
        headLen: KEEP_HEAD_LENGTH,
        tailLen: KEEP_TAIL_LENGTH,
      }),
    });
  }

  if (
    signals.firstUserMessage &&
    signals.firstUserMessage !== signals.currentUserMessage
  ) {
    sections.push({
      id: 'first_user_message',
      priority: 4,
      xml: renderSimpleWrapped({
        tag: 'first_user_message',
        body: signals.firstUserMessage,
        headLen: KEEP_HEAD_LENGTH,
        tailLen: KEEP_TAIL_LENGTH,
      }),
    });
  }

  if (signals.conversationSummary) {
    sections.push({
      id: 'conversation_summary',
      priority: 5,
      xml: renderSimpleWrapped({
        tag: 'conversation_summary',
        body: signals.conversationSummary,
        headLen: KEEP_HEAD_LENGTH,
        tailLen: KEEP_TAIL_LENGTH,
      }),
    });
  }

  if (signals.recentMessages && signals.recentMessages.length > 0) {
    sections.push({
      id: 'recent_messages',
      priority: 6,
      xml: renderRecentMessages(signals.recentMessages),
    });
  }

  return sections;
}

export function buildSessionContextXml(
  signals: ClassifierSignals,
  budgetTokens: number = CONTEXT_LIMIT_TOKENS
): string {
  const sections = collectSections(signals);
  const sortedByPriority = [...sections].sort(
    (a, b) => a.priority - b.priority
  );

  let used = 0;
  const included = new Map<SessionSectionId, string>();
  for (const section of sortedByPriority) {
    const tokens = estimateTokenCount(section.xml);
    if (used + tokens > budgetTokens) continue;
    included.set(section.id, section.xml);
    used += tokens;
  }

  const ordered = OUTPUT_ORDER.map((id) => included.get(id)).filter(
    (xml): xml is string => xml !== undefined
  );
  return ['<session>', ...ordered, '</session>'].join('\n\n');
}
