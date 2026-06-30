/**
 * Shared math for the compaction meter shown in the built-in TUI footer,
 * `/context`, and the stdin payload handed to custom status line commands.
 *
 * Keeping a single implementation prevents the two indicators from drifting,
 * which was one of the failure modes described in FAC-18839.
 */

import type {
  ContextPercentageInput,
  ContextPercentageResult,
  LastCallCompactionTokensInput,
} from '@/utils/types';

const LESS_THAN_ONE_PERCENT = '<1%';

/**
 * Totals the latest provider-reported usage components used by threshold
 * compaction and the user-facing compaction meter.
 */
export function computeLastCallCompactionTokens(
  usage: LastCallCompactionTokensInput
): number {
  return usage.inputTokens + (usage.outputTokens ?? 0) + usage.cacheReadTokens;
}

export function computeContextPercentage(
  input: ContextPercentageInput
): ContextPercentageResult {
  const { lastTokenUsage, tokenLimit, systemPromptTokens } = input;

  const adjustedUsage = Math.max(0, lastTokenUsage - systemPromptTokens);
  const adjustedLimit = Math.max(1, tokenLimit - systemPromptTokens);

  const percentage = Math.min(
    100,
    Math.round((adjustedUsage / adjustedLimit) * 100)
  );

  const display =
    lastTokenUsage > 0 && percentage === 0
      ? LESS_THAN_ONE_PERCENT
      : `${percentage}%`;

  return { adjustedUsage, adjustedLimit, percentage, display };
}
