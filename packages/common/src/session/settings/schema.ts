import { z } from 'zod';

import {
  ROUTER_MODEL_IDS,
  ApiProvider,
  ModelID,
  ModelProvider,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import { type BuiltInModelID } from '@industry/drool-sdk-ext/protocol/llm';
import {
  SessionTagSchema,
  TokenUsageSchema as ProtocolTokenUsageSchema,
} from '@industry/drool-sdk-ext/protocol/session';

import {
  CompactionModelSchema,
  SessionDefaultSettingsSchema,
} from '../../settings/schema';

// common cannot export functions (no-restricted-syntax) or import @industry/utils,
// so this concrete-id check is local to the schema layer.
function isBuiltInModelIDValue(raw: string): raw is BuiltInModelID {
  for (const id of Object.values(ModelID)) {
    if (id === raw) return !ROUTER_MODEL_IDS.some((r) => r === id);
  }
  return false;
}

/** Cached router pick. modelId narrows to BuiltInModelID at parse time. */
export const EffectiveIndustryRouterModelSchema = z
  .object({
    modelId: z.string().transform((s, ctx): BuiltInModelID => {
      if (isBuiltInModelIDValue(s)) return s;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a built-in (non-router) model id, got: ${s}`,
      });
      return z.NEVER;
    }),
    apiProvider: z.nativeEnum(ApiProvider),
    reasoningEffort: z.nativeEnum(ReasoningEffort),
  })
  .strict();

/**
 * Session settings schema.
 * Settings persisted to .settings.json for each session.
 */
export const SessionSettingsSchema = SessionDefaultSettingsSchema.extend({
  providerLock: z.nativeEnum(ModelProvider).optional(),
  providerLockTimestamp: z.string().optional(),
  apiProviderLock: z.nativeEnum(ApiProvider).optional(),
  assistantActiveTimeMs: z.number().optional(),
  tokenUsage: ProtocolTokenUsageSchema.optional(),
  inclusiveTokenUsage: ProtocolTokenUsageSchema.optional(),
  childInclusiveTokenUsageBySessionId: z
    .record(ProtocolTokenUsageSchema)
    .optional(),

  /**
   * ISO timestamp when the session was archived.
   * Presence indicates archived status (omit to unarchive).
   */
  archivedAt: z.string().optional(),

  /** Session tags for categorization */
  tags: z.array(SessionTagSchema).optional(),

  /** Additional tool IDs enabled for this session */
  enabledToolIds: z.array(z.string()).optional(),

  /** Tool IDs explicitly disabled for this session */
  disabledToolIds: z.array(z.string()).optional(),

  compactionModel: CompactionModelSchema.optional().catch(undefined),
  /** Whether threshold-based automatic compaction is enabled for this session */
  compactionThresholdCheckEnabled: z.boolean().optional(),

  // catch keeps a stale cache entry (model left the registry) from failing the
  // whole settings parse and resetting the session to defaults.
  effectiveIndustryRouterModel:
    EffectiveIndustryRouterModelSchema.optional().catch(undefined),
});
