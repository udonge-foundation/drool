/**
 * Shared LLM constants.
 *
 * Model-specific configuration has been moved to @industry/utils/llm/model-registry.ts
 * Use the registry functions (getModel, getAllModels, etc.) for model configuration.
 */

/**
 * Default max output tokens for Claude/Anthropic-compatible models.
 * Used as fallback for non-OpenAI models.
 */
export const CLAUDE_MAX_OUTPUT_TOKENS = 32000;

/**
 * Header name used by OpenAI to attribute BYOK/proxy traffic to a specific
 * OpenAI Platform organization. Sent by the client on every request that
 * ultimately lands at OpenAI (including Azure-hosted OpenAI models and BYOK
 * OpenAI-compatible requests hitting api.openai.com).
 *
 * See: OpenAI's BYOK tracking guidance — pass `OpenAI-Platform: {org_id}`.
 */
export const OPENAI_PLATFORM_HEADER = 'OpenAI-Platform';

/**
 * Industry's OpenAI Platform organization id. Attached to every request that
 * hits OpenAI so OpenAI can attribute that traffic to Industry.
 */
export const INDUSTRY_OPENAI_ORG_ID = 'org-bHuLtG1fGmYk5YaOihAAXFBw';

export const INDUSTRY_ROUTER_DISPLAY_NAME = 'Auto Model' as const;
