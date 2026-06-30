import { approxTokensFromChars } from '@industry/utils/llm';

import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { measureMessagesChars } from '@/utils/contextMeasurement';
import type { RawMessage } from '@/utils/types';

const MIN_CONTEXT_SAVINGS_PERCENT = 1;

/**
 * Compute the real context savings percentage for a spec handoff to a new session.
 *
 * Only the *messages* bucket actually disappears when handing off to a new
 * session. The system prompt, tools, MCP tools, AGENTS.md / user-info reminders,
 * custom drools, skills, and the spec plan itself are all regenerated and
 * re-sent in the new session, so none of them count as "savings".
 *
 *   realSavings    = messagesTokens - specPlanTokens
 *   savingsPercent = round(realSavings / compactionTokenLimit * 100)
 *
 * The denominator is the model's auto-compaction limit (the same scale as the
 * compaction trigger and footer timer), so the percentage reflects
 * how much of the compaction budget will be reclaimed by handing off.
 */
export async function getContextSavingsPercentage(
  lastTokenUsage: number | null | undefined,
  specPlanText: string
): Promise<number> {
  if (
    lastTokenUsage === null ||
    lastTokenUsage === undefined ||
    lastTokenUsage === 0
  ) {
    return MIN_CONTEXT_SAVINGS_PERCENT;
  }

  try {
    const sessionService = getSessionService();
    const modelId = sessionService.getModel();

    if (modelId.startsWith('custom:')) {
      return MIN_CONTEXT_SAVINGS_PERCENT;
    }

    const compactionLimit =
      getSettingsService().getCompactionTokenLimitForModel(modelId);

    if (!Number.isFinite(compactionLimit) || compactionLimit <= 0) {
      return MIN_CONTEXT_SAVINGS_PERCENT;
    }

    const messageEvents = await sessionService.getAllMessageEvents();
    const rawMessages: RawMessage[] = messageEvents
      .filter((e) => e.message)
      .map((e) => {
        const msg = e.message;
        const content =
          typeof msg.content === 'string'
            ? [{ type: 'text', text: msg.content }]
            : (msg.content as unknown[]);
        return { role: msg.role, content };
      });

    const messagesTokens = approxTokensFromChars(
      measureMessagesChars(rawMessages)
    );
    const specPlanTokens = approxTokensFromChars(specPlanText.length);
    const realSavings = messagesTokens - specPlanTokens;

    const percent = Math.min(
      100,
      Math.max(
        MIN_CONTEXT_SAVINGS_PERCENT,
        Math.round((realSavings / compactionLimit) * 100)
      )
    );

    return percent;
  } catch {
    return MIN_CONTEXT_SAVINGS_PERCENT;
  }
}
