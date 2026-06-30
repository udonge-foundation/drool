import {
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
} from '@industry/drool-sdk-ext/protocol/drool';

export function formatPercent(tokens: number, total: number): string {
  if (total === 0) return '0.0%';
  const pct = (tokens / total) * 100;
  if (pct < 0.1 && tokens > 0) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractSystemReminderBlocks(
  conversationHistory: { role: string; content: unknown[] }[]
): {
  userInfoChars: number;
  agentsMdChars: number;
  skillsChars: number;
  deferredToolsChars: number;
} {
  let userInfoChars = 0;
  let agentsMdChars = 0;
  let skillsChars = 0;
  let deferredToolsChars = 0;

  for (const msg of conversationHistory) {
    if (msg.role !== 'user') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        (block as { type: string }).type === 'text' &&
        'text' in block
      ) {
        const text = (block as { text: string }).text;
        if (typeof text !== 'string' || !text.includes(SYSTEM_REMINDER_START))
          continue;

        const regex = new RegExp(
          `${escapeRegex(SYSTEM_REMINDER_START)}([\\s\\S]*?)${escapeRegex(SYSTEM_REMINDER_END)}`,
          'g'
        );
        let match = regex.exec(text);
        while (match !== null) {
          const reminderContent = match[1];
          if (
            reminderContent.includes('Deferred tools:') ||
            reminderContent.includes(
              'schemas may be omitted from the current tool list'
            )
          ) {
            deferredToolsChars += match[0].length;
          } else if (
            reminderContent.includes('coding_guidelines') ||
            reminderContent.includes('design_guidelines') ||
            reminderContent.includes('Project Instructions') ||
            reminderContent.includes('Personal Global Instructions') ||
            reminderContent.includes('AGENTS.md') ||
            reminderContent.includes('CLAUDE.md') ||
            reminderContent.includes('DESIGN.md') ||
            reminderContent.includes('design.md')
          ) {
            agentsMdChars += match[0].length;
          } else if (
            reminderContent.includes('Available skills for the Skill tool') ||
            reminderContent.includes('New skills discovered along the path')
          ) {
            skillsChars += match[0].length;
          } else {
            userInfoChars += match[0].length;
          }
          match = regex.exec(text);
        }
      }
    }
  }

  return { userInfoChars, agentsMdChars, skillsChars, deferredToolsChars };
}
