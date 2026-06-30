import { z } from 'zod';

/**
 * Token usage schema for session settings.
 * Tracks LLM token consumption for a session.
 */
export const TokenUsageSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheCreationTokens: z.number(),
    cacheReadTokens: z.number(),
    thinkingTokens: z.number(),
    industryCredits: z.number().optional(),
  })
  .strip();
