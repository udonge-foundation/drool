import {
  ContentBlock,
  IndustryDroolMessage,
  IndustryDroolMessageWithCaching,
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import { isSessionModelUpgradeAvailable } from '@/models/sessionModelUpgrade';
import { getSessionService } from '@/services/SessionService';
import {
  SECURITY_WORK_UPGRADE_NUDGE_TEXT,
  STUCK_PHRASE_NUDGE_TEXT,
  STUCK_THRESHOLD,
  STUCK_WINDOW_TURNS,
} from '@/utils/constants';
import { extractMessageText } from '@/utils/conversationCopy';
import { wrapInSystemReminder } from '@/utils/systemReminderUtils';

// Phrases derived from first-principles stuckness categories
// (approach-reset, reconsideration, mid-thought correction, failure
// ack, meta-uncertainty, step-back), not from eval-specific traces.
const STUCK_PHRASES: readonly string[] = [
  'different approach',
  'another approach',
  'try a different',
  'try another',
  'let me reconsider',
  'let me rethink',
  'need to rethink',
  'actually, wait',
  'wait, actually',
  'hmm, wait',
  'on second thought',
  "isn't working",
  "that didn't work",
  "this doesn't work",
  "i'm missing something",
  'must be missing',
  'step back',
];

const SECURITY_CONCERN_PATTERNS: readonly RegExp[] = [
  /\bvulnerabilit(?:y|ies)\b/i,
  /\bvulns?\b/i,
  /\bvulnerable\b/i,
  /\bCVE-\d{4}-\d{4,}\b/i,
  /\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/i,
  /\bCWE-\d+\b/i,
  /\bexploit(?:ability|able|s|ed|ing)?\b/i,
  /\bsecurity\b/i,
  /\b(auth(?:entication|orization)?|permission)\s+bypass\b/i,
  /\bprivilege escalation\b/i,
  /\battack surface\b/i,
  /\b(?:XSS|CSRF|SSRF|RCE|IDOR|XXE)\b/i,
  /\b(?:SQL|command|code|prompt)\s+injection\b/i,
  /\bpath traversal\b/i,
  /\bprototype pollution\b/i,
  /\b(?:Snyk|Dependabot|CodeQL|Semgrep|OWASP)\b/i,
];

function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

function countPhrasesInBlock(block: ContentBlock): number {
  let text: string | undefined;
  if (block.type === MessageContentBlockType.Thinking) {
    text = block.thinking;
  } else if (block.type === MessageContentBlockType.Text) {
    text = block.text;
  }
  if (!text) return 0;
  const lower = text.toLowerCase();
  let count = 0;
  for (const phrase of STUCK_PHRASES) {
    let idx = 0;
    for (;;) {
      const next = lower.indexOf(phrase, idx);
      if (next === -1) break;
      count++;
      idx = next + phrase.length;
    }
  }
  return count;
}

function hasAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasSecurityConcern(text: string): boolean {
  return hasAnyPattern(stripSystemReminders(text), SECURITY_CONCERN_PATTERNS);
}

export function countStuckPhraseSignals(
  history: IndustryDroolMessage[],
  windowTurns: number = STUCK_WINDOW_TURNS
): number {
  let assistantSeen = 0;
  let count = 0;
  for (let i = history.length - 1; i >= 0 && assistantSeen < windowTurns; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    assistantSeen++;
    for (const block of msg.content) {
      count += countPhrasesInBlock(block);
    }
  }
  return count;
}

export function hasRecentUpgradeInvocation(
  history: IndustryDroolMessage[],
  windowTurns: number = STUCK_WINDOW_TURNS
): boolean {
  let assistantSeen = 0;
  for (let i = history.length - 1; i >= 0 && assistantSeen < windowTurns; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    assistantSeen++;
    for (const block of msg.content) {
      if (
        block.type === MessageContentBlockType.ToolUse &&
        block.name === 'UpgradeSessionModel'
      ) {
        return true;
      }
    }
  }
  return false;
}

export function shouldInjectUpgradeNudge(
  history: IndustryDroolMessage[]
): boolean {
  if (hasRecentUpgradeInvocation(history)) return false;
  return countStuckPhraseSignals(history) >= STUCK_THRESHOLD;
}

export function shouldInjectSecurityUpgradeNudge(
  history: IndustryDroolMessage[]
): boolean {
  if (hasRecentUpgradeInvocation(history)) return false;

  let seen = 0;
  for (let i = history.length - 1; i >= 0 && seen < STUCK_WINDOW_TURNS; i--) {
    const msg = history[i];
    if (msg.role !== MessageRole.User && msg.role !== MessageRole.Assistant) {
      continue;
    }
    const text = extractMessageText(msg);
    if (!text) {
      continue;
    }
    seen++;
    if (hasSecurityConcern(text)) {
      return true;
    }
  }
  return false;
}

/** Mutates `history` in place. No-op when no upgrade target is defined. */
export function maybeInjectUpgradeNudges<
  T extends IndustryDroolMessage | IndustryDroolMessageWithCaching,
>(history: T[]): T[] {
  const effective = getSessionService().getEffectiveIndustryRouterModel();
  if (!isSessionModelUpgradeAvailable(effective)) {
    return history;
  }

  const nudgeTexts: string[] = [];
  if (shouldInjectUpgradeNudge(history)) {
    nudgeTexts.push(STUCK_PHRASE_NUDGE_TEXT);
  }
  if (shouldInjectSecurityUpgradeNudge(history)) {
    nudgeTexts.push(SECURITY_WORK_UPGRADE_NUDGE_TEXT);
  }

  if (nudgeTexts.length === 0) {
    return history;
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (
      (msg.role === MessageRole.Tool || msg.role === MessageRole.User) &&
      Array.isArray(msg.content)
    ) {
      history[i] = {
        ...msg,
        content: [
          ...msg.content,
          ...nudgeTexts.map((text) => ({
            type: MessageContentBlockType.Text,
            text: wrapInSystemReminder(text),
          })),
        ],
      } as T;
      break;
    }
  }
  return history;
}
