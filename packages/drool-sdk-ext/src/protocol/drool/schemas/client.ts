import z from 'zod';

import {
  AskUserRequestParamsSchema,
  RequestPermissionRequestParamsSchema,
  SandboxStatusSchema,
} from './cli';
import { LoopStateSchema } from './loop';
import {
  McpServerNameSchema,
  McpServerTypeSchema,
  McpHttpServerConfigFieldsSchema,
  McpStdioServerConfigFieldsSchema,
  McpServerStatusInfoSchema,
  McpStatusSummarySchema,
  McpRegistryServerSchema,
  McpToolInfoSchema,
} from './mcp';
import {
  ProgressLogEntrySchema,
  MissionFeatureSchema,
} from './mission-decomposition';
import { McpOAuthConfigSchema } from '../../settings/schema';
import { HostIdSchema } from '../../host';
import {
  LLMModelTier,
  ModelKind,
  ModelProvider,
  ReasoningEffort,
} from '../../llm';
import { TokenUsageSchema } from '../../session/settings/schema';
import { SessionOrigin } from '../../session/sources/enums';
import { SessionSourceSchema } from '../../session/sources/schema';
import { SessionTagSchema } from '../../session/tags/schema';
import { MessageRole, MessageVisibility } from '../../sessionV2/messages/enums';
import {
  Base64ImageSourceSchema,
  DocumentSourceSchema,
  IndustryDroolMessageSchema,
} from '../../sessionV2/messages/schemas';
import {
  DroolLocation,
  SettingsLevel,
  SkillLocation,
} from '../../settings/enums';
import { MissionModelSettingsSchema } from '../../settings/schema';
import {
  AutonomyLevel,
  AutonomyMode,
  DroolInteractionModeSchema,
  JsonRpcBaseResponseFailureSchema,
  JsonRpcBaseRequestSchema,
  JsonRpcBaseResponseSuccessSchema,
} from '../../shared';
import {
  ContextCategoryColorKey,
  ContextStatsAccuracy,
  DecompSessionType,
  DroolServerMethod,
  MissionState,
  QueuePlacement,
  ResolveQueuedUserMessageAction,
} from '../enums';

/**
 * Schema for available model configuration returned in session init/load responses.
 * This represents both built-in models (feature-flag filtered) and custom BYOK models.
 */
export const AvailableModelConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  shortDisplayName: z.string(),
  modelProvider: z.nativeEnum(ModelProvider),
  supportedReasoningEfforts: z.array(z.nativeEnum(ReasoningEffort)),
  defaultReasoningEffort: z.nativeEnum(ReasoningEffort),
  isCustom: z.boolean().default(false),
  noImageSupport: z.boolean().optional(),
  tier: z.nativeEnum(LLMModelTier).optional(),
  tokenMultiplier: z.number().optional(),
  promoLabel: z.string().optional(),
  kind: z.nativeEnum(ModelKind).optional(),
  variantBadge: z.string().optional(),
});

export const ContextStatsSchema = z.object({
  used: z.number(),
  remaining: z.number(),
  limit: z.number(),
  accuracy: z.nativeEnum(ContextStatsAccuracy),
  updatedAt: z.string(),
});

export const StdioMcpSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional().default({}),
});

export const HttpHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const HttpMcpSchema = z.object({
  type: z.literal('http'),
  name: z.string(),
  url: z.string().url(),
  headers: HttpHeaderSchema.array().default([]),
  oauth: McpOAuthConfigSchema.optional(),
});

export const SseMcpSchema = z.object({
  type: z.literal('sse'),
  name: z.string(),
  url: z.string().url(),
  headers: HttpHeaderSchema.array().default([]),
  oauth: McpOAuthConfigSchema.optional(),
});

export const McpServerConfigSchema = z.union([
  StdioMcpSchema,
  HttpMcpSchema,
  SseMcpSchema,
]);

const McpServersSchema = McpServerConfigSchema.array();

const SessionSchema = z.object({
  messages: IndustryDroolMessageSchema.array(),
  title: z.string().optional(),
});

// Session type for mission decomposition (orchestrator manages workers)
const DecompSessionTypeSchema = z.nativeEnum(DecompSessionType);

const ToolOverrideParamsSchema = z.object({
  enabledToolIds: z.array(z.string()).optional(),
  disabledToolIds: z.array(z.string()).optional(),
});

export const OutputFormatSchema = z.object({
  type: z.literal('json_schema'),
  schema: z.record(z.unknown()),
});

export const InitializeSessionRequestParamsSchema = z
  .object({
    machineId: z.string(),
    cwd: z.string(),
    // Optional if we want to attach a session to a specific workspace
    workspaceId: z.string().optional(),
    // Optional if we want to create a session with a specific ID
    sessionId: z.string().optional(),
    mcpServers: McpServersSchema.optional(),
    // Session settings (optional - uses defaults from settings.json if not provided)
    autonomyMode: z
      .nativeEnum(AutonomyMode)
      .optional()
      .describe('Deprecated: use interactionMode + autonomyLevel instead.'),
    interactionMode: DroolInteractionModeSchema.optional().catch(undefined),
    autonomyLevel: z.nativeEnum(AutonomyLevel).optional().catch(undefined),
    modelId: z.string().optional(),
    reasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
    systemPromptOverride: z.string().optional(),
    specModeModelId: z.string().optional(),
    specModeReasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
    missionSettings: MissionModelSettingsSchema.optional(),
    compactionThresholdCheckEnabled: z.boolean().optional(),
    /**
     * @deprecated use session tags instead: mission decomposition session
     * type (orchestrator or worker). undefined = standard session (not part of decomposition)
     */
    decompSessionType: DecompSessionTypeSchema.optional(),
    /**
     * @deprecated use session tags instead: mission id for worker sessions
     * (links worker back to its orchestrator's mission)
     */
    decompMissionId: z.string().optional(),
    // Skip permission checks (used by worker sessions running autonomously)
    skipPermissionsUnsafe: z.boolean().optional(),
    // Session metadata for delegations (Linear, Slack, etc.)
    sessionLocation: z.string().optional(),
    sessionSource: SessionSourceSchema.optional(),
    sessionOriginHint: z.nativeEnum(SessionOrigin).optional(),
    tags: z.array(SessionTagSchema).optional(),
    privacyLevel: z.enum(['private', 'organization']).optional(),
    title: z.string().optional(),
    // OAuth callback URI for MCP auth relay (set by frontend based on web vs desktop client)
    mcpOAuthCallbackUri: z.string().optional(),
    /**
     * When true, the first agent turn waits for MCP servers to finish loading
     * before running, so MCP tools are available on turn one. Does not block
     * session init. Enabled for delegation autorun.
     */
    blockOnMcpLoad: z.boolean().optional(),
    /**
     * When true, the daemon should create or reuse a git worktree rooted
     * at `cwd` and run the session there. The original `cwd` is used to
     * locate the git repo; the actual session cwd becomes the worktree
     * path. No-op when `cwd` is not inside a git repository.
     */
    worktree: z.boolean().optional(),
    /**
     * Optional override for where the worktree directory is created.
     * Falls back to the user's `worktreeDirectory` setting (or the
     * sibling-of-repo default) when omitted.
     */
    worktreeDir: z.string().optional(),
  })
  .merge(ToolOverrideParamsSchema);

export const LoadSessionRequestParamsSchema = z.object({
  sessionId: z.string(),
  mcpServers: McpServersSchema.optional(),
  loadAllMessages: z.boolean().optional(),
  // OAuth callback URI for MCP auth relay (set by frontend based on web vs desktop client)
  mcpOAuthCallbackUri: z.string().optional(),
  // Client surface this load originates from (TUI, desktop, web, ...). Lets the
  // worker tailor surface-specific guidance (e.g. how to enter a mission).
  sessionOriginHint: z.nativeEnum(SessionOrigin).optional(),
});

export const AddUserMessageRequestParamsSchema = z.object({
  messageId: z.string().optional(),
  text: z.string(),
  images: Base64ImageSourceSchema.array().optional(),
  files: DocumentSourceSchema.array().optional(),
  outputFormat: OutputFormatSchema.optional(),
  skipAgentLoop: z.boolean().optional(),
  queuePlacement: z.nativeEnum(QueuePlacement).optional(),
  role: z.nativeEnum(MessageRole).optional(),
  visibility: z.nativeEnum(MessageVisibility).optional(),
  userMessageSource: z.nativeEnum(SessionOrigin).optional(),
});

const QueuePlacementSchema = z.nativeEnum(QueuePlacement);

export const ResolveQueuedUserMessageRequestParamsSchema = z.discriminatedUnion(
  'action',
  [
    z.object({
      requestId: z.string(),
      action: z.literal(ResolveQueuedUserMessageAction.UpdateQueue),
      queuePlacement: QueuePlacementSchema,
    }),
    z.object({
      requestId: z.string(),
      action: z.literal(ResolveQueuedUserMessageAction.Delete),
    }),
  ]
);

export const InterruptSessionRequestParamsSchema = z.object({});

const CloseSessionRequestParamsSchema = z.object({
  reason: z.enum(['clear', 'logout', 'prompt_input_exit', 'other']).optional(),
});

export const CloseSessionResultSchema = z.object({});

export const KillWorkerSessionRequestParamsSchema = z.object({
  workerSessionId: z.string(),
});

export const KillWorkerSessionResultSchema = z.object({});

export const UpdateSessionSettingsRequestParamsSchema = z
  .object({
    modelId: z.string().optional(),
    reasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
    autonomyMode: z
      .nativeEnum(AutonomyMode)
      .optional()
      .describe('Deprecated: use interactionMode + autonomyLevel instead.'),
    interactionMode: DroolInteractionModeSchema.optional().catch(undefined),
    autonomyLevel: z.nativeEnum(AutonomyLevel).optional().catch(undefined),
    specModeModelId: z.string().nullable().optional(),
    specModeReasoningEffort: z
      .nativeEnum(ReasoningEffort)
      .nullable()
      .optional(),
    missionSettings: MissionModelSettingsSchema.optional(),
    tags: z.array(SessionTagSchema).optional(),
    compactionTokenLimit: z.number().optional(),
    compactionThresholdCheckEnabled: z.boolean().optional(),
  })
  .merge(ToolOverrideParamsSchema);

export const SessionSettingsSchema = z
  .object({
    modelId: z.string(),
    reasoningEffort: z.nativeEnum(ReasoningEffort),
    autonomyMode: z
      .nativeEnum(AutonomyMode)
      .optional()
      .describe('Deprecated: use interactionMode + autonomyLevel instead.'),
    interactionMode: DroolInteractionModeSchema.optional().catch(undefined),
    autonomyLevel: z.nativeEnum(AutonomyLevel).optional().catch(undefined),
    specModeModelId: z.string().optional(),
    specModeReasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
    missionSettings: MissionModelSettingsSchema.optional(),
    tags: z.array(SessionTagSchema).optional(),
    sandbox: SandboxStatusSchema.optional(),
    compactionThresholdCheckEnabled: z.boolean().optional(),
  })
  .merge(ToolOverrideParamsSchema);

export const GitRepoInfoSchema = z.object({
  owner: z.string().optional(),
  repoName: z.string(),
});

/**
 * Worktree metadata returned to the client when a session is created in
 * an isolated git worktree. Surfaces the branch + path so the UI can
 * display badges and the user can locate the worktree on disk.
 */
const SessionWorktreeInfoSchema = z.object({
  branch: z.string(),
  path: z.string(),
  repoRoot: z.string().optional(),
  isNewlyCreated: z.boolean(),
});

export const InitializeSessionResultSchema = z.object({
  sessionId: z.string(),
  hostId: HostIdSchema.optional(),
  session: SessionSchema,
  mcpServers: McpServersSchema.optional(),
  settings: SessionSettingsSchema,
  gitRepo: GitRepoInfoSchema.optional(),
  availableModels: z.array(AvailableModelConfigSchema).optional(),
  worktree: SessionWorktreeInfoSchema.optional(),
});

export const WorkerStateInfoSchema = z.object({
  startedAt: z.string(),
  completedAt: z.string().optional(),
  exitCode: z.number().optional(),
});

// Mission snapshot schema (optional, only for orchestrator sessions)
export const MissionStateSchema = z.object({
  state: z.nativeEnum(MissionState),
  updatedAt: z.string().optional(),
  title: z.string().optional(),
  workingDirectory: z.string().optional(),
  features: z.array(MissionFeatureSchema),
  progressLog: z.array(ProgressLogEntrySchema),
  workerSessionIds: z.array(z.string()),
  workerStates: z.record(WorkerStateInfoSchema).optional(),
  tokenUsage: TokenUsageSchema.optional(),
  tokenUsageBySessionId: z.record(TokenUsageSchema).optional(),
});

export const LoadSessionResultSchema = z.object({
  session: SessionSchema,
  /** @deprecated Loop state is superseded by daemon cron records/events. */
  loopState: LoopStateSchema.nullable().optional(),
  hostId: HostIdSchema.optional(),
  mcpServers: McpServersSchema.optional(),
  pendingPermissions: z
    .array(
      RequestPermissionRequestParamsSchema.extend({
        requestId: z.string(),
      })
    )
    .optional(),
  pendingAskUserRequests: z
    .array(
      AskUserRequestParamsSchema.extend({
        requestId: z.string(),
      })
    )
    .optional(),
  settings: SessionSettingsSchema,
  isAgentLoopInProgress: z.boolean().optional(),
  queuedMessages: z
    .array(
      AddUserMessageRequestParamsSchema.extend({
        requestId: z.string(),
      })
    )
    .optional(),
  gitRepo: GitRepoInfoSchema.optional(),
  cwd: z.string().optional(),
  callingSessionId: z.string().optional(),
  callingToolUseId: z.string().optional(),
  availableModels: z.array(AvailableModelConfigSchema).optional(),
  // Token usage for the session (input, output, cache tokens)
  tokenUsage: TokenUsageSchema.optional(),
  // Mission state (only for orchestrator sessions with active missions)
  mission: MissionStateSchema.optional(),
  // Session type for mission decomposition (orchestrator or worker)
  decompSessionType: DecompSessionTypeSchema.optional(),
});

export const AddUserMessageResultSchema = z.object({});

export const ResolveQueuedUserMessageResultSchema = z.object({});

export const InterruptSessionResultSchema = z.object({});

export const UpdateSessionSettingsResultSchema = z.object({});

export const GetUserInfoResultSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
});

export const ValidateWorkingDirectoryResultSchema = z.object({
  isValid: z.boolean(),
  error: z.string().optional(),
  /**
   * The fully-resolved absolute path (tilde expanded, `..`/`.` normalized,
   * symlinks canonicalized). Set by daemons that support it when
   * `isValid === true`. Optional for backwards compatibility with daemons
   * that predate the field — callers should fall back to the original
   * user input when absent.
   */
  resolvedPath: z.string().optional(),
});

export const InitializeSessionRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.INITIALIZE_SESSION),
  params: InitializeSessionRequestParamsSchema,
});

export const LoadSessionRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.LOAD_SESSION),
  params: LoadSessionRequestParamsSchema,
});

export const AddUserMessageRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.ADD_USER_MESSAGE),
  params: AddUserMessageRequestParamsSchema,
});

export const ResolveQueuedUserMessageRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DroolServerMethod.RESOLVE_QUEUED_USER_MESSAGE),
    params: ResolveQueuedUserMessageRequestParamsSchema,
  });

export const InterruptSessionRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.INTERRUPT_SESSION),
  params: InterruptSessionRequestParamsSchema,
});

export const CloseSessionRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.CLOSE_SESSION),
  params: CloseSessionRequestParamsSchema,
});

export const KillWorkerSessionRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.KILL_WORKER_SESSION),
  params: KillWorkerSessionRequestParamsSchema,
});

export const UpdateSessionSettingsRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DroolServerMethod.UPDATE_SESSION_SETTINGS),
    params: UpdateSessionSettingsRequestParamsSchema,
  });

// MCP server management requests
const McpServerNameParamsSchema = z.object({
  serverName: McpServerNameSchema,
});

// MCP config mutations are applied via user-level overrides only.
const McpSettingsLevelSchema = z.literal(SettingsLevel.User);

const McpHttpServerAddFieldsSchema = McpHttpServerConfigFieldsSchema.extend({
  headers: z.record(z.string()).optional(),
  oauth: McpOAuthConfigSchema.optional(),
});

const McpStdioServerAddFieldsSchema = McpStdioServerConfigFieldsSchema.extend({
  env: z.record(z.string()).optional(),
});

export const ToggleMcpServerRequestParamsSchema =
  McpServerNameParamsSchema.extend({
    enabled: z.boolean(),
    settingsLevel: McpSettingsLevelSchema,
  });

const ToggleMcpServerResultSchema = z.object({
  success: z.boolean(),
});

export const ToggleMcpServerRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.TOGGLE_MCP_SERVER),
  params: ToggleMcpServerRequestParamsSchema,
});

export const AuthenticateMcpServerRequestParamsSchema =
  McpServerNameParamsSchema.extend({});

const AuthenticateMcpServerResultSchema = z.object({
  success: z.boolean(),
});

export const AuthenticateMcpServerRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DroolServerMethod.AUTHENTICATE_MCP_SERVER),
    params: AuthenticateMcpServerRequestParamsSchema,
  });

export const CancelMcpAuthRequestParamsSchema =
  McpServerNameParamsSchema.extend({});

const CancelMcpAuthResultSchema = z.object({
  success: z.boolean(),
});

export const CancelMcpAuthRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.CANCEL_MCP_AUTH),
  params: CancelMcpAuthRequestParamsSchema,
});

export const ClearMcpAuthRequestParamsSchema = McpServerNameParamsSchema.extend(
  {}
);

const ClearMcpAuthResultSchema = z.object({
  success: z.boolean(),
});

export const ClearMcpAuthRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.CLEAR_MCP_AUTH),
  params: ClearMcpAuthRequestParamsSchema,
});

// Submit MCP auth code (for remote sessions)
export const SubmitMcpAuthCodeRequestParamsSchema = z.object({
  serverName: McpServerNameSchema,
  code: z.string(),
  state: z.string(),
});

const SubmitMcpAuthCodeResultSchema = z.object({
  success: z.boolean(),
});

export const SubmitMcpAuthCodeRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.SUBMIT_MCP_AUTH_CODE),
  params: SubmitMcpAuthCodeRequestParamsSchema,
});

export const SubmitMcpAuthCodeResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: SubmitMcpAuthCodeResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const SubmitMcpAuthErrorRequestParamsSchema = z.object({
  serverName: McpServerNameSchema,
  error: z.string(),
  errorDescription: z.string().optional(),
  state: z.string(),
});

export const SubmitMcpAuthErrorRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.SUBMIT_MCP_AUTH_ERROR),
  params: SubmitMcpAuthErrorRequestParamsSchema,
});

export const SubmitMcpAuthErrorResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: SubmitMcpAuthCodeResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

// Add MCP server request
export const AddMcpServerRequestParamsSchema = z
  .object({
    name: McpServerNameSchema,
    type: McpServerTypeSchema,
  })
  .merge(McpHttpServerAddFieldsSchema)
  .merge(McpStdioServerAddFieldsSchema);

const AddMcpServerResultSchema = z.object({
  success: z.boolean(),
});

export const AddMcpServerRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.ADD_MCP_SERVER),
  params: AddMcpServerRequestParamsSchema,
});

// Remove MCP server request
export const RemoveMcpServerRequestParamsSchema =
  McpServerNameParamsSchema.extend({
    settingsLevel: McpSettingsLevelSchema,
  });

const RemoveMcpServerResultSchema = z.object({
  success: z.boolean(),
});

export const RemoveMcpServerRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.REMOVE_MCP_SERVER),
  params: RemoveMcpServerRequestParamsSchema,
});

// List MCP registry request (returns available servers from hardcoded registry)
export const ListMcpRegistryRequestParamsSchema = z.object({});

export const ListMcpRegistryResultSchema = z.object({
  servers: z.array(McpRegistryServerSchema),
});

export const ListMcpRegistryRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.LIST_MCP_REGISTRY),
  params: ListMcpRegistryRequestParamsSchema,
});

// List MCP tools request (returns all tools with enabled/disabled state)
export const ListMcpToolsRequestParamsSchema = z.object({});

export const ListMcpToolsResultSchema = z.object({
  tools: z.array(McpToolInfoSchema),
});

export const ListMcpToolsRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.LIST_MCP_TOOLS),
  params: ListMcpToolsRequestParamsSchema,
});

const ToolCatalogCategorySchema = z.enum(['read', 'edit', 'execute', 'other']);

export const ExecToolInfoSchema = z.object({
  id: z.string(),
  llmId: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: ToolCatalogCategorySchema,
  defaultAllowed: z.boolean(),
  currentlyAllowed: z.boolean(),
});

export const ListToolsRequestParamsSchema =
  UpdateSessionSettingsRequestParamsSchema.pick({
    modelId: true,
    autonomyMode: true,
    interactionMode: true,
    autonomyLevel: true,
    specModeModelId: true,
    enabledToolIds: true,
    disabledToolIds: true,
  }).extend({
    skipPermissionsUnsafe: z.boolean().optional(),
    depth: z.number().int().min(0).optional(),
  });

export const ListToolsResultSchema = z.object({
  tools: z.array(ExecToolInfoSchema),
});

export const ListToolsRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.LIST_TOOLS),
  params: ListToolsRequestParamsSchema,
});

// List MCP servers request (returns current server status, same shape as MCP_STATUS_CHANGED notification)
export const ListMcpServersRequestParamsSchema = z.object({});

export const ListMcpServersResultSchema = z.object({
  servers: z.array(McpServerStatusInfoSchema),
  summary: McpStatusSummarySchema,
});

export const ListMcpServersRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.LIST_MCP_SERVERS),
  params: ListMcpServersRequestParamsSchema,
});

// Toggle MCP tool request (enable/disable a specific tool)
export const ToggleMcpToolRequestParamsSchema =
  McpServerNameParamsSchema.extend({
    toolName: z.string(),
    enabled: z.boolean(),
  });

const ToggleMcpToolResultSchema = z.object({
  success: z.boolean(),
});

export const ToggleMcpToolRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.TOGGLE_MCP_TOOL),
  params: ToggleMcpToolRequestParamsSchema,
});

// List skills request (returns all available skills)
const ListSkillsRequestParamsSchema = z.object({});

// Resource file in a skill folder (anything except SKILL.md)
export const SkillResourceSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['reference', 'asset']), // reference = .md files, asset = other files
});

export const SkillInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  location: z.nativeEnum(SkillLocation),
  filePath: z.string(),
  enabled: z.boolean().optional(),
  userInvocable: z.boolean().optional(),
  version: z.string().optional(),
  // Full SKILL.md content (markdown)
  content: z.string().optional(),
  // Other files in the skill folder
  resources: z.array(SkillResourceSchema).optional(),
});

const ListSkillsResultSchema = z.object({
  skills: z.array(SkillInfoSchema),
});

export const ListSkillsRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.LIST_SKILLS),
  params: ListSkillsRequestParamsSchema,
});

// List commands request (returns all custom slash commands)
const ListCommandsRequestParamsSchema = z.object({});

export const CustomCommandInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  // Whether the command is backed by an executable script (resolution runs it)
  isExecutable: z.boolean().optional(),
});

const ListCommandsResultSchema = z.object({
  commands: z.array(CustomCommandInfoSchema),
});

export const ListCommandsRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.LIST_COMMANDS),
  params: ListCommandsRequestParamsSchema,
});

const GetContextStatsRequestParamsSchema = z.object({});

export { ContextStatsSchema as GetContextStatsResultSchema };

export const GetContextStatsRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.GET_CONTEXT_STATS),
  params: GetContextStatsRequestParamsSchema,
});

export const ContextBreakdownCategorySchema = z.object({
  name: z.string(),
  tokens: z.number(),
  colorKey: z.nativeEnum(ContextCategoryColorKey),
});

const ContextBreakdownSkillEntrySchema = z.object({
  name: z.string(),
  location: z.nativeEnum(SkillLocation),
  tokens: z.number(),
});

const ContextBreakdownMcpServerEntrySchema = z.object({
  name: z.string(),
  toolCount: z.number(),
  tokens: z.number(),
});

const ContextBreakdownDroolEntrySchema = z.object({
  name: z.string(),
  location: z.nativeEnum(DroolLocation),
  tokens: z.number(),
});

const GetContextBreakdownRequestParamsSchema = z.object({});

export const GetContextBreakdownResultSchema = z.object({
  modelId: z.string(),
  modelDisplayName: z.string(),
  contextBudget: z.number(),
  lastCallCompactionTokens: z.number().optional(),
  usedTokens: z.number(),
  freeTokens: z.number(),
  categories: z.array(ContextBreakdownCategorySchema),
  skills: z.array(ContextBreakdownSkillEntrySchema),
  mcpServers: z.array(ContextBreakdownMcpServerEntrySchema),
  drools: z.array(ContextBreakdownDroolEntrySchema),
});

export const GetContextBreakdownRequestSchema = JsonRpcBaseRequestSchema.extend(
  {
    method: z.literal(DroolServerMethod.GET_CONTEXT_BREAKDOWN),
    params: GetContextBreakdownRequestParamsSchema,
  }
);

// Submit bug report request (creates and uploads bug report with session data)
const SubmitBugReportRequestParamsSchema = z.object({
  userComment: z.string(),
  clientLogs: z.string().optional(),
});

export const SubmitBugReportResultSchema = z.object({
  bugReportId: z.string(),
});

export const SubmitBugReportRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.SUBMIT_BUG_REPORT),
  params: SubmitBugReportRequestParamsSchema,
});

// Rewind schemas

const GetRewindInfoRequestParamsSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});

export const RewindFileSnapshotSchema = z.object({
  filePath: z.string(),
  contentHash: z.string(),
  size: z.number(),
});

export const RewindFileCreationSchema = z.object({
  filePath: z.string(),
});

export const RewindEvictedFileSchema = z.object({
  filePath: z.string(),
  reason: z.string(),
});

export const GetRewindInfoResultSchema = z.object({
  availableFiles: z.array(RewindFileSnapshotSchema),
  createdFiles: z.array(RewindFileCreationSchema),
  evictedFiles: z.array(RewindEvictedFileSchema),
});

export const GetRewindInfoRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.GET_REWIND_INFO),
  params: GetRewindInfoRequestParamsSchema,
});

const ExecuteRewindRequestParamsSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  filesToRestore: z.array(RewindFileSnapshotSchema),
  filesToDelete: z.array(RewindFileCreationSchema),
  forkTitle: z.string(),
});

export const ExecuteRewindResultSchema = z.object({
  newSessionId: z.string(),
  restoredCount: z.number(),
  deletedCount: z.number(),
  failedRestoreCount: z.number(),
  failedDeleteCount: z.number(),
});

export const ExecuteRewindRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.EXECUTE_REWIND),
  params: ExecuteRewindRequestParamsSchema,
});

// Compact session schemas

const CompactSessionRequestParamsSchema = z.object({
  customInstructions: z.string().optional(),
});

export const CompactSessionResultSchema = z.object({
  newSessionId: z.string(),
  removedCount: z.number(),
});

export const CompactSessionRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.COMPACT_SESSION),
  params: CompactSessionRequestParamsSchema,
});

export const CompactSessionResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: CompactSessionResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ForkSessionResultSchema = z.object({
  newSessionId: z.string(),
});

export const ForkSessionRequestParamsSchema = z.object({
  title: z.string().optional(),
  tags: z
    .array(
      z.object({ name: z.string(), metadata: z.record(z.string()).optional() })
    )
    .optional(),
});

export const ForkSessionRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.FORK_SESSION),
  params: ForkSessionRequestParamsSchema,
});

export const ForkSessionResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ForkSessionResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

// Rename Session
export const RenameSessionRequestParamsSchema = z.object({
  title: z.string(),
});

export const RenameSessionResultSchema = z.object({
  success: z.boolean(),
});

export const RenameSessionRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.RENAME_SESSION),
  params: RenameSessionRequestParamsSchema,
});

export const RenameSessionResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: RenameSessionResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

// Cache warmup
export const WarmupCacheRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DroolServerMethod.WARMUP_CACHE),
  params: z.object({}),
});

export const WarmupCacheResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: z.object({}),
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ClientRequestSchema = z.discriminatedUnion('method', [
  InitializeSessionRequestSchema,
  LoadSessionRequestSchema,
  InterruptSessionRequestSchema,
  CloseSessionRequestSchema,
  KillWorkerSessionRequestSchema,
  AddUserMessageRequestSchema,
  ResolveQueuedUserMessageRequestSchema,
  UpdateSessionSettingsRequestSchema,
  ToggleMcpServerRequestSchema,
  AuthenticateMcpServerRequestSchema,
  CancelMcpAuthRequestSchema,
  ClearMcpAuthRequestSchema,
  AddMcpServerRequestSchema,
  RemoveMcpServerRequestSchema,
  ListMcpRegistryRequestSchema,
  ListMcpToolsRequestSchema,
  ListToolsRequestSchema,
  ListMcpServersRequestSchema,
  ToggleMcpToolRequestSchema,
  SubmitMcpAuthCodeRequestSchema,
  SubmitMcpAuthErrorRequestSchema,
  ListSkillsRequestSchema,
  ListCommandsRequestSchema,
  GetContextStatsRequestSchema,
  GetContextBreakdownRequestSchema,
  SubmitBugReportRequestSchema,
  GetRewindInfoRequestSchema,
  ExecuteRewindRequestSchema,
  CompactSessionRequestSchema,
  ForkSessionRequestSchema,
  RenameSessionRequestSchema,
  WarmupCacheRequestSchema,
]);

export const InitializeSessionResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: InitializeSessionResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const LoadSessionResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: LoadSessionResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const AddUserMessageResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: AddUserMessageResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ResolveQueuedUserMessageResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ResolveQueuedUserMessageResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const InterruptSessionResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: InterruptSessionResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const CloseSessionResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: CloseSessionResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const KillWorkerSessionResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: KillWorkerSessionResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const UpdateSessionSettingsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: UpdateSessionSettingsResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ToggleMcpServerResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ToggleMcpServerResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const AuthenticateMcpServerResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: AuthenticateMcpServerResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const CancelMcpAuthResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: CancelMcpAuthResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ClearMcpAuthResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ClearMcpAuthResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const AddMcpServerResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: AddMcpServerResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const RemoveMcpServerResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: RemoveMcpServerResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ListMcpRegistryResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ListMcpRegistryResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ListMcpToolsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ListMcpToolsResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ListToolsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ListToolsResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ListMcpServersResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ListMcpServersResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ToggleMcpToolResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ToggleMcpToolResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ListSkillsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ListSkillsResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ListCommandsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ListCommandsResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const GetContextStatsResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ContextStatsSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const GetContextBreakdownResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: GetContextBreakdownResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const SubmitBugReportResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: SubmitBugReportResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const GetRewindInfoResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: GetRewindInfoResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

export const ExecuteRewindResponseSchema = z.union([
  JsonRpcBaseResponseSuccessSchema.extend({
    result: ExecuteRewindResultSchema,
  }),
  JsonRpcBaseResponseFailureSchema,
]);

// Surface result/params building-blocks that the drool SDK re-exports as part
// of its public schema surface. These names do not match the protocol-manifest
// concrete-schema pattern, so exporting them does not affect the manifest.
export {
  ToggleMcpServerResultSchema,
  AuthenticateMcpServerResultSchema,
  CancelMcpAuthResultSchema,
  ClearMcpAuthResultSchema,
  SubmitMcpAuthCodeResultSchema,
  AddMcpServerResultSchema,
  RemoveMcpServerResultSchema,
  ToggleMcpToolResultSchema,
  ListSkillsResultSchema,
  CloseSessionRequestParamsSchema,
  GetContextStatsRequestParamsSchema,
  ListSkillsRequestParamsSchema,
  SubmitBugReportRequestParamsSchema,
  GetRewindInfoRequestParamsSchema,
  ExecuteRewindRequestParamsSchema,
  CompactSessionRequestParamsSchema,
};
