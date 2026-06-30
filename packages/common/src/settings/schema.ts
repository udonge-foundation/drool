import { z } from 'zod';

import { DroolHookEventSchema } from '@industry/drool-sdk-ext/protocol/drool';
import {
  INDUSTRY_ROUTER_MODEL_ID,
  ModelID,
  ReasoningEffort,
} from '@industry/drool-sdk-ext/protocol/llm';
import {
  CustomModelsSchema,
  McpOAuthConfigSchema,
  SandboxModeSchema,
  MissionModelSettingsSchema,
  SettingsLevel,
} from '@industry/drool-sdk-ext/protocol/settings';
import {
  AutonomyLevel,
  AutonomyMode,
  DroolInteractionModeSchema,
} from '@industry/drool-sdk-ext/protocol/shared';

import {
  CURRENT_COMPACTION_MODEL,
  INDUSTRY_ROUTER_GUIDANCE_MAX_LENGTH,
  INDUSTRY_ROUTER_RULE_GUIDANCE_MAX_LENGTH,
  INDUSTRY_ROUTER_RULE_WHEN_MAX_LENGTH,
  INDUSTRY_ROUTER_RULES_MAX_COUNT,
} from './constants';
import {
  DiffMode,
  McpImpactLevel,
  SoundFocusMode,
  SubagentAutonomyLevel,
  SubagentSoundMode,
  TodoDisplayMode,
} from './enums';
import { LogoAnimationMode, ToolResultDisplay } from '../cli/enums';
import { IndustryTier } from '../organization/enums';
import { MODEL_EXPLICIT_OPT_IN_INTENDED_USE_MAX_LENGTH } from '../policy/constants';
import { UserModelPolicySchema } from '../policy/schemas';

// =============================================================================
// Session Default Settings Schema
// =============================================================================

const ReasoningEffortSchema = z.nativeEnum(ReasoningEffort);

export const AutonomyModeSchema = z.nativeEnum(AutonomyMode);

const FIRST_COMPACTION_MODEL_ID = 'claude-3-5-sonnet-20241022';
const LEGACY_COMPACTION_MODEL_IDS = [
  'olive-05-22',
  'oriel-06-01',
  'ocelot-06-01',
  'okappa-alpha',
  'omaffa-alpha',
] as const;
const CompactionModelIdValues: [string, ...string[]] = [
  FIRST_COMPACTION_MODEL_ID,
  ...[...Object.values(ModelID), ...LEGACY_COMPACTION_MODEL_IDS].filter(
    (modelId) =>
      modelId !== INDUSTRY_ROUTER_MODEL_ID &&
      modelId !== FIRST_COMPACTION_MODEL_ID
  ),
];

export const CompactionModelSchema = z.union([
  z.literal(CURRENT_COMPACTION_MODEL),
  z.enum(CompactionModelIdValues),
  z.string().regex(/^custom:.+$/, 'Expected a custom model id'),
]);

export const SessionDefaultSettingsSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  interactionMode: DroolInteractionModeSchema.optional(),
  autonomyLevel: z.nativeEnum(AutonomyLevel).optional(),
  autonomyMode: AutonomyModeSchema.optional().describe(
    'Deprecated: use interactionMode + autonomyLevel instead.'
  ),
  specModeModel: z.string().optional(),
  specModeReasoningEffort: ReasoningEffortSchema.optional(),
  /**
   * When true, new sessions started against a git repo are created in an
   * isolated worktree. Gated behind the `DesktopWorktrees` feature flag in
   * the desktop UI.
   */
  runInWorktree: z.boolean().optional(),
});

// =============================================================================
// Model Policy Schema (for org-level model access control)
// =============================================================================

/**
 * A lenient model ID array that silently drops unrecognized values instead of
 * failing validation. This is critical for backward compatibility: when a ModelID
 * enum value is removed (e.g. after an EAP model cleanup), any Firestore
 * documents still referencing the old ID will have it filtered out rather than
 * causing the entire settings object to fail parsing.
 */
const modelIdValues: ReadonlySet<string> = new Set(Object.values(ModelID));
const tolerantModelIdArray = z
  .array(z.string())
  .transform((ids) => ids.filter((id): id is ModelID => modelIdValues.has(id)));
const strictModelIdArray = z.array(z.nativeEnum(ModelID));

export const ModelPolicySchema = z.object({
  allowedModelIds: tolerantModelIdArray.optional(),
  blockedModelIds: tolerantModelIdArray.optional(),
  allowCustomModels: z.boolean().optional(),
  allowedBaseUrls: z.array(z.string()).optional(),
  allowAllIndustryModels: z.boolean().optional(),
  isFastModelsAllowed: z.boolean().optional(),
  requireExplicitOptInModelIds: tolerantModelIdArray.optional(),
  allowIndustryRouterByok: z.boolean().optional(),
});

// =============================================================================
// Plugin Schemas
// =============================================================================

// Plugin scope schema - uses SettingsLevel values but excludes 'folder' (plugins can't be installed at folder level)
const PluginScopeSchema = z.enum([
  SettingsLevel.Org,
  SettingsLevel.User,
  SettingsLevel.Project,
]);

const PluginAuthorSchema = z.object({
  name: z.string(),
  email: z.string().email().optional(),
  url: z.string().url().optional(),
});

const InstalledNpmMetadataSchema = z.object({
  spec: z.string(),
  version: z.string(),
  resolved: z.string().optional(),
  integrity: z.string().optional(),
});

const InstalledPluginEntrySchema = z.object({
  scope: PluginScopeSchema,
  installPath: z.string(),
  version: z.string(),
  installedAt: z.string(),
  lastUpdated: z.string(),
  // Source is a string identifier (e.g., "github:owner/repo" or marketplace name)
  // Not MarketplaceSourceSchema to keep plugin tracking simple
  source: z.string(),
  // npm-source plugins additionally record the resolved package metadata
  // so auto-update can detect new publishes for `latest`/range specs and so
  // the installed cache identity ties to the npm version, not the wrapper
  // marketplace's git revision.
  npm: InstalledNpmMetadataSchema.optional(),
});

export const InstalledPluginsRegistrySchema = z.object({
  schemaVersion: z.number(),
  plugins: z.record(z.array(InstalledPluginEntrySchema)),
});

// =============================================================================
// Marketplace Schemas
// =============================================================================

// A Git branch or tag name. A full commit SHA must use the `sha` field.
const GitRefSchema = z.string().trim().min(1);
// A full 40-character Git commit SHA (matches Claude Code's plugin source schema).
const GitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, 'Expected a full 40-character commit SHA');

const GitHubMarketplaceSourceSchema = z.object({
  source: z.literal('github'),
  repo: z.string(),
  ref: GitRefSchema.optional(),
  sha: GitShaSchema.optional(),
});

const UrlMarketplaceSourceSchema = z.object({
  source: z.literal('url'),
  url: z.string(),
  ref: GitRefSchema.optional(),
  sha: GitShaSchema.optional(),
});

const LocalMarketplaceSourceSchema = z.object({
  source: z.literal('local'),
  path: z.string(),
});

const GitSubdirMarketplaceSourceSchema = z.object({
  source: z.literal('git-subdir'),
  url: z.string(),
  path: z.string(),
  ref: GitRefSchema.optional(),
  sha: GitShaSchema.optional(),
});

export const MarketplaceSourceSchema = z.discriminatedUnion('source', [
  GitHubMarketplaceSourceSchema,
  UrlMarketplaceSourceSchema,
  LocalMarketplaceSourceSchema,
  GitSubdirMarketplaceSourceSchema,
]);

// npm package names: scoped (`@scope/name`) or unscoped. Allow lowercase
// letters, digits, `_`, `-`, `.`, and a single optional scope prefix.
const NpmPackageNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
    'Expected an npm package name (e.g. "lodash" or "@scope/pkg")'
  );

// npm version/range/dist-tag. Reject specs that would bypass the
// package-name + registry contract: file:, git+https:, http:, npm: aliases,
// tarball URLs, and relative or absolute paths. Allows exact versions
// (`2.1.0`), ranges (`^2.0.0`, `~1.5.0`, `>=1 <2`, `1.x`, `*`), and
// dist-tags (`latest`, `next`).
const NpmVersionSpecSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !/[:/\\]/.test(v) && !v.startsWith('.'), {
    message:
      'Expected a semver version, range, or dist-tag (e.g. "2.1.0", "^2.0.0", "latest"); file/git/url/path/alias specs are not accepted',
  });

// Plugin-only registry URL. Tighter than `z.string().url()`: require https,
// no embedded userinfo, no query, no fragment. Hostnames are unrestricted
// so internal/private registries continue to work.
const NpmRegistryUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.username !== '' || parsed.password !== '') return false;
      if (parsed.search !== '' || parsed.hash !== '') return false;
      return true;
    },
    {
      message:
        'Expected an https registry URL with no embedded credentials, query string, or fragment',
    }
  );

// Plugin-only source. Not part of MarketplaceSourceSchema, so it's only
// accepted inside an individual plugin entry's `source` field — matching
// Claude Code, which rejects `npm` as a marketplace source.
const NpmAuthTokenEnvVarSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Expected a valid environment variable name (e.g. "JFROG_NPM_TOKEN")'
  );

export const NpmMarketplacePluginSourceSchema = z.object({
  source: z.literal('npm'),
  package: NpmPackageNameSchema,
  version: NpmVersionSpecSchema.optional(),
  registry: NpmRegistryUrlSchema.optional(),
  authTokenEnvVar: NpmAuthTokenEnvVarSchema.optional(),
});

const MarketplaceEntrySchema = z.object({
  source: MarketplaceSourceSchema,
  installLocation: z.string(),
  lastUpdated: z.string(),
  autoUpdate: z.boolean().default(true),
});

export const KnownMarketplacesRegistrySchema = z.record(MarketplaceEntrySchema);

// Plugin entries in third-party manifests may use source types we don't know about yet.
// Accept known types with full validation, fall through to a generic object for unknown ones.
// The refine guard ensures malformed known sources (e.g. git-subdir missing path) are
// rejected rather than silently accepted as unknown.
const knownSourceTypes = new Set([
  'github',
  'url',
  'local',
  'git-subdir',
  'npm',
]);

const MarketplacePluginSourceSchema = z.union([
  z.string(),
  MarketplaceSourceSchema,
  NpmMarketplacePluginSourceSchema,
  z
    .object({ source: z.string() })
    .passthrough()
    .refine((obj) => !knownSourceTypes.has(obj.source), {
      message: 'Known source type with invalid shape',
    }),
]);

const MarketplacePluginEntrySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: MarketplacePluginSourceSchema,
  category: z.string().optional(),
  homepage: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const MarketplaceManifestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  owner: PluginAuthorSchema.optional(),
  plugins: z.array(MarketplacePluginEntrySchema),
});

const ExtraMarketplaceEntrySchema = z.object({
  source: MarketplaceSourceSchema,
});

// =============================================================================
// MCP Policy Schema (for org-level MCP server access control)
// =============================================================================

export const McpPolicySchema = z.object({
  enabled: z.boolean().default(false),
  allowlist: z.array(z.string()).optional(),
});

// =============================================================================
// Mission Policy Schema (for org-level missions access control)
// =============================================================================

export const MissionPolicySchema = z.object({
  restrictedAccess: z.boolean().default(false),
  allowedUserIds: z.array(z.string()).optional(),
});

// =============================================================================
// Network Policy Schema (for org-level network access control)
// IP format validation is handled by @industry/utils/ip (isValidIpOrCidr).
// The schema only enforces shape: non-empty array of trimmed strings.
// =============================================================================

const NetworkPolicySchema = z.object({
  allowedIps: z
    .array(z.string().trim())
    .min(1, 'IP allowlist must contain at least one entry when enabled'),
});

// =============================================================================
// Sandbox Settings Schema
// =============================================================================

export const SandboxFilesystemSettingsSchema = z.object({
  allowWrite: z.array(z.string()).optional(),
  allowRead: z.array(z.string()).optional(),
  denyWrite: z.array(z.string()).optional(),
  denyRead: z.array(z.string()).optional(),
});

export const SandboxNetworkSettingsSchema = z.object({
  allowedDomains: z.array(z.string()).optional(),
  allowUnixSockets: z.array(z.string()).optional(),
  allowAllUnixSockets: z.boolean().optional(),
  allowLocalBinding: z.boolean().optional(),
  httpProxyPort: z.number().optional(),
  socksProxyPort: z.number().optional(),
});

export const SandboxSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: SandboxModeSchema.optional(),
  filesystem: SandboxFilesystemSettingsSchema.optional(),
  network: SandboxNetworkSettingsSchema.optional(),
});

export const HookCommandSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  timeout: z.number().optional(),
});

export const HookConfigSchema = z.object({
  matcher: z.string().optional(),
  commandRegex: z.string().optional(),
  hooks: z.array(HookCommandSchema),
});

const HookConfigArraySchema = z.array(HookConfigSchema);

// Event keys reference the canonical DroolHookEventSchema enum so they stay in
// sync with the rest of the system. Non-strict like other nested
// managed-settings objects; unknown event keys are warned about at the
// ingestion boundary rather than rejected.
export const HookSettingsSchema = z.object({
  [DroolHookEventSchema.enum.PreToolUse]: HookConfigArraySchema.optional(),
  [DroolHookEventSchema.enum.PostToolUse]: HookConfigArraySchema.optional(),
  [DroolHookEventSchema.enum.Notification]: HookConfigArraySchema.optional(),
  [DroolHookEventSchema.enum.UserPromptSubmit]:
    HookConfigArraySchema.optional(),
  [DroolHookEventSchema.enum.Stop]: HookConfigArraySchema.optional(),
  [DroolHookEventSchema.enum.SubagentStop]: HookConfigArraySchema.optional(),
  [DroolHookEventSchema.enum.PreCompact]: HookConfigArraySchema.optional(),
  [DroolHookEventSchema.enum.SessionStart]: HookConfigArraySchema.optional(),
  [DroolHookEventSchema.enum.SessionEnd]: HookConfigArraySchema.optional(),
  hooksDisabled: z.boolean().optional(),
  showHookOutput: z.boolean().optional(),
});

// =============================================================================
// Session Retention Constants
// =============================================================================

export const SESSION_RETENTION_MIN_DAYS = 14;
export const SESSION_RETENTION_MAX_DAYS = 365;

export const IndustryRouterRuleSchema = z.object({
  when: z.string().max(INDUSTRY_ROUTER_RULE_WHEN_MAX_LENGTH).optional(),
  guidance: z.string().max(INDUSTRY_ROUTER_RULE_GUIDANCE_MAX_LENGTH),
});

// =============================================================================
// Managed Settings Schema
// =============================================================================

const McpAutonomyLevelSchema = z.enum([
  AutonomyLevel.Low,
  AutonomyLevel.Medium,
  AutonomyLevel.High,
]);

const McpAutonomyUrlOverrideSchema = z.object({
  urlPattern: z.string().trim().min(1),
  defaultLevel: McpAutonomyLevelSchema,
});

// Compile-time guard: every `AutonomyLevel` value must also exist on
// `SubagentAutonomyLevel` (which adds `inherit`). `enums.ts` cannot import
// `AutonomyLevel`, so the shared values are mirrored there and verified here.
// Adding a value to `AutonomyLevel` without mirroring it breaks this build.
type AssertTrue<T extends true> = T;
type _SubagentAutonomyLevelInSync = AssertTrue<
  `${AutonomyLevel}` extends `${SubagentAutonomyLevel}` ? true : false
>;

const SubagentAutonomyLevelSchema = z.nativeEnum(SubagentAutonomyLevel);

const ManagedSettingsBaseSchema = z.object({
  sessionDefaultSettings: SessionDefaultSettingsSchema.optional(),
  maxAutonomyLevel: z.nativeEnum(AutonomyLevel).optional(),
  subagentAutonomyLevel: SubagentAutonomyLevelSchema.optional(),
  mcpAutonomyOverrides: z
    .record(
      z.string(),
      z.object({
        defaultLevel: McpAutonomyLevelSchema.optional(),
        tools: z.record(z.string(), McpAutonomyLevelSchema).optional(),
      })
    )
    .optional(),
  mcpAutonomyUrlOverrides: z.array(McpAutonomyUrlOverrideSchema).optional(),
  cloudSessionSync: z.boolean().optional(),
  wikiCloudSync: z.boolean().optional(),
  advancedAnalyticsEnabled: z.boolean().optional(),
  includeCoAuthoredByDrool: z.boolean().optional(),
  enableDroolShield: z.boolean().optional(),
  ideAutoConnect: z.boolean().optional(),
  commandAllowlist: z.array(z.string()).optional(),
  commandDenylist: z.array(z.string()).optional(),
  commandBlocklist: z.array(z.string()).optional(),
  customModels: CustomModelsSchema.optional(),
  modelPolicy: ModelPolicySchema.optional(),
  mcpPolicy: McpPolicySchema.optional(),
  missionPolicy: MissionPolicySchema.optional(),
  userModelPolicies: z.record(z.string(), UserModelPolicySchema).optional(),
  enabledPlugins: z.record(z.boolean()).optional(),
  extraKnownMarketplaces: z.record(ExtraMarketplaceEntrySchema).optional(),
  strictKnownMarketplaces: z.array(MarketplaceSourceSchema).optional(),
  networkPolicy: NetworkPolicySchema.optional(),
  sandbox: SandboxSettingsSchema.optional(),
  allowManagedHooksOnly: z.boolean().optional(),
  hooks: HookSettingsSchema.optional(),
  restrictMemberVisibility: z.boolean().optional(),
  restrictApiKeyCreationToManagers: z.boolean().optional(),
  managedComputersEnabled: z.boolean().optional(),
  managedComputersAllowedEmails: z.array(z.string().trim()).optional(),
  byomComputersEnabled: z.boolean().optional(),
  byomComputersAllowedEmails: z.array(z.string().trim()).optional(),
  disableAutoUpdate: z.boolean().optional(),
  sessionRetentionDays: z
    .number()
    .int()
    .min(SESSION_RETENTION_MIN_DAYS)
    .max(SESSION_RETENTION_MAX_DAYS)
    .optional(),
  industryRouterGuidance: z
    .string()
    .max(INDUSTRY_ROUTER_GUIDANCE_MAX_LENGTH)
    .optional(),
  industryRouterRules: z
    .array(IndustryRouterRuleSchema)
    .max(INDUSTRY_ROUTER_RULES_MAX_COUNT)
    .optional(),
});

/**
 * Extends the base schema with deprecated fields so they are parsed (not
 * rejected) and then stripped from the output via .omit().
 */
const ManagedSettingsWithDeprecatedSchema = ManagedSettingsBaseSchema.extend({
  allowBackgroundProcesses: z.unknown().optional(),
});

export const ManagedSettingsSchema =
  ManagedSettingsWithDeprecatedSchema.transform(
    ({ allowBackgroundProcesses: _deprecated, ...rest }) => rest
  );

/**
 * Strict version of ManagedSettingsSchema that rejects unrecognized top-level keys.
 * Used for write paths (backend update endpoint, frontend admin UI validation)
 * to prevent silently storing incomplete or wrong-schema objects.
 *
 * Note: .strict() only applies to the top-level object. Nested object schemas
 * (e.g. SessionDefaultSettingsSchema, ModelPolicySchema) remain lenient --
 * unknown keys inside them are silently stripped, not rejected.
 * Zod does not support deep/recursive strict mode.
 */
export const StrictManagedSettingsSchema = ManagedSettingsBaseSchema.strict();

/**
 * Lenient version of ManagedSettingsSchema that allows unrecognized keys.
 * Used when reading stored data from Firestore, which may contain fields
 * from newer app versions.
 */
export const StoredManagedSettingsSchema =
  ManagedSettingsBaseSchema.passthrough().transform(
    ({ allowBackgroundProcesses: _deprecated, ...rest }) => rest
  );

// =============================================================================
// Managed Settings Response Schema (for API responses)
// =============================================================================

export const ValidationErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const ManagedSettingsResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    settings: ManagedSettingsSchema.nullable(),
    revision: z.number().optional(),
    industryTier: z.nativeEnum(IndustryTier).optional(),
    isUnpaidEnterprise: z.boolean().optional(),
    approvedExplicitModelOptInModelIds: z
      .array(z.nativeEnum(ModelID))
      .optional(),
    hasStoredSettings: z.boolean().optional(),
    /**
     * Caller IP (from `x-real-ip`), for the network-policy UI's "your
     * current IP". Set only by the admin variant; `null` if no header.
     */
    clientIp: z.string().nullable().optional(),
  }),
  z.object({
    success: z.literal(false),
    errors: z.array(ValidationErrorSchema),
  }),
]);

export const ManagedSettingsUpdateRequestSchema = z.object({
  settings: StrictManagedSettingsSchema,
  revision: z.number(),
  explicitModelOptInModelIds: strictModelIdArray.optional(),
  explicitModelOptInIntendedUse: z
    .record(
      z.nativeEnum(ModelID),
      z.string().max(MODEL_EXPLICIT_OPT_IN_INTENDED_USE_MAX_LENGTH)
    )
    .optional(),
});

// =============================================================================
// Managed Settings Version History Schemas
// =============================================================================

export const ManagedSettingsVersionSchema = z.object({
  revision: z.number(),
  settings: StoredManagedSettingsSchema,
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export const ManagedSettingsHistoryResponseSchema = z.object({
  versions: z.array(ManagedSettingsVersionSchema),
  nextCursor: z.string().nullable(),
});

// =============================================================================
// General Settings Schema (CLI settings.json / settings.local.json)
// =============================================================================

const StatusLineConfigSchema = z.object({
  type: z.literal('command').optional(),
  command: z.string(),
  padding: z.number().optional(),
  maxRows: z.number().int().min(1).max(3).optional(),
});

export const SubagentModelSettingsSchema = z.object({
  lightModel: z.string().optional(),
  lightReasoningEffort: ReasoningEffortSchema.optional(),
  mediumModel: z.string().optional(),
  mediumReasoningEffort: ReasoningEffortSchema.optional(),
  heavyModel: z.string().optional(),
  heavyReasoningEffort: ReasoningEffortSchema.optional(),
});

const TrustedFolderEntrySchema = z.object({
  trustedAt: z.string(),
});

const TrustedFoldersSchema = z.record(TrustedFolderEntrySchema);

export const GeneralSettingsSchema = ManagedSettingsBaseSchema.extend({
  diffMode: z.nativeEnum(DiffMode).optional(),
  ideExtensionPromptedAt: z.record(z.number()).optional(),
  ideActivationNudgedForVersion: z.record(z.string()).optional(),
  enableCompletionBell: z.boolean().optional(),
  completionSound: z.string().optional(),
  awaitingInputSound: z.string().optional(),
  soundFocusMode: z.nativeEnum(SoundFocusMode).optional(),
  completionSoundFocusMode: z.nativeEnum(SoundFocusMode).optional(),
  awaitingInputSoundFocusMode: z.nativeEnum(SoundFocusMode).optional(),
  specSaveEnabled: z.boolean().optional(),
  specSaveDir: z.string().optional(),
  todoDisplayMode: z.nativeEnum(TodoDisplayMode).optional(),
  toolResultDisplay: z.nativeEnum(ToolResultDisplay).optional(),
  showThinkingInMainView: z.boolean().optional(),
  keepSystemAwakeDuringMissions: z.boolean().optional(),
  showTokenUsageIndicator: z.boolean().optional(),
  missionOrchestratorModel: z.string().optional(),
  missionOrchestratorReasoningEffort: ReasoningEffortSchema.optional(),
  modelFavorites: z.array(z.string()).optional(),
  dismissedNewModels: z.array(z.string()).optional(),
  logoAnimation: z.nativeEnum(LogoAnimationMode).optional(),
  missionModelSettings: MissionModelSettingsSchema.optional(),
  subagentModelSettings: SubagentModelSettingsSchema.optional(),
  statusLine: StatusLineConfigSchema.optional(),
  theme: z.string().optional(),
  overrideTerminalColors: z.boolean().optional(),
  hasSeenMissionOnboarding: z.boolean().optional(),
  reauthBannerShownTui: z.boolean().optional(),
  worktreeDirectory: z.string().optional(),
  windowZoomLevel: z.number().finite().optional(),
  remoteAccessEnabled: z.boolean().optional(),
  automationQuitWarningDismissed: z.boolean().optional(),
  llmRequestTimeout: z.number().min(1000).optional(),
  subagentInactivityTimeout: z.number().min(1000).optional(),
  subagentSounds: z.nativeEnum(SubagentSoundMode).optional(),
  nerdFont: z.boolean().optional(),
  compactionTokenLimit: z.number().optional(),
  compactionTokenLimitPerModel: z.record(z.number()).optional(),
  compactionModel: CompactionModelSchema.optional(),
  trustedFolders: TrustedFoldersSchema.optional(),
  modelFallbacks: z.record(z.string(), z.string()).optional(),
});

// =============================================================================
// MCP Settings Schemas
// =============================================================================

/**
 * Schema for validating STDIO transport MCP server configurations.
 * The `type` field is optional and defaults to 'stdio' for backward compatibility.
 */
const McpStdioServerBaseSchema = z.object({
  type: z.literal('stdio').optional().default('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * Schema for validating streamable HTTP MCP server configurations.
 */
const McpHttpServerBaseSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: McpOAuthConfigSchema.optional(),
});

/**
 * Schema for validating SSE MCP server configurations.
 */
const McpSseServerBaseSchema = z.object({
  type: z.literal('sse'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: McpOAuthConfigSchema.optional(),
});

/**
 * Discriminated union of all supported MCP server base configurations.
 * Note: McpStdioServerBaseSchema must come first for proper parsing of configs without `type`.
 */
export const McpServerBaseSchema = z.discriminatedUnion('type', [
  McpStdioServerBaseSchema,
  McpHttpServerBaseSchema,
  McpSseServerBaseSchema,
]);

/**
 * Full MCP server config including disabled state, tool settings, and call timeout.
 */
export const McpServerConfigSchema = McpServerBaseSchema.and(
  z.object({
    disabled: z.boolean().optional().default(false),
    disabledTools: z.array(z.string()).optional(),
    timeout: z.number().int().positive().max(2_147_483_647).optional(),
  })
);

/**
 * Schema for persistent MCP tool permissions.
 * Allows users to approve MCP tools once and have that approval persist across sessions.
 *
 * `serverIdentity` is a stable fingerprint of the approved server's transport
 * config (stdio command+args, or http/sse url). When set, auto-approval is
 * gated on the current server config producing the same fingerprint — so
 * re-pointing a previously trusted server name at a different command/URL
 * does NOT inherit the approval. Optional for backward compatibility with
 * entries written before this field was added.
 */
const McpPersistentPermissionEntrySchema = z.object({
  approvedAt: z.string(),
  impactLevel: z.nativeEnum(McpImpactLevel),
  serverIdentity: z.string().optional(),
});

export const McpPersistentPermissionsSchema = z.object({
  // Server-level: auto-approve ALL tools from this server.
  servers: z.record(z.string(), McpPersistentPermissionEntrySchema).optional(),
  // Tool-level: approve specific tools, nested by server. Previously this
  // was a flat map keyed by `${serverName}___${toolName}`, but that scheme
  // is ambiguous when names contain triple-underscores (e.g. `a` + `b___c`
  // would collide with `a___b` + `c`). The load path migrates flat keys
  // forward; new writes always use the nested shape.
  tools: z
    .record(
      z.string(),
      z.record(z.string(), McpPersistentPermissionEntrySchema)
    )
    .optional(),
});

/**
 * Schema for the entire MCP configuration file.
 */
export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema),
  persistentPermissions: McpPersistentPermissionsSchema.optional(),
});

// =============================================================================
// Drool/Skill Frontmatter Schemas (for plugin loading)
// =============================================================================

export const DroolFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  tools: z.union([z.string(), z.array(z.string())]).optional(),
  mcpServers: z
    .preprocess(
      (value) =>
        typeof value === 'string'
          ? value
              .split(',')
              .map((server) => server.trim())
              .filter((server) => server.length > 0)
          : value,
      z.array(z.string())
    )
    .optional(),
});

/**
 * Skill frontmatter schema aligned with the Agent Skills specification
 * (https://agentskills.io/specification).
 *
 * Core agentskills.io fields: name, description, license, compatibility, metadata, allowed-tools.
 * Industry extensions: tools (deprecated, use allowed-tools), enabled, user-invocable, disable-model-invocation.
 *
 */
export const SkillFrontmatterSchema = z.object({
  // --- agentskills.io spec fields (name and description are required per spec) ---
  name: z.string(),
  description: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),

  // --- Industry extensions ---
  // @deprecated Use allowed-tools instead
  tools: z.union([z.string(), z.array(z.string())]).optional(),
  enabled: z.boolean().default(true),
  'user-invocable': z.boolean().default(true),
  'disable-model-invocation': z.boolean().default(false),
});

// =============================================================================
// Settings Resolution Chain Schemas
// =============================================================================

export const SettingsSourceTypeEnum = z.enum([
  /** Industry's hardcoded defaults (lowest priority) */
  'builtin-default',
  /** Remote dynamic config (e.g. Statsig dynamic configs) */
  'dynamic-config',
  /** Organization-level settings pushed from the server */
  'org',
  /** User-level settings from ~/.industry/settings.json */
  'user',
  /** Project-level settings from <git-root>/.industry/settings.json */
  'project',
  /** Folder-level settings from ancestor .industry/settings.json files */
  'folder',
  /** Model availability determined by a feature flag gate */
  'feature-flag',
  /** Value read from browser localStorage (CLOUD path only) */
  'localstorage',
  /** Value provided via React Router navigation state (e.g. template launch, session continuation) */
  'nav-state',
  /** Model/effort override enforced for orchestrator (mission) sessions */
  'orchestrator-override',
  /** Last-resort fallback when no model was selected after all other sources */
  'auto-select',
  /** Settings restored from the daemon's CLI process for this session — re-resolved from the settings hierarchy if the daemon restarts */
  'session-state',
]);

export const SettingsSourceSchema = z.object({
  type: SettingsSourceTypeEnum,
  filePath: z.string().optional(),
  flagName: z.string().optional(),
  key: z.string().optional(),
  orgId: z.string().optional(),
});

export const SettingsActionEnum = z.enum([
  'set',
  'override',
  'skip',
  'fallback',
]);

const SettingsResolutionLocationSchema = z.object({
  package: z.string(),
  file: z.string(),
  function: z.string().optional(),
});

export const SettingsResolutionEventSchema = z.object({
  timestamp: z.string(),
  keys: z.array(z.string()),
  action: SettingsActionEnum,
  source: SettingsSourceSchema,
  value: z.record(z.unknown()).optional(),
  reason: z.string().optional(),
  location: SettingsResolutionLocationSchema.optional(),
});
