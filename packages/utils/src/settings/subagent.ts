import type { SubagentTier } from './types';

export function subagentModelKey<T extends SubagentTier>(tier: T): `${T}Model` {
  return `${tier}Model`;
}

export function subagentReasoningKey<T extends SubagentTier>(
  tier: T
): `${T}ReasoningEffort` {
  return `${tier}ReasoningEffort`;
}
