/**
 * Daemon-only settings schemas.
 * These are for settings that are stored/retrieved directly by the daemon
 * without forwarding to the CLI process.
 */
import z from 'zod';

import { AvailableModelConfigSchema } from '@industry/drool-sdk-ext/protocol/drool';
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  MissionModelSettingsSchema,
  SettingsLevel,
} from '@industry/drool-sdk-ext/protocol/settings';
import {
  AutonomyLevel,
  AutonomyMode,
  DroolInteractionModeSchema,
  JsonRpcBaseRequestSchema,
  JsonRpcBaseResponseFailureSchema,
  JsonRpcBaseResponseSuccessSchema,
} from '@industry/drool-sdk-ext/protocol/shared';

import { DaemonSettingsMethod } from './enums';
import {
  GeneralSettingsSchema,
  SessionDefaultSettingsSchema,
  SettingsResolutionEventSchema,
  SubagentModelSettingsSchema,
} from '../../settings/schema';

// Request params schemas
export const DaemonGetDefaultSettingsRequestParamsSchema = z.object({});
const DaemonSettingsManagementInfoSchema = z.object({
  disabled: z.boolean(),
  source: z.nativeEnum(SettingsLevel).nullable(),
  folderPath: z.string().optional(),
});
const DaemonSettingsManagementInfoFieldSchema =
  DaemonSettingsManagementInfoSchema.optional().catch(undefined);
const LegacyCompactionModelModeWireSchema = z.enum([
  'current-model',
  'industry-default',
]);
const DaemonSubagentDefaultsManagementMapSchema = z
  .object({
    lightModel: DaemonSettingsManagementInfoFieldSchema,
    lightReasoningEffort: DaemonSettingsManagementInfoFieldSchema,
    mediumModel: DaemonSettingsManagementInfoFieldSchema,
    mediumReasoningEffort: DaemonSettingsManagementInfoFieldSchema,
    heavyModel: DaemonSettingsManagementInfoFieldSchema,
    heavyReasoningEffort: DaemonSettingsManagementInfoFieldSchema,
  })
  .catch({});
const DaemonMissionDefaultsManagementMapSchema = z
  .object({
    orchestratorModel: DaemonSettingsManagementInfoFieldSchema,
    orchestratorReasoningEffort: DaemonSettingsManagementInfoFieldSchema,
    workerModel: DaemonSettingsManagementInfoFieldSchema,
    workerReasoningEffort: DaemonSettingsManagementInfoFieldSchema,
    validationWorkerModel: DaemonSettingsManagementInfoFieldSchema,
    validationWorkerReasoningEffort: DaemonSettingsManagementInfoFieldSchema,
    skipScrutiny: DaemonSettingsManagementInfoFieldSchema,
    skipUserTesting: DaemonSettingsManagementInfoFieldSchema,
  })
  .catch({});
export const DaemonSessionDefaultsManagementMapSchema = z
  .object({
    modelId: DaemonSettingsManagementInfoFieldSchema,
    reasoningEffort: DaemonSettingsManagementInfoFieldSchema,
    interactionMode: DaemonSettingsManagementInfoFieldSchema,
    autonomyLevel: DaemonSettingsManagementInfoFieldSchema,
    autonomyMode: DaemonSettingsManagementInfoFieldSchema,
    specModeModelId: DaemonSettingsManagementInfoFieldSchema,
    specModeReasoningEffort: DaemonSettingsManagementInfoFieldSchema,
    specSaveDir: DaemonSettingsManagementInfoFieldSchema,
    compactionTokenLimit: DaemonSettingsManagementInfoFieldSchema,
    compactionTokenLimitPerModel: DaemonSettingsManagementInfoFieldSchema,
    compactionModel: DaemonSettingsManagementInfoFieldSchema,
    compactionModelMode: DaemonSettingsManagementInfoFieldSchema,
    runInWorktree: DaemonSettingsManagementInfoFieldSchema,
    worktreeDirectory: DaemonSettingsManagementInfoFieldSchema,
    subagentAutonomyLevel: DaemonSettingsManagementInfoFieldSchema,
    subagent:
      DaemonSubagentDefaultsManagementMapSchema.optional().catch(undefined),
    mission:
      DaemonMissionDefaultsManagementMapSchema.optional().catch(undefined),
  })
  .catch({});

// Subagent complexity tiers that can be reset back to inheriting the spawning
// session's model.
const DaemonSubagentTierSchema = z.enum(['light', 'medium', 'heavy']);
export const DaemonUpdateSessionDefaultsRequestParamsSchema = z.object({
  modelId: SessionDefaultSettingsSchema.shape.model,
  reasoningEffort: SessionDefaultSettingsSchema.shape.reasoningEffort,
  interactionMode: SessionDefaultSettingsSchema.shape.interactionMode,
  autonomyLevel: SessionDefaultSettingsSchema.shape.autonomyLevel,
  specModeModelId: SessionDefaultSettingsSchema.shape.specModeModel.nullable(),
  specModeReasoningEffort:
    SessionDefaultSettingsSchema.shape.specModeReasoningEffort.nullable(),
  compactionTokenLimit: GeneralSettingsSchema.shape.compactionTokenLimit,
  compactionTokenLimitPerModel:
    GeneralSettingsSchema.shape.compactionTokenLimitPerModel,
  compactionModel: GeneralSettingsSchema.shape.compactionModel,
  compactionModelMode: LegacyCompactionModelModeWireSchema.optional().describe(
    'Deprecated wire input retained for existing daemon clients; use compactionModel instead.'
  ),
  subagentModelSettings: SubagentModelSettingsSchema.partial().optional(),
  subagentInheritTiers: z
    .array(DaemonSubagentTierSchema)
    .optional()
    .describe(
      'Complexity tiers to reset so they inherit the spawning session model.'
    ),
  subagentAutonomyLevel: GeneralSettingsSchema.shape.subagentAutonomyLevel
    .nullable()
    .optional(),
  specSaveDir: GeneralSettingsSchema.shape.specSaveDir.nullable().optional(),
  missionOrchestratorModel: GeneralSettingsSchema.shape.missionOrchestratorModel
    .nullable()
    .optional(),
  missionOrchestratorReasoningEffort:
    GeneralSettingsSchema.shape.missionOrchestratorReasoningEffort
      .nullable()
      .optional(),
  missionModelSettings: MissionModelSettingsSchema.partial().optional(),
  runInWorktree: SessionDefaultSettingsSchema.shape.runInWorktree
    .nullable()
    .optional(),
  worktreeDirectory: GeneralSettingsSchema.shape.worktreeDirectory
    .nullable()
    .optional(),
});

const DaemonSpecSavePresetsSchema = z
  .object({
    projectIndustryDir: z.string().optional(),
    userIndustryDir: z.string(),
  })
  .optional();

/**
 * Redacted view of one `customModels` entry from the user-level
 * `settings.json`. API keys never cross the wire: only `hasApiKey` plus a
 * display-safe `apiKeyMask` (`${VAR}` references verbatim, literal keys
 * masked to their last characters) are returned.
 *
 * `rawIndex` is the entry's position in the raw `customModels` array and is
 * the identifier used by upsert/delete; `model` doubles as a concurrency
 * guard via `expectedModel`.
 */
export const DaemonCustomModelSummarySchema = z.object({
  rawIndex: z.number(),
  model: z.string(),
  displayName: z.string().optional(),
  provider: z.string(),
  baseUrl: z.string().optional(),
  hasApiKey: z.boolean(),
  apiKeyMask: z.string().optional(),
  maxOutputTokens: z.number().optional(),
  noImageSupport: z.boolean().optional(),
  hasBedrockConfig: z.boolean(),
  isValid: z.boolean(),
});

export const DaemonListCustomModelsRequestParamsSchema = z.object({});

export const DaemonUpsertCustomModelRequestParamsSchema = z.object({
  rawIndex: z.number().optional().describe('Present when editing an entry.'),
  expectedModel: z
    .string()
    .optional()
    .describe(
      'Concurrency guard when editing: must match the current `model` of the entry at rawIndex.'
    ),
  model: z.string().min(1),
  displayName: z.string().optional(),
  provider: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z
    .string()
    .optional()
    .describe('Omitted on edit keeps the existing key.'),
  maxOutputTokens: z.number().nullable().optional(),
  noImageSupport: z.boolean().nullable().optional(),
});

export const DaemonDeleteCustomModelRequestParamsSchema = z.object({
  rawIndex: z.number(),
  expectedModel: z.string(),
});

// Request schemas
export const DaemonGetDefaultSettingsRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonSettingsMethod.GET_DEFAULT_SETTINGS),
    params: DaemonGetDefaultSettingsRequestParamsSchema,
  });

export const DaemonUpdateSessionDefaultsRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonSettingsMethod.UPDATE_SESSION_DEFAULTS),
    params: DaemonUpdateSessionDefaultsRequestParamsSchema,
  });

export const DaemonListCustomModelsRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonSettingsMethod.LIST_CUSTOM_MODELS),
    params: DaemonListCustomModelsRequestParamsSchema,
  });

export const DaemonUpsertCustomModelRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonSettingsMethod.UPSERT_CUSTOM_MODEL),
    params: DaemonUpsertCustomModelRequestParamsSchema,
  });

export const DaemonDeleteCustomModelRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonSettingsMethod.DELETE_CUSTOM_MODEL),
    params: DaemonDeleteCustomModelRequestParamsSchema,
  });

// Result schemas
export const DaemonGetDefaultSettingsResultSchema = z.object({
  autonomyMode: z
    .nativeEnum(AutonomyMode)
    .describe('Deprecated: use interactionMode + autonomyLevel instead.')
    .optional(),
  interactionMode: DroolInteractionModeSchema.optional().catch(undefined),
  autonomyLevel: z.nativeEnum(AutonomyLevel).optional().catch(undefined),
  maxAutonomyLevel: z.nativeEnum(AutonomyLevel).optional().catch(undefined),
  modelId: z.string().optional(),
  reasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
  specSaveDir: z.string().optional(),
  specModeModelId: z.string().optional(),
  specModeReasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
  compactionTokenLimit: z.number().optional(),
  compactionTokenLimitPerModel: z.record(z.number()).optional(),
  compactionModel: GeneralSettingsSchema.shape.compactionModel,
  compactionModelMode: LegacyCompactionModelModeWireSchema.optional().describe(
    'Deprecated wire view retained for existing daemon clients; use compactionModel instead.'
  ),
  runInWorktree: z.boolean().optional(),
  worktreeDirectory: z.string().optional(),
  management: DaemonSessionDefaultsManagementMapSchema.optional(),
  subagentAutonomyLevel: GeneralSettingsSchema.shape.subagentAutonomyLevel,
  missionOrchestratorModel: z.string().optional(),
  missionOrchestratorReasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
  missionSettings: MissionModelSettingsSchema.optional(),
  subagentModelSettings: SubagentModelSettingsSchema.optional(),
  availableModels: z.array(AvailableModelConfigSchema).optional(),
  specSavePresets: DaemonSpecSavePresetsSchema,
  resolutionChain: z
    .array(SettingsResolutionEventSchema)
    .optional()
    .catch(undefined),
});

export const DaemonUpdateSessionDefaultsResultSchema = z.object({
  success: z.boolean(),
  defaults: DaemonGetDefaultSettingsResultSchema,
});

export const DaemonListCustomModelsResultSchema = z.object({
  models: z.array(DaemonCustomModelSummarySchema),
});

export const DaemonUpsertCustomModelResultSchema = z.object({
  success: z.boolean(),
  models: z.array(DaemonCustomModelSummarySchema),
});

export const DaemonDeleteCustomModelResultSchema = z.object({
  success: z.boolean(),
  models: z.array(DaemonCustomModelSummarySchema),
});

// Response schemas
export const DaemonGetDefaultSettingsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: DaemonGetDefaultSettingsResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const DaemonUpdateSessionDefaultsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: DaemonUpdateSessionDefaultsResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const DaemonListCustomModelsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: DaemonListCustomModelsResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const DaemonUpsertCustomModelResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: DaemonUpsertCustomModelResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const DaemonDeleteCustomModelResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: DaemonDeleteCustomModelResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);
