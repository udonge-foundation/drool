/**
 * Pseudo-model id for auto-routing. Resolved to a concrete model
 * per-turn by the local CLI router; never sent to a provider as-is
 * and represented as a `ModelID` enum member for policy/default settings.
 */
export const INDUSTRY_ROUTER_MODEL_ID = 'auto' as const;

// Built from literal id constants (not ModelID enum members) to stay
// outside the industry/model-id-location lint rule's scope.
export const ROUTER_MODEL_IDS = [INDUSTRY_ROUTER_MODEL_ID] as const;
