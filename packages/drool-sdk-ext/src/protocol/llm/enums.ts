/**
 * ModelID enum defines unique identifiers for language models.
 *
 * These IDs are independent of provider (Anthropic, OpenAI, etc.) and reasoning effort (Low, Medium, High).
 * They represent the core model identity that remains consistent regardless of how the model is accessed.
 */
export enum ModelID {
  // Claude models
  CLAUDE_SONNET_3_5 = 'claude-3-5-sonnet-20241022',
  CLAUDE_SONNET_3_7 = 'claude-3-7-sonnet-20250219',
  CLAUDE_SONNET_4 = 'claude-sonnet-4-20250514',
  CLAUDE_OPUS_4 = 'claude-opus-4-1-20250805',
  CLAUDE_HAIKU_3_5 = 'claude-3-5-haiku-20241022',
  CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5-20250929',
  CLAUDE_OPUS_4_5 = 'claude-opus-4-5-20251101',
  CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5-20251001',
  CLAUDE_SONNET_4_6 = 'claude-sonnet-4-6',
  CLAUDE_OPUS_4_6 = 'claude-opus-4-6',
  CLAUDE_OPUS_4_6_FAST = 'claude-opus-4-6-fast',
  CLAUDE_OPUS_4_7 = 'claude-opus-4-7',
  CLAUDE_OPUS_4_7_FAST = 'claude-opus-4-7-fast',
  CLAUDE_OPUS_4_8 = 'claude-opus-4-8',
  CLAUDE_OPUS_4_8_FAST = 'claude-opus-4-8-fast',
  CLAUDE_FABLE_5 = 'claude-fable-5',
  ASPEN_0515 = 'aspen-05-15',
  ALMOND_0527 = 'almond-05-27',
  ANISE_0616 = 'anise-06-16',

  // OpenAI models
  GPT_5 = 'gpt-5-2025-08-07',
  GPT_5_MINI = 'gpt-5-mini-2025-08-07',
  GPT_5_NANO = 'gpt-5-nano-2025-08-07',
  GPT_5_CODEX = 'gpt-5-codex',
  GPT_5_1 = 'gpt-5.1',
  GPT_5_1_CODEX = 'gpt-5.1-codex',
  GPT_5_1_CODEX_MAX = 'gpt-5.1-codex-max',
  GPT_5_2 = 'gpt-5.2',
  GPT_5_2_CODEX = 'gpt-5.2-codex',
  GPT_5_3_CODEX = 'gpt-5.3-codex',
  GPT_5_3_CODEX_SPARK = 'gpt-5.3-codex-spark',
  GPT_5_3_CODEX_FAST = 'gpt-5.3-codex-fast',
  GPT_5_4 = 'gpt-5.4',
  GPT_5_4_FAST = 'gpt-5.4-fast',
  GPT_5_4_MINI = 'gpt-5.4-mini',
  GPT_5_5 = 'gpt-5.5',
  GPT_5_5_FAST = 'gpt-5.5-fast',
  GPT_5_5_PRO = 'gpt-5.5-pro',
  OLM_0305 = 'olm-03-05',
  ORBIT_0409 = 'orbit-04-09',
  OXIDE_0601 = 'oxide-06-01',
  OXBOW_0601 = 'oxbow-06-01',
  OWL_0621 = 'owl-06-21',

  // Google models
  GEMINI_2_5_FLASH = 'gemini-2.5-flash',
  GEMINI_2_5_PRO = 'gemini-2.5-pro',
  GEMINI_3_PRO = 'gemini-3-pro-preview',
  GEMINI_3_FLASH = 'gemini-3-flash-preview',
  GEMINI_3_1_PRO = 'gemini-3.1-pro-preview',
  GEMINI_3_5_FLASH = 'gemini-3.5-flash',
  GANTRY_0507 = 'gantry-05-07',

  // XAI models
  TITAN_0212 = 'titan-02-12',

  // Open source models
  GLM_4_6 = 'glm-4.6',
  GLM_4_7 = 'glm-4.7',
  KIMI_K2_5 = 'kimi-k2.5',
  KIMI_K2_6 = 'kimi-k2.6',
  KIMI_K2_7_CODE = 'kimi-k2.7-code',
  DEEPSEEK_V4_PRO = 'deepseek-v4-pro',
  MINIMAX_M2_5 = 'minimax-m2.5',
  MINIMAX_M2_7 = 'minimax-m2.7',
  MINIMAX_M3 = 'minimax-m3',
  GLM_5 = 'glm-5',
  GLM_5_1 = 'glm-5.1',
  GLM_5_2 = 'glm-5.2',
  NEMOTRON_3_ULTRA = 'nemotron-3-ultra',

  // Routers
  INDUSTRY_ROUTER = 'auto',
}

/**
 * Phase of an OpenAI Responses API assistant message (gpt-5.3-codex+).
 *
 * When a Codex model produces multi-part responses (e.g. a preamble followed by
 * a final answer), the API tags each output message item with a `phase` field.
 * We persist this value so that on the next turn we can send it back inside the
 * conversation history, which tells the API where the model left off and
 * prevents it from repeating or skipping phases (early-stopping avoidance).
 *
 * - `Commentary`: Intermediate commentary / preamble text.
 * - `FinalAnswer`: The definitive answer the model considers complete.
 *
 * The field is not yet part of the OpenAI Node SDK types (as of v6.21.0),
 * so we capture it via type cast from `response.output_item.done` events.
 */
export enum OpenAIPhase {
  Commentary = 'commentary',
  FinalAnswer = 'final_answer',
}

export enum ModelKind {
  Concrete = 'concrete',
  Router = 'router',
}

/**
 * Wire-format field name for assistant-message reasoning on the OpenAI
 * Chat Completions endpoint. OpenAI / XAI capture reasoning in `reasoning`;
 * vLLM / SGLang / Fireworks' Kimi deployments use `reasoning_content`.
 */
export enum ChatCompletionReasoningField {
  Reasoning = 'reasoning',
  ReasoningContent = 'reasoning_content',
}

/**
 * Enum defining the reasoning effort levels for LLMs.
 * This determines how much "thinking" the model does before responding.
 */
export enum ReasoningEffort {
  None = 'none',
  Dynamic = 'dynamic',
  Off = 'off',
  Minimal = 'minimal',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  ExtraHigh = 'xhigh',
  Max = 'max',
}

export enum ModelProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  GENERIC_CHAT_COMPLETION_API = 'generic-chat-completion-api',
  INDUSTRY = 'industry',
  GOOGLE = 'google',
  XAI = 'xai',
  VOYAGE = 'voyage',
  /**
   * BYOK custom models served over the AWS Bedrock Converse API
   * (`ConverseStream`). Distinct from {@link ModelProvider.ANTHROPIC}
   * Bedrock routing (which speaks the Anthropic Messages dialect over the
   * Bedrock SDK): this provider speaks the native Converse schema and is
   * never used for first-party / proxy-routed models.
   */
  BEDROCK_CONVERSE = 'bedrock-converse',
}

export enum ApiProvider {
  BEDROCK = 'bedrock', // Ideally we deprecate!
  ANTHROPIC = 'anthropic',
  VERTEX_ANTHROPIC = 'vertex_anthropic', // A minimal wrapper for Anthropic's API on GCP
  BEDROCK_ANTHROPIC = 'bedrock_anthropic', // A minimal wrapper for Anthropic's API on AWS
  BEDROCK_CONVERSE = 'bedrock_converse', // BYOK custom models over the Bedrock Converse API (metric labeling only)
  BEDROCK_OPENAI = 'bedrock_openai', // OpenAI Responses-compatible API on AWS Bedrock
  OPENAI = 'openai',
  AZURE_OPENAI = 'azure_openai',
  GOOGLE = 'google',
  XAI = 'xai',
  FIREWORKS = 'fireworks',
  BASETEN = 'baseten',
  SNOWFLAKE = 'snowflake',
}

export enum LLMModelTier {
  Standard = 'standard',
  // Deprecated
  Premium = 'premium',
  // Extra Usage (overage) billing tier
  Overage = 'overage',
}

/**
 * Billing pool for token rate limits.
 * - 'standard': Regular models that consume standard pool tokens
 * - 'core': Free tier models (GLM, Kimi) that consume core pool tokens
 */
export enum BillingPool {
  Standard = 'standard',
  Core = 'core',
}
