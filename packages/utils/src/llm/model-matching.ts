/**
 * Model matching utilities for fuzzy matching custom model IDs to built-in models.
 */

import { ModelID, ROUTER_MODEL_IDS } from '@industry/drool-sdk-ext/protocol/llm';

import { MODEL_REGISTRY, resolveModelId } from './model-registry';

/**
 * Find the closest matching ModelID for a custom model string.
 *
 * Strategies in order of priority:
 * 1. Exact match (via resolveModelId)
 * 2. Longest ModelID substring match (prioritizes specificity)
 * 3. Registry matchPatterns (regex patterns defined per model)
 *
 * @param modelString - The custom model ID string to match
 * @returns The matching ModelID or undefined if no match found
 */
export function findClosestModelId(modelString: string): ModelID | undefined {
  // 1. Exact match via existing resolveModelId
  const exact = resolveModelId(modelString);
  if (exact) return exact;

  const normalized = modelString.toLowerCase();
  const allModelIds = (Object.values(ModelID) as string[]).filter(
    (modelId) => !ROUTER_MODEL_IDS.some((routerId) => routerId === modelId)
  );

  // 2. Longest substring match
  // Sort by length descending to prefer longer/more specific matches
  // e.g., "gpt-5.1-codex-super-high" should match "gpt-5.1-codex" not "gpt-5.1"
  const sortedIds = [...allModelIds].sort((a, b) => b.length - a.length);
  for (const modelId of sortedIds) {
    if (normalized.includes(modelId.toLowerCase())) {
      return modelId as ModelID;
    }
  }

  // 3. Registry matchPatterns
  // Each model can define regex patterns for common variations
  // Collect all matches and pick the longest ModelID for specificity
  // (e.g., "gpt-5.1-codex" should win over "gpt-5.1" if both patterns match)
  const patternMatches: ModelID[] = [];
  for (const [modelId, config] of Object.entries(MODEL_REGISTRY)) {
    if (config.matchPatterns?.some((pattern) => pattern.test(normalized))) {
      patternMatches.push(modelId as ModelID);
    }
  }

  if (patternMatches.length > 0) {
    // Sort by length descending and then alphabetically for stable ordering
    patternMatches.sort((a, b) => b.length - a.length || a.localeCompare(b));
    return patternMatches[0];
  }

  return undefined;
}
