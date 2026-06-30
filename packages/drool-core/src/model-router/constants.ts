/** Minimum score for a candidate to enter the cheapest-above-threshold pool. */
export const QUALITY_THRESHOLD = 0.7;

/** Token budget for the dynamic session-context section of a classifier call. */
export const CONTEXT_LIMIT_TOKENS = 16_000;

export const KEEP_HEAD_LENGTH = 2_000;
export const KEEP_TAIL_LENGTH = 2_000;
export const RECENT_MESSAGE_COUNT = 6;

export const DEFAULT_TASK_CLASSIFIER_MODEL_ID = 'gpt-5.4-mini';

/**
 * `Llm` carries the actual classifier model id so telemetry dashboards
 * automatically track it whenever the default classifier moves. Const
 * object (not enum) so members can reference external constants.
 */
export const ClassifierSource = {
  Llm: DEFAULT_TASK_CLASSIFIER_MODEL_ID,
  Fallback: 'fallback',
} as const;

/** Operational ceiling on a single classifier call before fallback fires. */
export const CLASSIFIER_TIMEOUT_MS = 10_000;
export const CLASSIFIER_MAX_COMPLETION_TOKENS = 2048;
export const MAX_RECENT_TOOL_CALLS = 8;
export const CHARS_PER_TOKEN_ESTIMATE = 4;
