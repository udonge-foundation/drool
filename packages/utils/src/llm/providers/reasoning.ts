import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

type OpenAIEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const CLAUDE_REASONING_BUDGET: Record<ReasoningEffort, number> = {
  [ReasoningEffort.Low]: 4096,
  [ReasoningEffort.Medium]: 4096 * 3,
  [ReasoningEffort.High]: 4096 * 6,
  [ReasoningEffort.ExtraHigh]: 4096 * 6,
  [ReasoningEffort.Max]: 0,
  [ReasoningEffort.Off]: 0,
  [ReasoningEffort.None]: 0,
  [ReasoningEffort.Dynamic]: 0,
  [ReasoningEffort.Minimal]: 0,
};

export function getClaudeReasoningTokens(effort: ReasoningEffort): number {
  return CLAUDE_REASONING_BUDGET[effort];
}

/**
 * Reconcile an enabled-thinking budget with the requested output cap so a
 * provider's `maxTokens > budgetTokens` invariant holds within the model
 * ceiling. No-op when the cap already clears the budget. When the budget
 * alone meets/exceeds the ceiling, lower the budget just under it (keeping as
 * much thinking as possible) rather than overshooting the cap. Shared by the
 * direct-Anthropic and Bedrock Converse request builders.
 */
export function clampMaxTokensAboveThinkingBudget({
  budgetTokens,
  requestedMaxTokens,
  ceiling,
}: {
  budgetTokens: number;
  requestedMaxTokens: number;
  ceiling: number | undefined;
}): { budgetTokens: number; maxTokens: number } {
  if (budgetTokens <= 0 || requestedMaxTokens > budgetTokens) {
    return { budgetTokens, maxTokens: requestedMaxTokens };
  }
  let budget = budgetTokens;
  if (ceiling !== undefined && budget >= ceiling) {
    budget = Math.max(ceiling - 1, 1);
  }
  const raised = budget + requestedMaxTokens;
  const maxTokens = ceiling !== undefined ? Math.min(raised, ceiling) : raised;
  return { budgetTokens: budget, maxTokens };
}

export function mapToOpenAIEffort(effort: ReasoningEffort): OpenAIEffort {
  if (effort === ReasoningEffort.Max) {
    return 'xhigh';
  }
  return effort.toLowerCase() as OpenAIEffort;
}
