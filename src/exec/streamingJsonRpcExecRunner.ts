/**
 * JsonRpcStreamingExecRunner
 *
 * Uses shared infrastructure:
 * - SessionController for settings management
 * - JsonRpcProtocolAdapter for notification emission
 * - AgentEventBus for event forwarding
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

import {
  SESSION_TAG_BTW_FORK,
  SESSION_TAG_SUBAGENT,
} from '@industry/common/session';
import { DroolMode, DroolSubMode } from '@industry/common/shared';
import {
  AgentTurnCompletionReason,
  ClientRequestSchema,
  DecompSessionType,
  DroolServerMethod,
  DroolWorkingState,
  INDUSTRY_PROTOCOL_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
  QueuePlacement,
  ResolveQueuedUserMessageAction,
  SessionNotificationType,
  ToolConfirmationOutcome,
  type ClientRequest,
  type InitializeSessionRequest,
  type LoadSessionRequest,
  type LoadSessionResult,
  type AddUserMessageRequest,
  type ResolveQueuedUserMessageRequest,
  type CloseSessionRequest,
  type InterruptSessionRequest,
  type KillWorkerSessionRequest,
  type UpdateSessionSettingsRequest,
  type ToggleMcpServerRequest,
  type AuthenticateMcpServerRequest,
  type ClearMcpAuthRequest,
  type AddMcpServerRequest,
  type RemoveMcpServerRequest,
  type ListMcpRegistryRequest,
  type ListMcpToolsRequest,
  type ListToolsRequest,
  type ListMcpServersRequest,
  type ToggleMcpToolRequest,
  type CancelMcpAuthRequest,
  type SubmitMcpAuthCodeRequest,
  type SubmitMcpAuthErrorRequest,
  type ListSkillsRequest,
  type ListCommandsRequest,
  type GetContextStatsRequest,
  type GetContextBreakdownRequest,
  type SubmitBugReportRequest,
  type GetRewindInfoRequest,
  type ExecuteRewindRequest,
  type CompactSessionRequest,
  type ForkSessionRequest,
  type RenameSessionRequest,
  type WarmupCacheRequest,
  type SandboxStatus,
} from '@industry/drool-sdk-ext/protocol/drool';
import { McpOAuthTokenEndpointAuthMethod } from '@industry/drool-sdk-ext/protocol/mcp-oauth';
import {
  Base64ImageSource,
  type IndustryDroolMessage,
  MessageContentBlockType,
  MessageRole,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyMode,
  JsonRpcBaseResponseFailure,
  JsonRpcError,
  JsonRpcErrorCode,
  JsonRpcMessageSchema,
  AutonomyLevel,
  DroolInteractionMode,
  JsonRpcBaseResponseSchema,
  type TraceContextMeta,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import {
  AuthenticationError,
  MetaError,
  ToolAbortError,
} from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { OtelTracing, SpanName, SpanAttribute } from '@industry/logging/tracing';
import { resolveInteractionSettingsWithLegacyFallback } from '@industry/utils';
import { hasDecoupledInteractionSettings } from '@industry/utils/autonomy';
import { tryExtractSessionId } from '@industry/utils/protocol';
import { getSubagentCallingMetadata } from '@industry/utils/session';

import { JsonRpcProtocolAdapter } from '@/adapters/JsonRpcProtocolAdapter';
import { PermissionRequestHandler } from '@/agent/PermissionRequestHandler';
import type { PermissionResponse, ToolConfirmationBatch } from '@/agent/types';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import { resolveDeferredPromptFromRawText } from '@/commands/deferredPromptResolution';
import { OutputFormat } from '@/commands/enums';
import { getRegistryServers } from '@/commands/mcp/registry/servers';
import { resolveToolSelection } from '@/commands/resolveToolSelection';
import {
  SessionController,
  getSessionController,
  resetSessionController,
} from '@/controllers/SessionController';
import {
  AgentEvent,
  agentEventBus,
  SessionTitleUpdateType,
} from '@/events/AgentEventBus';
import { convertBase64ImagesToAttachments } from '@/exec/imageAttachments';
import {
  buildMcpStatusNotification,
  setupMcpStatusListeners,
} from '@/exec/mcpStatusHandler';
import {
  emitAgentTurnCompletedNotification,
  resumeAgentWithSession,
  runAgentWithSession,
} from '@/exec/sharedAgentRunner';
import type { McpStatusListenerHandle } from '@/exec/types';
import { EXEC_SYSTEM_PROMPT, SYSTEM_PROMPT } from '@/hooks/constants';
import { HookEventName, IdeConnectionStatus } from '@/hooks/enums';
import type { IdeContextState } from '@/hooks/types';
import { getI18n } from '@/i18n';
import { getAvailableModelsForResponse } from '@/models/availability';
import { getContextStats } from '@/services/contextStats';
import { getConversationStateManager } from '@/services/ConversationStateManager';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { isNoApproverDelegatedSession } from '@/services/delegatedSession/detection';
import { maybeAutoRejectDelegatedPermission } from '@/services/delegatedSession/permissionGate';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getHookService } from '@/services/HookService';
import { IdeContextManager } from '@/services/IdeContextManager';
import { McpServiceEventType } from '@/services/mcp/enums';
import { getMcpService } from '@/services/mcp/McpService';
import type {
  McpAuthCompletedInfo,
  McpAuthRequiredInfo,
} from '@/services/mcp/types';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import { pauseMissionRunner } from '@/services/mission/missionRunnerOperations';
import {
  getOrchestratorSystemPrompt,
  getWorkerSystemPrompt,
} from '@/services/mission/prompts';
import {
  getDecompSessionTypeFromTags,
  isMissionWorkerSession,
  upsertMissionSessionTag,
} from '@/services/mission/sessionTags';
import { processTracker } from '@/services/ProcessTracker';
import { getSandboxService } from '@/services/SandboxService';
import {
  getPermissionModeString,
  getSessionService,
} from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { getFileSnapshotService } from '@/services/snapshots/FileSnapshotService';
import {
  getSquadOrchestratorSystemPrompt,
  getSquadWorkerSystemPrompt,
} from '@/services/squad/prompts';
import { isSquadSession } from '@/services/squad/sessionTags';
import { getTerminalService } from '@/services/TerminalService';
import type { QueuedUserMessageRunParams } from '@/types/types';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { SessionNotFoundError } from '@/utils/errors';
import { exitWithCode } from '@/utils/exitWithCode';
import { compressImageForLLM } from '@/utils/images/compressForLLM';
import { persistSystem } from '@/utils/messages/persistSystem';
import {
  getDeprecatedModelNotice,
  getExpensiveModelNotice,
  isMessageText,
  resolveActiveModel,
} from '@/utils/modelUtils';
import { getEnabledQueuePlacement } from '@/utils/queuedMessagesFeatureFlag';
import {
  getCliRuntimeMetricLabels,
  recordStartupLatency,
} from '@/utils/startupLatency';
import {
  buildIdentifierMap,
  buildToolCatalogResponse,
  getRegisteredTools,
} from '@/utils/toolCatalog';
import { generateUUID } from '@/utils/uuid';

import type { McpServerConfig } from '@industry/common/settings';
import type { PendingPermission } from '@industry/daemon-client';

/**
 * JSON-RPC streaming exec runner
 *
 * Uses shared infrastructure for unified behavior across modes.
 */

/**
 * Get resource files in a skill folder (excludes SKILL.md)
 */
async function getSkillResources(
  skillFilePath: string
): Promise<Array<{ name: string; path: string; type: 'reference' | 'asset' }>> {
  if (skillFilePath.startsWith('builtin:')) {
    return [];
  }

  try {
    const skillDir = path.dirname(skillFilePath);
    const entries = await fs.readdir(skillDir, { withFileTypes: true });

    const resources: Array<{
      name: string;
      path: string;
      type: 'reference' | 'asset';
    }> = [];

    for (const entry of entries) {
      // Skip SKILL.md and hidden files
      if (entry.name === 'SKILL.md' || entry.name.startsWith('.')) {
        continue;
      }

      // Only include files, not subdirectories
      if (entry.isFile()) {
        const filePath = path.join(skillDir, entry.name);
        const isMarkdown = entry.name.endsWith('.md');

        resources.push({
          name: entry.name,
          path: filePath,
          type: isMarkdown ? 'reference' : 'asset',
        });
      }
    }

    return resources;
  } catch {
    // If we can't read the directory (e.g., builtin skills), return empty
    return [];
  }
}

function normalizeProtocolMcpOAuthTokenEndpointAuthMethod(
  method: string | undefined
): McpOAuthTokenEndpointAuthMethod | undefined {
  switch (method) {
    case McpOAuthTokenEndpointAuthMethod.ClientSecretBasic:
      return McpOAuthTokenEndpointAuthMethod.ClientSecretBasic;
    case McpOAuthTokenEndpointAuthMethod.ClientSecretPost:
      return McpOAuthTokenEndpointAuthMethod.ClientSecretPost;
    case McpOAuthTokenEndpointAuthMethod.None:
      return McpOAuthTokenEndpointAuthMethod.None;
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function normalizeProtocolMcpOAuthConfig(
  oauth:
    | false
    | {
        scopes?: string[];
        authorizationServerIssuer?: string;
        clientMetadataUrl?: string;
        clientId?: string;
        clientSecret?: string;
        callbackPort?: number;
        tokenEndpointAuthMethod?: string;
      }
    | undefined
): Extract<McpServerConfig, { type: 'http' | 'sse' }>['oauth'] {
  if (!oauth) {
    return oauth;
  }

  return {
    ...oauth,
    tokenEndpointAuthMethod: normalizeProtocolMcpOAuthTokenEndpointAuthMethod(
      oauth.tokenEndpointAuthMethod
    ),
  };
}

/**
 * Convert JSON-RPC mcpServers array to the Record<string, McpServerConfig>
 * format expected by McpService, then merge with filesystem-managed configs.
 * Filesystem configs take precedence on name collision.
 */
function mergeJsonRpcMcpConfigs(
  jsonRpcServers: NonNullable<InitializeSessionRequest['params']['mcpServers']>,
  filesystemConfigs: Record<string, McpServerConfig>
): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = Object.create(null) as Record<
    string,
    McpServerConfig
  >;

  // First, add all SDK-provided servers (these can be overridden)
  for (const server of jsonRpcServers) {
    if ('command' in server) {
      // Stdio transport (no type field)
      merged[server.name] = {
        type: 'stdio',
        command: server.command,
        args: server.args,
        env:
          server.env && Object.keys(server.env).length > 0
            ? server.env
            : undefined,
        disabled: false,
      };
    } else {
      // Remote HTTP or SSE transport
      const headersRecord: Record<string, string> = Object.create(
        null
      ) as Record<string, string>;
      for (const header of server.headers) {
        headersRecord[header.name] = header.value;
      }

      merged[server.name] = {
        type: server.type,
        url: server.url,
        headers:
          Object.keys(headersRecord).length > 0 ? headersRecord : undefined,
        oauth: normalizeProtocolMcpOAuthConfig(server.oauth),
        disabled: false,
      };
    }
  }

  // Then, overlay filesystem configs (these take precedence)
  for (const [name, config] of Object.entries(filesystemConfigs)) {
    if (name in merged) {
      logInfo(
        '[JsonRpc] Filesystem MCP config takes precedence over SDK config',
        { name }
      );
    }
    merged[name] = config;
  }

  return merged;
}

/**
 * Items on the runner's request queue. ADD_USER_MESSAGE requests carry a
 * full JSON-RPC request; `resume_pending_tools` is a synthetic marker
 * pushed by handleLoadSession so resume runs through the same serial state
 * machine as user messages.
 */
type QueuedItem =
  | { kind: 'message'; request: AddUserMessageRequest }
  | { kind: 'resume_pending_tools' };

/**
 * Upper bound on how long the first agent turn waits for MCP servers to load
 * when `blockOnMcpLoad` is set. On timeout the agent proceeds with whatever
 * tools have registered so far (MCP tools are still picked up dynamically on
 * later turns as servers settle). Bounds the worst case so a hung server can
 * never stall the turn indefinitely; session init is never affected.
 */
const DEFAULT_MCP_BLOCKING_LOAD_TIMEOUT_MS = 60_000;

/**
 * Resolve the MCP-load gate timeout. Overridable via
 * `INDUSTRY_MCP_BLOCKING_LOAD_TIMEOUT_MS` (milliseconds) so the bound can be
 * tuned per environment and exercised deterministically in tests; falls back
 * to the default when unset or invalid.
 */
function getMcpBlockingLoadTimeoutMs(): number {
  const raw = process.env.INDUSTRY_MCP_BLOCKING_LOAD_TIMEOUT_MS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MCP_BLOCKING_LOAD_TIMEOUT_MS;
}

export class JsonRpcStreamingExecRunner {
  private sessionController: SessionController;

  private protocolAdapter: JsonRpcProtocolAdapter;

  private permissionHandler: PermissionRequestHandler;

  // Single state machine for both user messages and post-load_session
  // auto-resumes. Using a union here avoids a parallel "fire-and-forget +
  // isAgentLoopInProgress" path and the TOCTOU window it implied.
  private messageQueue: QueuedItem[] = [];

  private isProcessing = false;

  // Gate load_session behind in-flight initialize_session for the same ID.
  private initializingSessions = new Map<string, Promise<void>>();

  private isShuttingDown = false;

  private pendingRequestCount = 0;

  private rl: readline.Interface | undefined;

  private signalHandler: ((signal: NodeJS.Signals) => void) | undefined;

  private parentDisconnectUnsub: (() => void) | undefined;

  private interruptAgent: (() => Promise<void>) | null = null;

  private pendingInterrupt = false;

  private isAgentLoopInProgress = false;

  private activeTurnSettledPromise: Promise<void> | null = null;

  private activeTurnSettledResolve: (() => void) | null = null;

  private activeInterruptPromise: Promise<void> | null = null;

  private wasInterrupted = false;

  private didReceiveProcessExitSignal = false;

  // When true (set from initialize_session), the first agent turn waits for
  // MCP servers to finish loading so MCP tools are available on turn one.
  private blockOnMcpLoad = false;

  private systemPromptOverride: string | undefined;

  // Latch so the MCP-load gate runs at most once per process.
  private mcpLoadGateDone = false;

  private isEndOfLoopMessage(item: QueuedItem): boolean {
    return (
      item.kind === 'message' &&
      getEnabledQueuePlacement(item.request.params.queuePlacement) ===
        QueuePlacement.EndOfLoop
    );
  }

  private isProcessableQueuedItem(item: QueuedItem): boolean {
    return !this.isEndOfLoopMessage(item);
  }

  private takeQueuedItem(
    predicate: (item: QueuedItem) => boolean
  ): QueuedItem | null {
    const itemIndex = this.messageQueue.findIndex(predicate);
    if (itemIndex === -1) {
      return null;
    }

    const [item] = this.messageQueue.splice(itemIndex, 1);
    return item ?? null;
  }

  private takeQueuedMessage(
    predicate: (request: AddUserMessageRequest) => boolean
  ): AddUserMessageRequest | null {
    const item = this.takeQueuedItem(
      (queuedItem) =>
        queuedItem.kind === 'message' && predicate(queuedItem.request)
    );
    return item?.kind === 'message' ? item.request : null;
  }

  private drainQueuedMessagesMatching(
    predicate: (request: AddUserMessageRequest) => boolean
  ): AddUserMessageRequest[] {
    const drainedMessages: AddUserMessageRequest[] = [];
    const remainingQueue: QueuedItem[] = [];

    for (const item of this.messageQueue) {
      if (item.kind === 'message' && predicate(item.request)) {
        drainedMessages.push(item.request);
      } else {
        remainingQueue.push(item);
      }
    }

    this.messageQueue = remainingQueue;
    return drainedMessages;
  }

  private drainAllQueuedMessagesAndClearQueue(): AddUserMessageRequest[] {
    const drainedMessages = this.messageQueue.flatMap((item) =>
      item.kind === 'message' ? [item.request] : []
    );
    this.messageQueue = [];
    return drainedMessages;
  }

  private async compressBase64ImagesForLLM(
    images?: Base64ImageSource[]
  ): Promise<Base64ImageSource[]> {
    if (!images?.length) {
      return [];
    }

    logInfo('[JsonRpc] Compressing images for LLM', {
      count: images.length,
    });

    return Promise.all(
      images.map(async (image) => {
        const buffer = Buffer.from(image.data, 'base64');
        const compressed = await compressImageForLLM(buffer, image.mediaType);
        return {
          type: 'base64' as const,
          data: compressed.buffer.toString('base64'),
          mediaType: compressed.contentType as Base64ImageSource['mediaType'],
        };
      })
    );
  }

  private takeNextQueuedItemForProcessing(): QueuedItem | null {
    const processableItem = this.takeQueuedItem((item) =>
      this.isProcessableQueuedItem(item)
    );
    if (processableItem) {
      return processableItem;
    }

    const item = this.takeQueuedItem((queuedItem) =>
      this.isEndOfLoopMessage(queuedItem)
    );
    if (!item || item.kind !== 'message') {
      return item ?? null;
    }

    const { queuePlacement: _queuePlacement, ...params } = item.request.params;
    return {
      kind: 'message',
      request: {
        ...item.request,
        params,
      },
    };
  }

  private async toDrainedQueuedUserMessage(
    req: AddUserMessageRequest
  ): Promise<QueuedUserMessageRunParams | null> {
    const resolvedParams = await this.resolveDeferredUserMessageParams(
      req.params,
      req.id
    );
    if (!resolvedParams) {
      return null;
    }

    const {
      queuePlacement: _queuePlacement,
      images,
      files,
      ...params
    } = resolvedParams;
    const sessionId = this.sessionController.getSessionId();
    const processedFiles = sessionId
      ? await this.sessionController.processFileAttachments(sessionId, files)
      : files;
    const compressedImages = await this.compressBase64ImagesForLLM(images);

    return {
      ...params,
      images: convertBase64ImagesToAttachments(compressedImages),
      files: processedFiles,
      requestId: req.id,
    };
  }

  private async resolveDeferredUserMessageParams(
    params: AddUserMessageRequest['params'],
    requestId?: string
  ): Promise<AddUserMessageRequest['params'] | null> {
    if (params.skipAgentLoop) {
      return params;
    }

    const rawText = params.text.trim();
    const result = await resolveDeferredPromptFromRawText(rawText, {
      addEphemeralSystemMessage: (content, options) => {
        persistSystem(
          (action) => getConversationStateManager().updateAction(action),
          content,
          options?.visibility ?? MessageVisibility.UserOnly
        );
      },
    });

    if (result.status === 'unresolved') {
      return params;
    }

    if (result.status === 'failed') {
      persistSystem(
        (action) => getConversationStateManager().updateAction(action),
        result.message,
        MessageVisibility.UserOnly,
        requestId ? { requestId } : undefined
      );
      return null;
    }

    return { ...params, text: result.result.messageText };
  }

  private async resolveDeferredUserMessageRequest(
    request: AddUserMessageRequest
  ): Promise<AddUserMessageRequest | null> {
    const params = await this.resolveDeferredUserMessageParams(
      request.params,
      request.id
    );
    return params ? { ...request, params } : null;
  }

  private mcpStatusHandle: McpStatusListenerHandle | null = null;

  private mcpAuthEventCleanup: (() => void) | null = null;

  private mcpToolRefreshCleanup: (() => void) | null = null;

  private associatedPermissionCleanup: (() => void) | null = null;

  private ideInitPromise: Promise<void> | null = null;

  private ideState: IdeContextState = {
    activeFile: null,
    activeFileSelection: null,
    openFiles: [],
    diagnostics: {},
    connectionStatus: IdeConnectionStatus.Disconnected,
  };

  constructor() {
    // Reset and get fresh SessionController
    resetSessionController();
    this.sessionController = getSessionController();

    // Create protocol adapter
    this.protocolAdapter = new JsonRpcProtocolAdapter(this.sessionController);

    // Subagent prompts are forwarded to their connected parent; no-approver
    // delegated workers still auto-reject.
    this.permissionHandler = new PermissionRequestHandler(
      async (batch: ToolConfirmationBatch): Promise<PermissionResponse> =>
        maybeAutoRejectDelegatedPermission(batch, {
          shouldAutoReject: isNoApproverDelegatedSession,
          updateAction: (action) =>
            getConversationStateManager().updateAction(action),
        }) ?? this.protocolAdapter.requestPermission(batch)
    );
  }

  private subscribeToAssociatedPermissionRequests(sessionId: string): void {
    this.associatedPermissionCleanup?.();
    const daemonAdapter = getTuiDaemonAdapter();
    this.associatedPermissionCleanup =
      daemonAdapter.subscribeToPermissionRequests(
        sessionId,
        async (permission: PendingPermission) => {
          try {
            const relayedRequestId = generateUUID();
            const response = await this.protocolAdapter.requestPermission(
              JsonRpcStreamingExecRunner.permissionToBatch(permission),
              {
                requestId: relayedRequestId,
                sessionId: permission.sessionId,
                associatedSessionIds: permission.associatedSessionIds,
              }
            );

            await daemonAdapter.respondToPermission({
              permissionId: permission.requestId,
              sessionId: permission.sessionId,
              selectedOption: response.outcome,
              ...(response.comment !== undefined && {
                comment: response.comment,
              }),
              ...(response.editedSpecContent !== undefined && {
                editedSpecContent: response.editedSpecContent,
              }),
            });
          } catch (error) {
            logWarn('[JsonRpc] Relayed permission handling failed', {
              requestId: permission.requestId,
              sessionId: permission.sessionId,
              cause: error,
            });
            await daemonAdapter
              .respondToPermission({
                permissionId: permission.requestId,
                sessionId: permission.sessionId,
                selectedOption: ToolConfirmationOutcome.Cancel,
              })
              .catch((cancelError) => {
                logWarn('[JsonRpc] Failed to cancel relayed permission', {
                  requestId: permission.requestId,
                  sessionId: permission.sessionId,
                  cause: cancelError,
                });
              });
          }
        }
      );
  }

  private static permissionToBatch(
    permission: PendingPermission
  ): ToolConfirmationBatch {
    return {
      toolUses: permission.toolUses.map((toolUse) => ({
        toolUseId: toolUse.toolUse.id,
        toolName: toolUse.toolUse.name,
        toolInput: toolUse.toolUse.input,
        confirmationType: toolUse.confirmationType,
        details: toolUse.details,
      })) satisfies ToolConfirmationBatch['toolUses'],
      options: permission.options,
    };
  }

  /**
   * Main entry point - starts processing stdin requests
   */
  async run(): Promise<void> {
    logInfo('[JsonRpc] Starting JSON-RPC streaming mode');
    getDroolRuntimeService().setDroolMode(
      DroolMode.InteractiveCLI,
      DroolSubMode.JsonRpc
    );

    CliTelemetryClient.getInstance().setDroolMode(
      DroolMode.InteractiveCLI,
      DroolSubMode.JsonRpc
    );

    // Set up MCP status listeners
    this.setupMcpStatusListeners();

    // Set up MCP OAuth auth listeners
    this.setupMcpAuthListeners();

    // Refresh protocol tool allowlist after MCP tool registration changes
    this.setupMcpToolRefreshListener();

    // Initialize IDE connection (VSCode/JetBrains MCP)
    this.ideInitPromise = this.initializeIdeConnection();

    return new Promise<void>((resolve) => {
      this.setupInputHandlers(resolve);
      this.setupSignalHandlers(resolve);
      // Route a broken parent pipe (detected by the protocol adapter) through
      // the same graceful teardown as signals/input-close, so an active
      // command's children are released instead of being orphaned.
      this.parentDisconnectUnsub = this.protocolAdapter.onParentDisconnect(
        () => {
          logWarn('[JsonRpc] Parent disconnected, shutting down');
          this.removeSignalHandlers();
          this.rl?.close();
          resolve();
        }
      );
      Metrics.addToCounter(
        Metric.CLI_JSONRPC_CHILD_READY_LATENCY,
        process.uptime() * 1000,
        getCliRuntimeMetricLabels()
      );
      logInfo('[JsonRpc] Waiting for JSON-RPC requests on stdin...');
    });
  }

  /**
   * Graceful cleanup
   */
  async stop(): Promise<void> {
    if (this.mcpStatusHandle) {
      this.mcpStatusHandle.cleanup();
      this.mcpStatusHandle = null;
    }

    if (this.mcpAuthEventCleanup) {
      this.mcpAuthEventCleanup();
      this.mcpAuthEventCleanup = null;
    }

    if (this.mcpToolRefreshCleanup) {
      this.mcpToolRefreshCleanup();
      this.mcpToolRefreshCleanup = null;
    }

    if (this.associatedPermissionCleanup) {
      this.associatedPermissionCleanup();
      this.associatedPermissionCleanup = null;
    }

    this.protocolAdapter.rejectAllPendingPermissions();
    this.protocolAdapter.rejectAllPendingAskUserRequests();
    this.protocolAdapter.dispose();
    this.parentDisconnectUnsub?.();
    this.parentDisconnectUnsub = undefined;
    this.removeSignalHandlers();
    this.rl?.close();

    // Kill all tracked Execute tool processes (vitest, pnpm, etc.)
    logInfo('[JsonRpc] stop() called - killing tracked processes', {
      sessionId: this.sessionController.getSessionId() ?? undefined,
      decompSessionType: getDecompSessionTypeFromTags(
        getSessionService().getCurrentSessionTags()
      ),
      toolCount: processTracker.getTrackedToolCount(),
    });
    await processTracker.killAllProcesses();

    // Release terminal-service children too. processTracker only tracks the
    // Execute wrappers; foreground terminal subprocesses (detached process
    // groups owned by LocalTerminalService) are freed via releaseAll(),
    // matching the shutdownCoordinator's tool-processes teardown hook.
    await getTerminalService()
      .releaseAll()
      .catch((error) => {
        logWarn('[JsonRpc] Failed to release terminal services on shutdown', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    // Wait for IDE init to settle before tearing down, so a late connect
    // doesn't outlive the cleanup call.
    if (this.ideInitPromise) {
      await this.ideInitPromise.catch(() => {});
    }
    await IdeContextManager.getInstance().cleanup();

    // Clean up MCP servers (closes Playwright browser, etc.)
    await getMcpService().cleanup();

    // Shut down sandbox service (stops SRT proxies)
    await getSandboxService().shutdown();
  }

  private setupMcpStatusListeners(): void {
    const mcpService = getMcpService();
    this.mcpStatusHandle = setupMcpStatusListeners((notification) => {
      agentEventBus.emit(AgentEvent.McpStatusChanged, { notification });
    }, mcpService);
  }

  private setupMcpAuthListeners(): void {
    const mcpService = getMcpService();

    const handleAuthRequired = (info: McpAuthRequiredInfo) => {
      agentEventBus.emit(AgentEvent.McpAuthRequired, {
        notification: {
          type: SessionNotificationType.MCP_AUTH_REQUIRED,
          serverName: info.serverName,
          authUrl: info.authUrl,
          message: info.message,
          state: info.state,
        },
      });
    };

    const handleAuthCompleted = (info: McpAuthCompletedInfo) => {
      agentEventBus.emit(AgentEvent.McpAuthCompleted, {
        notification: {
          type: SessionNotificationType.MCP_AUTH_COMPLETED,
          serverName: info.serverName,
          outcome: info.outcome,
          message: info.message,
        },
      });
    };

    mcpService.on(McpServiceEventType.AUTH_REQUIRED, handleAuthRequired);
    mcpService.on(McpServiceEventType.AUTH_COMPLETED, handleAuthCompleted);

    this.mcpAuthEventCleanup = () => {
      mcpService.off(McpServiceEventType.AUTH_REQUIRED, handleAuthRequired);
      mcpService.off(McpServiceEventType.AUTH_COMPLETED, handleAuthCompleted);
    };
  }

  private setupMcpToolRefreshListener(): void {
    const mcpService = getMcpService();

    // Run inside a try/catch so an unexpected throw inside the
    // EventEmitter callback cannot crash the JSON-RPC process mid-session.
    const handleToolsUpdated = () => {
      try {
        this.applyProtocolToolSelection();
      } catch (error) {
        logWarn(
          '[JsonRpc] Failed to refresh protocol tool selection after MCP tools updated',
          { cause: error }
        );
      }
    };

    mcpService.on(McpServiceEventType.TOOLS_UPDATED, handleToolsUpdated);

    this.mcpToolRefreshCleanup = () => {
      mcpService.off(McpServiceEventType.TOOLS_UPDATED, handleToolsUpdated);
    };
  }

  private async initializeIdeConnection(): Promise<void> {
    try {
      const ideManager = IdeContextManager.getInstance();
      const client = await ideManager.initialize({
        onActiveFileChange: (file, selection) => {
          this.ideState = {
            ...this.ideState,
            activeFile: file,
            activeFileSelection: selection,
          };
        },
        onOpenFilesChange: (files) => {
          this.ideState = { ...this.ideState, openFiles: files };
        },
        onDiagnosticsChange: (filePath, diagnostics) => {
          this.ideState = {
            ...this.ideState,
            diagnostics: {
              ...this.ideState.diagnostics,
              [filePath]: diagnostics,
            },
          };
        },
        onDisconnect: () => {
          this.ideState = {
            activeFile: null,
            activeFileSelection: null,
            openFiles: [],
            diagnostics: {},
            connectionStatus: IdeConnectionStatus.Disconnected,
          };
        },
      });

      if (client) {
        this.ideState = {
          ...this.ideState,
          connectionStatus: IdeConnectionStatus.Connected,
        };
        logInfo('[JsonRpc] IDE connection established');
      }
    } catch (error) {
      logWarn('[JsonRpc] Failed to initialize IDE connection', {
        cause: error,
      });
    }
  }

  private async emitCurrentMcpStatus(): Promise<void> {
    await this.mcpStatusHandle?.emitCurrentStatus();
  }

  /**
   * Route request to appropriate handler
   * ADD_USER_MESSAGE is queued for sequential processing; other requests are handled immediately
   */
  private routeRequest(request: ClientRequest): void {
    switch (request.method) {
      case DroolServerMethod.ADD_USER_MESSAGE:
        // Queue for sequential processing, respond immediately
        this.enqueueRequest(request);
        break;

      case DroolServerMethod.RESOLVE_QUEUED_USER_MESSAGE:
      case DroolServerMethod.INTERRUPT_SESSION:
      case DroolServerMethod.CLOSE_SESSION:
      case DroolServerMethod.KILL_WORKER_SESSION:
      case DroolServerMethod.LOAD_SESSION:
      case DroolServerMethod.INITIALIZE_SESSION:
      case DroolServerMethod.UPDATE_SESSION_SETTINGS:
      case DroolServerMethod.TOGGLE_MCP_SERVER:
      case DroolServerMethod.AUTHENTICATE_MCP_SERVER:
      case DroolServerMethod.CLEAR_MCP_AUTH:
      case DroolServerMethod.ADD_MCP_SERVER:
      case DroolServerMethod.REMOVE_MCP_SERVER:
      case DroolServerMethod.LIST_MCP_REGISTRY:
      case DroolServerMethod.LIST_MCP_TOOLS:
      case DroolServerMethod.LIST_TOOLS:
      case DroolServerMethod.LIST_MCP_SERVERS:
      case DroolServerMethod.TOGGLE_MCP_TOOL:
      case DroolServerMethod.CANCEL_MCP_AUTH:
      case DroolServerMethod.SUBMIT_MCP_AUTH_CODE:
      case DroolServerMethod.SUBMIT_MCP_AUTH_ERROR:
      case DroolServerMethod.LIST_SKILLS:
      case DroolServerMethod.LIST_COMMANDS:
      case DroolServerMethod.GET_CONTEXT_STATS:
      case DroolServerMethod.GET_CONTEXT_BREAKDOWN:
      case DroolServerMethod.SUBMIT_BUG_REPORT:
      case DroolServerMethod.GET_REWIND_INFO:
      case DroolServerMethod.EXECUTE_REWIND:
      case DroolServerMethod.COMPACT_SESSION:
      case DroolServerMethod.FORK_SESSION:
      case DroolServerMethod.RENAME_SESSION:
      case DroolServerMethod.WARMUP_CACHE:
        void this.executeRequest(request);
        break;

      default: {
        // This should never be reached - all methods are explicitly handled
        // Type assertion needed since TypeScript knows this is unreachable
        const exhaustiveCheck: never = request;
        this.emitError((exhaustiveCheck as ClientRequest).id, {
          code: JsonRpcErrorCode.METHOD_NOT_FOUND,
          message: `Unknown method: ${(exhaustiveCheck as ClientRequest).method}`,
        });
        break;
      }
    }
  }

  /**
   * Enqueue user message request for sequential processing
   */
  private enqueueRequest(request: AddUserMessageRequest): void {
    try {
      let queuedRequest = request;
      if (
        getEnabledQueuePlacement(request.params.queuePlacement) ===
          QueuePlacement.EndOfLoop &&
        !this.isProcessing &&
        !this.isAgentLoopInProgress
      ) {
        const { queuePlacement: _queuePlacement, ...params } = request.params;
        queuedRequest = { ...request, params };
      }

      this.messageQueue.push({ kind: 'message', request: queuedRequest });

      if (!this.isProcessing) {
        void this.processRequestQueue();
      }

      // Send immediate success response - message queued
      this.protocolAdapter.emitResponse(request.id, {});

      logInfo('[JsonRpc] User message queued', {
        sessionId: this.sessionController.getSessionId() ?? undefined,
        requestId: request.id,
      });
    } catch (error) {
      logWarn('[JsonRpc] Error when queuing user message request', {
        cause: error,
      });

      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: 'Failed to queue user message',
        data: {
          cause: error,
        },
      });
    }
  }

  /** Process queued items without overlapping an active agent loop. */
  private async processRequestQueue(): Promise<void> {
    this.isProcessing = true;

    while (!this.isShuttingDown && !this.isAgentLoopInProgress) {
      const item = this.takeNextQueuedItemForProcessing();
      if (!item) {
        break;
      }

      if (item.kind === 'resume_pending_tools') {
        try {
          await this.processResumePendingTools();
        } catch (error) {
          logException(error, '[JsonRpc] Error in resume queue item');
        }
        continue;
      }

      try {
        await this.executeRequest(item.request);
      } catch (error) {
        logException(error, '[JsonRpc] Error in request queue processing');
        this.emitError(item.request.id, {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.isProcessing = false;
    if (!this.isAgentLoopInProgress && this.interruptAgent === null) {
      this.pendingInterrupt = false;
    }
  }

  /**
   * Drain all queued ADD_USER_MESSAGE requests for mid-loop injection.
   * Returns null if no messages are queued.
   * Drained messages are removed from the queue so they won't be re-processed
   * by processRequestQueue.
   */
  private async drainQueuedMessages(): Promise<
    QueuedUserMessageRunParams[] | null
  > {
    if (this.messageQueue.length === 0) return null;

    const drainedMessages = this.drainQueuedMessagesMatching(
      (request) =>
        getEnabledQueuePlacement(request.params.queuePlacement) !==
        QueuePlacement.EndOfLoop
    );

    if (drainedMessages.length === 0) return null;

    const resolvedMessages = await Promise.all(
      drainedMessages.map((req) => this.toDrainedQueuedUserMessage(req))
    );
    const validMessages = resolvedMessages.filter(
      (message): message is QueuedUserMessageRunParams => message !== null
    );

    return validMessages.length > 0 ? validMessages : null;
  }

  /**
   * Drain one end-of-loop queued ADD_USER_MESSAGE request at the AgentLoop
   * Stop-hook boundary. Steering/resume items always take priority.
   */
  private async drainEndOfLoopQueuedMessage(): Promise<QueuedUserMessageRunParams | null> {
    if (this.messageQueue.some((item) => this.isProcessableQueuedItem(item))) {
      return null;
    }

    const request = this.takeQueuedMessage(
      (queuedRequest) =>
        getEnabledQueuePlacement(queuedRequest.params.queuePlacement) ===
        QueuePlacement.EndOfLoop
    );
    if (!request) {
      return null;
    }

    return this.toDrainedQueuedUserMessage(request);
  }

  private processResolveQueuedUserMessage(
    request: ResolveQueuedUserMessageRequest
  ): void {
    const queuedRequest = this.takeQueuedMessage(
      (item) => item.id === request.params.requestId
    );
    if (!queuedRequest) {
      this.protocolAdapter.emitResponse(request.id, {});
      return;
    }

    if (request.params.action === ResolveQueuedUserMessageAction.UpdateQueue) {
      const queuePlacement = getEnabledQueuePlacement(
        request.params.queuePlacement
      );
      this.messageQueue.unshift({
        kind: 'message',
        request: {
          ...queuedRequest,
          params: {
            ...queuedRequest.params,
            queuePlacement,
          },
        },
      });

      if (!this.isProcessing) {
        void this.processRequestQueue();
      }
    }

    this.protocolAdapter.emitResponse(request.id, {});
  }

  /**
   * Drain queued ADD_USER_MESSAGE requests on interrupt and emit a
   * QUEUED_MESSAGES_DISCARDED notification with all drained steering prompt
   * text. End-of-loop queued prompts are removed from the executable daemon
   * queue, but remain paused in the client's SSM queue.
   */
  private drainQueueAndNotify(): void {
    if (this.messageQueue.length === 0) return;

    const drainedMessages = this.drainAllQueuedMessagesAndClearQueue();
    this.isProcessing = false;

    if (drainedMessages.length === 0) return;

    const steeringMessages = drainedMessages.filter(
      (drainedMessage) =>
        getEnabledQueuePlacement(drainedMessage.params.queuePlacement) !==
        QueuePlacement.EndOfLoop
    );
    const restoredSteeringText = steeringMessages
      .map((drainedMessage) => drainedMessage.params.text.trim())
      .filter(Boolean)
      .join('\n');
    const restoredSteeringCount = steeringMessages.length;
    const restoredRequestId =
      steeringMessages.length === 1 ? steeringMessages[0]?.id : undefined;

    logInfo('[JsonRpc] Drained queued messages on interrupt', {
      count: drainedMessages.length,
      messageCount: restoredSteeringCount,
    });

    if (!restoredSteeringText && !restoredRequestId) return;

    agentEventBus.emit(AgentEvent.QueuedMessagesDiscarded, {
      text: restoredSteeringText,
      ...(restoredRequestId && { requestId: restoredRequestId }),
    });
  }

  /**
   * Execute a validated JSON-RPC request
   */
  private async executeRequest(request: ClientRequest): Promise<void> {
    // Extract parent context from incoming request for trace propagation
    const parentContext = (request._meta as TraceContextMeta)?.traceparent
      ? OtelTracing.extractContext(request._meta as TraceContextMeta)
      : undefined;

    // Run within parent context so CLI spans become children of daemon spans
    await OtelTracing.runInContext(parentContext, async () => {
      try {
        this.pendingRequestCount++;
        const sessionId = tryExtractSessionId(request.params);

        await OtelTracing.trace(
          SpanName.CLI_RPC_REQUEST,
          async () => {
            switch (request.method) {
              case DroolServerMethod.INITIALIZE_SESSION:
                await this.handleInitializeSession(request);
                break;

              case DroolServerMethod.LOAD_SESSION:
                await this.handleLoadSession(request);
                break;

              case DroolServerMethod.ADD_USER_MESSAGE:
                await this.processUserMessage(request);
                break;

              case DroolServerMethod.RESOLVE_QUEUED_USER_MESSAGE:
                this.processResolveQueuedUserMessage(request);
                break;

              case DroolServerMethod.INTERRUPT_SESSION:
                await this.handleInterruptSession(request);
                break;

              case DroolServerMethod.CLOSE_SESSION:
                await this.handleCloseSession(request);
                break;

              case DroolServerMethod.KILL_WORKER_SESSION:
                await this.handleKillWorkerSession(request);
                break;

              case DroolServerMethod.UPDATE_SESSION_SETTINGS:
                await this.handleUpdateSessionSettings(request);
                break;

              case DroolServerMethod.TOGGLE_MCP_SERVER:
                await this.handleToggleMcpServer(request);
                break;

              case DroolServerMethod.AUTHENTICATE_MCP_SERVER:
                await this.handleAuthenticateMcpServer(request);
                break;

              case DroolServerMethod.CLEAR_MCP_AUTH:
                await this.handleClearMcpAuth(request);
                break;

              case DroolServerMethod.ADD_MCP_SERVER:
                await this.handleAddMcpServer(request);
                break;

              case DroolServerMethod.REMOVE_MCP_SERVER:
                await this.handleRemoveMcpServer(request);
                break;

              case DroolServerMethod.LIST_MCP_REGISTRY:
                await this.handleListMcpRegistry(request);
                break;

              case DroolServerMethod.LIST_MCP_TOOLS:
                await this.handleListMcpTools(request);
                break;

              case DroolServerMethod.LIST_TOOLS:
                await this.handleListTools(request);
                break;

              case DroolServerMethod.LIST_MCP_SERVERS:
                await this.handleListMcpServers(request);
                break;

              case DroolServerMethod.TOGGLE_MCP_TOOL:
                await this.handleToggleMcpTool(request);
                break;

              case DroolServerMethod.CANCEL_MCP_AUTH:
                await this.handleCancelMcpAuth(request);
                break;

              case DroolServerMethod.SUBMIT_MCP_AUTH_CODE:
                this.handleSubmitMcpAuthCode(request);
                break;

              case DroolServerMethod.SUBMIT_MCP_AUTH_ERROR:
                this.handleSubmitMcpAuthError(request);
                break;

              case DroolServerMethod.LIST_SKILLS:
                await this.handleListSkills(request);
                break;

              case DroolServerMethod.LIST_COMMANDS:
                await this.handleListCommands(request);
                break;

              case DroolServerMethod.GET_CONTEXT_STATS:
                await this.handleGetContextStats(request);
                break;

              case DroolServerMethod.GET_CONTEXT_BREAKDOWN:
                await this.handleGetContextBreakdown(request);
                break;

              case DroolServerMethod.SUBMIT_BUG_REPORT:
                await this.handleSubmitBugReport(request);
                break;

              case DroolServerMethod.GET_REWIND_INFO:
                await this.handleGetRewindInfo(request);
                break;

              case DroolServerMethod.EXECUTE_REWIND:
                await this.handleExecuteRewind(request);
                break;

              case DroolServerMethod.COMPACT_SESSION:
                await this.handleCompactSession(request);
                break;

              case DroolServerMethod.FORK_SESSION:
                await this.handleForkSession(request);
                break;

              case DroolServerMethod.RENAME_SESSION:
                await this.handleRenameSession(request);
                break;

              case DroolServerMethod.WARMUP_CACHE:
                await this.handleWarmupCache(request);
                break;

              default:
                // don't ever omit the request id here - the client
                // relies on it to correlate errors to requests
                this.emitError((request as ClientRequest).id, {
                  code: JsonRpcErrorCode.METHOD_NOT_FOUND,
                  message: `Unknown method: ${(request as ClientRequest).method}`,
                });
            }
          },
          {
            attributes: {
              [SpanAttribute.RPC_METHOD]: request.method,
              ...(sessionId != null
                ? { [SpanAttribute.SESSION_ID]: sessionId }
                : {}),
              // industry.session.origin is owned by the parent that
              // spawned this child; stamping here would double-count.
            },
          }
        );
      } catch (error) {
        logException(error, '[JsonRpcV2] Error processing request');
        const isSessionNotFound = error instanceof SessionNotFoundError;
        this.emitError(request.id, {
          code: isSessionNotFound
            ? JsonRpcErrorCode.ENTITY_NOT_FOUND
            : JsonRpcErrorCode.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.pendingRequestCount--;
      }
    });
  }

  // ============================================================================
  // REQUEST HANDLERS
  // ============================================================================

  private buildResolvedToolSelection(params: {
    modelId?: string;
    autonomyMode?: AutonomyMode;
    interactionMode?: DroolInteractionMode;
    autonomyLevel?: AutonomyLevel;
    specModeModelId?: string | null;
    /**
     * Additive opt-ins from session state. Each ID feeds the corresponding
     * tool's `isToolEnabled({ enabledToolIds })` gate (readiness report,
     * Slack, squad board) — NEVER used as a restrictive allowlist here.
     *
     * Restrictive allowlisting lives in `entrypoints/exec/handler.ts` (the
     * `--enabled-tools` CLI flag). If a future protocol client needs
     * restrictive semantics here, add a separate parameter — don't overload
     * this one.
     */
    additiveToolIds?: string[];
    /** Restrictive: tools to subtract from the default set. */
    disabledToolIds?: string[];
    skipPermissionsUnsafe?: boolean;
    depth?: number;
  }) {
    const resolvedSettings = resolveInteractionSettingsWithLegacyFallback({
      autonomyMode: params.autonomyMode,
      interactionMode: params.interactionMode,
      autonomyLevel: params.autonomyLevel,
    });
    const autoLevel =
      resolvedSettings.autonomyLevel &&
      resolvedSettings.autonomyLevel !== AutonomyLevel.Off
        ? resolvedSettings.autonomyLevel
        : undefined;

    return resolveToolSelection(
      {
        outputFormat: OutputFormat.Text,
        listTools: false,
        model: params.modelId,
        auto: autoLevel,
        skipPermissionsUnsafe: params.skipPermissionsUnsafe,
        useSpec:
          resolvedSettings.interactionMode === DroolInteractionMode.Spec ||
          params.specModeModelId != null,
        specModel: params.specModeModelId ?? undefined,
        // options.enabledTools intentionally omitted — always additive here
        // (see additiveToolIds JSDoc above).
        disabledTools: params.disabledToolIds,
        depth: params.depth,
      },
      {
        allowCombinedToolOverrides: true,
        additiveToolIds: params.additiveToolIds,
        persistEnabledSpecialTools: false,
      }
    );
  }

  /**
   * Drop tool identifiers that are no longer registered (e.g. MCP tools whose
   * server disconnected or was unregistered). resolveToolSelection throws
   * MetaError on unknown identifiers, which would otherwise crash the
   * TOOLS_UPDATED refresh path or fail an inbound request.
   *
   * We only prune in-memory for this resolution; the persisted
   * enabledToolIds/disabledToolIds on the session are intentionally left
   * untouched so that when a tool (for example an MCP tool) becomes
   * available again, the user's prior selection is honored.
   *
   * If the registry is empty we treat it as uninitialized and skip filtering
   * so we don't wipe out the user's selection before tools get registered.
   */
  private filterKnownToolIdentifiers(ids: string[]): string[] {
    if (ids.length === 0) return ids;
    const registeredTools = getRegisteredTools();
    if (registeredTools.length === 0) return ids;
    const identifierMap = buildIdentifierMap(registeredTools);
    return ids.filter((id) => identifierMap.has(id.trim().toLowerCase()));
  }

  private applyProtocolToolSelection(params?: {
    skipPermissionsUnsafe?: boolean;
  }): void {
    const sessionService = getSessionService();
    const enabledToolIds = this.filterKnownToolIdentifiers(
      sessionService.getEnabledToolIds()
    );
    const disabledToolIds = this.filterKnownToolIdentifiers(
      sessionService.getDisabledToolIds()
    );
    const skipPermissionsUnsafe =
      params?.skipPermissionsUnsafe ??
      getExecRuntimeConfig().getSkipAllConfirmations();
    getExecRuntimeConfig().setSkipAllConfirmations(skipPermissionsUnsafe);

    // Session `enabledToolIds` is always additive opt-in — each gated tool
    // turns itself on via its own isToolEnabled check. Only `disabledToolIds`
    // produces a restrictive allowlist at the protocol layer.
    if (disabledToolIds.length === 0) {
      getExecRuntimeConfig().setAllowedToolIds(null);
      return;
    }

    const settings = this.sessionController.getSettings();
    const selection = this.buildResolvedToolSelection({
      modelId: settings.modelId,
      autonomyMode: settings.autonomyMode,
      interactionMode: settings.interactionMode,
      autonomyLevel: settings.autonomyLevel,
      specModeModelId: settings.specModeModelId,
      additiveToolIds: enabledToolIds,
      disabledToolIds,
      skipPermissionsUnsafe,
      depth: getExecRuntimeConfig().getDepth(),
    });

    getExecRuntimeConfig().setAllowedToolIds(Array.from(selection.allowed));
  }

  private async handleInitializeSession(
    request: InitializeSessionRequest
  ): Promise<void> {
    const initializeStart = performance.now();
    let initializeOutcome = 'success';
    logInfo('[JsonRpc] Handling initialize_session', {
      droolRequestId: request.id,
      sessionId: request.params.sessionId,
      machineId: request.params.machineId,
      cwd: request.params.cwd,
    });

    // Track init so same-session loads wait for local creation.
    const trackingSessionId = request.params.sessionId;
    let resolveInit: (() => void) | undefined;
    let rejectInit: ((err: unknown) => void) | undefined;
    if (trackingSessionId) {
      const initPromise = new Promise<void>((resolve, reject) => {
        resolveInit = resolve;
        rejectInit = reject;
      });
      this.initializingSessions.set(trackingSessionId, initPromise);
      // Avoid unhandled rejection if no load awaits this.
      void initPromise.catch(() => {});
    }

    try {
      const {
        sessionId: requestSessionId,
        cwd,
        workspaceId,
        machineId,
        autonomyMode,
        interactionMode,
        autonomyLevel,
        modelId,
        reasoningEffort,
        systemPromptOverride,
        specModeModelId,
        specModeReasoningEffort,
        missionSettings,
        compactionThresholdCheckEnabled,
        decompSessionType,
        sessionLocation,
        sessionSource,
        sessionOriginHint,
        tags,
        privacyLevel,
        title,
        decompMissionId,
        enabledToolIds,
        disabledToolIds,
        skipPermissionsUnsafe,
        mcpOAuthCallbackUri,
        blockOnMcpLoad,
      } = request.params;

      this.blockOnMcpLoad = blockOnMcpLoad ?? false;
      this.systemPromptOverride = systemPromptOverride;

      // Set MCP OAuth callback URI for remote sessions (web or desktop frontend)
      if (mcpOAuthCallbackUri) {
        getMcpService().setRemoteCallbackUri(mcpOAuthCallbackUri);
      }

      const hasDecoupledAutonomyFields = hasDecoupledInteractionSettings({
        interactionMode,
        autonomyLevel,
      });

      const availableModelsStart = performance.now();
      const availableModelsPromise = getAvailableModelsForResponse()
        .then((models) => {
          recordStartupLatency(
            Metric.CLI_JSONRPC_INIT_AVAILABLE_MODELS_LATENCY,
            availableModelsStart,
            { outcome: 'success' }
          );
          return models;
        })
        .catch((err) => {
          recordStartupLatency(
            Metric.CLI_JSONRPC_INIT_AVAILABLE_MODELS_LATENCY,
            availableModelsStart,
            { outcome: 'error' }
          );
          logWarn(
            '[JsonRpc] Failed to fetch available models during session creation, using defaults',
            {
              cause: err,
            }
          );
          return [] as Awaited<
            ReturnType<typeof getAvailableModelsForResponse>
          >;
        });

      const normalizedSessionId = requestSessionId || generateUUID();
      const normalizedMissionId =
        decompSessionType === DecompSessionType.Orchestrator
          ? (decompMissionId ?? normalizedSessionId)
          : decompMissionId;
      const normalizedTags =
        decompSessionType !== undefined && normalizedMissionId !== undefined
          ? upsertMissionSessionTag(tags, {
              role: decompSessionType,
              missionId: normalizedMissionId,
            })
          : tags;
      const { callingSessionId, callingToolUseId } =
        getSubagentCallingMetadata(normalizedTags);

      const createSessionStart = performance.now();
      const sessionPromise = this.sessionController
        .createSession({
          sessionId: normalizedSessionId,
          cwd,
          workspaceId,
          machineId,
          sessionLocation,
          sessionSource,
          sessionOriginHint,
          tags: normalizedTags,
          ...(privacyLevel ? { privacyLevel } : {}),
          callingSessionId,
          callingToolUseId,
          sessionTitle: title,
          enabledToolIds,
          disabledToolIds,
          initialSettings: {
            ...(!hasDecoupledAutonomyFields &&
              autonomyMode !== undefined && { autonomyMode }),
            ...(interactionMode !== undefined && { interactionMode }),
            ...(autonomyLevel !== undefined && { autonomyLevel }),
            ...(modelId !== undefined && { modelId }),
            ...(reasoningEffort !== undefined && { reasoningEffort }),
            ...(specModeModelId !== undefined && { specModeModelId }),
            ...(specModeReasoningEffort !== undefined && {
              specModeReasoningEffort,
            }),
            ...(missionSettings !== undefined && { missionSettings }),
            ...(compactionThresholdCheckEnabled !== undefined && {
              compactionThresholdCheckEnabled,
            }),
          },
        })
        .then((sessionId) => {
          recordStartupLatency(
            Metric.CLI_JSONRPC_INIT_CREATE_SESSION_LATENCY,
            createSessionStart,
            { outcome: 'success' }
          );
          return sessionId;
        })
        .catch((error) => {
          recordStartupLatency(
            Metric.CLI_JSONRPC_INIT_CREATE_SESSION_LATENCY,
            createSessionStart,
            { outcome: 'error' }
          );
          throw error;
        });

      const [availableModels, sessionId] = await Promise.all([
        availableModelsPromise,
        sessionPromise,
      ]);

      const toolSelectionStart = performance.now();
      let toolSelectionOutcome = 'success';
      try {
        this.applyProtocolToolSelection({ skipPermissionsUnsafe });
      } catch (error) {
        toolSelectionOutcome = 'error';
        throw error;
      } finally {
        recordStartupLatency(
          Metric.CLI_JSONRPC_INIT_TOOL_SELECTION_LATENCY,
          toolSelectionStart,
          { outcome: toolSelectionOutcome }
        );
      }

      const snapshotStart = performance.now();
      let snapshotOutcome = 'success';
      try {
        const snapshotService = getFileSnapshotService();
        await snapshotService.initialize();
        await snapshotService.startSession(sessionId);
      } catch (error) {
        snapshotOutcome = 'error';
        throw error;
      } finally {
        recordStartupLatency(
          Metric.CLI_JSONRPC_INIT_SNAPSHOT_LATENCY,
          snapshotStart,
          { outcome: snapshotOutcome }
        );
      }

      // Register SDK-provided MCP servers (mirrors ACP adapter pattern)
      if (request.params.mcpServers && request.params.mcpServers.length > 0) {
        const mcpService = getMcpService();
        await mcpService.start();
        const filesystemConfigs = mcpService.getUserMcpConfigs();
        const mergedConfigs = mergeJsonRpcMcpConfigs(
          request.params.mcpServers,
          filesystemConfigs
        );
        await mcpService.setMergedMcpConfigs(mergedConfigs);
        await mcpService.stopWatching();
      }

      // Read settings after createSession resolves — it applies initialSettings.
      const settings = this.sessionController.getSettings();
      this.subscribeToAssociatedPermissionRequests(sessionId);

      const responseEmitStart = performance.now();
      let responseEmitOutcome = 'success';
      try {
        this.protocolAdapter.emitResponse(request.id, {
          sessionId,
          hostId: this.sessionController.getSessionHostId(),
          session: { messages: [], ...(title !== undefined && { title }) },
          settings: {
            modelId: settings.modelId,
            reasoningEffort: settings.reasoningEffort,
            autonomyMode: settings.autonomyMode,
            ...(settings.interactionMode !== undefined && {
              interactionMode: settings.interactionMode,
            }),
            ...(settings.autonomyLevel !== undefined && {
              autonomyLevel: settings.autonomyLevel,
            }),
            specModeModelId: settings.specModeModelId ?? undefined,
            specModeReasoningEffort:
              settings.specModeReasoningEffort ?? undefined,
            ...(settings.missionSettings !== undefined && {
              missionSettings: settings.missionSettings,
            }),
            compactionThresholdCheckEnabled:
              settings.compactionThresholdCheckEnabled,
            enabledToolIds: settings.enabledToolIds,
            disabledToolIds: settings.disabledToolIds,
            ...this.getSandboxStatus(),
          },
          availableModels,
          ...(request.params.mcpServers && {
            mcpServers: request.params.mcpServers,
          }),
          ...(callingSessionId && { callingSessionId }),
          ...(callingToolUseId && { callingToolUseId }),
        });
      } catch (error) {
        responseEmitOutcome = 'error';
        throw error;
      } finally {
        recordStartupLatency(
          Metric.CLI_JSONRPC_INIT_RESPONSE_EMIT_LATENCY,
          responseEmitStart,
          { outcome: responseEmitOutcome }
        );
      }

      logInfo('[JsonRpc] Session initialized', { sessionId });
      void this.emitCurrentMcpStatus();
      resolveInit?.();
    } catch (error) {
      initializeOutcome = 'error';
      rejectInit?.(error);
      throw error;
    } finally {
      if (trackingSessionId) {
        // Clear only this init attempt.
        const currentPromise = this.initializingSessions.get(trackingSessionId);
        if (currentPromise && resolveInit) {
          this.initializingSessions.delete(trackingSessionId);
        }
      }
      recordStartupLatency(
        Metric.CLI_JSONRPC_INITIALIZE_SESSION_LATENCY,
        initializeStart,
        { outcome: initializeOutcome }
      );
    }
  }

  private async handleLoadSession(request: LoadSessionRequest): Promise<void> {
    logInfo('[JsonRpc] Handling load_session', {
      droolRequestId: request.id,
      sessionId: request.params.sessionId,
    });

    const { sessionId, mcpOAuthCallbackUri } = request.params;

    // Serialize with any in-flight init for this session.
    const pendingInit = this.initializingSessions.get(sessionId);
    if (pendingInit) {
      try {
        await pendingInit;
      } catch (error) {
        logWarn(
          '[JsonRpc] initialize_session failed before load_session; continuing',
          { sessionId, cause: error }
        );
      }
    }

    // Update MCP OAuth callback URI (may change on reconnect from different frontend)
    if (mcpOAuthCallbackUri) {
      getMcpService().setRemoteCallbackUri(mcpOAuthCallbackUri);
    }

    // Run session loading and model fetching in parallel — they are independent.
    // If getAvailableModelsForResponse fails, fall back to empty models.
    // If loadSession fails, the error propagates regardless.
    const availableModelsPromise = getAvailableModelsForResponse().catch(
      (err) => {
        logWarn(
          '[JsonRpc] Failed to fetch available models during session load, using defaults',
          {
            cause: err,
          }
        );
        return [] as Awaited<ReturnType<typeof getAvailableModelsForResponse>>;
      }
    );

    // Load session via controller (sets up settings sync, changes directory, loads mission state)
    const loadedSessionPromise = this.sessionController.loadSession({
      sessionId,
      loadAllMessages: request.params.loadAllMessages,
      sessionOriginHint: request.params.sessionOriginHint,
    });

    const [availableModels, loadedSession] = await Promise.all([
      availableModelsPromise,
      loadedSessionPromise,
    ]);

    this.applyProtocolToolSelection();

    // Initialize file snapshot tracking for the loaded session so that
    // get_rewind_info / execute_rewind don't crash with
    // "FileSnapshotService not initialized" (FAC-20547).
    const snapshotService = getFileSnapshotService();
    await snapshotService.initialize();
    await snapshotService.startSession(sessionId);

    // Register SDK-provided MCP servers (mirrors ACP adapter pattern)
    if (request.params.mcpServers && request.params.mcpServers.length > 0) {
      const mcpService = getMcpService();
      await mcpService.start();
      const filesystemConfigs = mcpService.getUserMcpConfigs();
      const mergedConfigs = mergeJsonRpcMcpConfigs(
        request.params.mcpServers,
        filesystemConfigs
      );
      await mcpService.setMergedMcpConfigs(mergedConfigs);
      await mcpService.stopWatching();
    }

    // Read settings/cwd after loadSession resolves — it applies settings and chdir.
    const settings = this.sessionController.getSettings();
    const currentCwd = process.cwd();
    this.subscribeToAssociatedPermissionRequests(sessionId);

    // Get pending permissions and ask-user requests for page refresh restoration
    const pendingPermissions = this.protocolAdapter.getPendingPermissions();
    const pendingAskUserRequests =
      this.protocolAdapter.getPendingAskUserRequests();

    // Get queued user messages for page refresh restoration
    const queuedMessages = this.messageQueue.flatMap((item) =>
      item.kind === 'message'
        ? [{ requestId: item.request.id, ...item.request.params }]
        : []
    );

    // Pending elicitation state is rehydrated as Pending and resumed below.
    const messages = loadedSession.messages;

    // Build result object
    const result: LoadSessionResult = {
      session: {
        messages,
        title: loadedSession.title,
      },
      hostId: loadedSession.hostId,
      settings: {
        modelId: settings.modelId,
        reasoningEffort: settings.reasoningEffort,
        autonomyMode: settings.autonomyMode,
        ...(settings.interactionMode !== undefined && {
          interactionMode: settings.interactionMode,
        }),
        ...(settings.autonomyLevel !== undefined && {
          autonomyLevel: settings.autonomyLevel,
        }),
        specModeModelId: settings.specModeModelId ?? undefined,
        specModeReasoningEffort: settings.specModeReasoningEffort ?? undefined,
        ...(settings.missionSettings !== undefined && {
          missionSettings: settings.missionSettings,
        }),
        compactionThresholdCheckEnabled:
          settings.compactionThresholdCheckEnabled,
        enabledToolIds: settings.enabledToolIds,
        disabledToolIds: settings.disabledToolIds,
        ...this.getSandboxStatus(),
      },
      availableModels,
      ...(request.params.mcpServers && {
        mcpServers: request.params.mcpServers,
      }),
      ...(pendingPermissions.length > 0 && { pendingPermissions }),
      ...(pendingAskUserRequests.length > 0 && { pendingAskUserRequests }),
      ...(queuedMessages.length > 0 && { queuedMessages }),
      isAgentLoopInProgress: this.isAgentLoopInProgress,
      cwd: currentCwd,
      ...(loadedSession.callingSessionId && {
        callingSessionId: loadedSession.callingSessionId,
      }),
      ...(loadedSession.callingToolUseId && {
        callingToolUseId: loadedSession.callingToolUseId,
      }),
      tokenUsage: loadedSession.tokenUsage,
      ...(loadedSession.decompSessionType && {
        decompSessionType: loadedSession.decompSessionType,
      }),
      ...(loadedSession.missionSnapshot && {
        mission: loadedSession.missionSnapshot,
      }),
    };

    this.protocolAdapter.emitResponse(request.id, result);

    logInfo('[JsonRpc] Session loaded', { sessionId });
    void this.emitCurrentMcpStatus();

    // Resume pending allow-listed elicitation tools, if any. Push onto the
    // same queue user messages use so we go through one ordered state machine
    // (avoids the prior fire-and-forget + isAgentLoopInProgress race).
    this.messageQueue.push({ kind: 'resume_pending_tools' });
    if (!this.isProcessing) {
      void this.processRequestQueue();
    }
  }

  /**
   * Run resumeAgentWithSession synchronously within processRequestQueue.
   * Mirrors processUserMessage's lifecycle (interrupt latch, working state,
   * isAgentLoopInProgress flag) so subsequent queued user messages cleanly
   * follow once the resume completes.
   */
  private async processResumePendingTools(): Promise<void> {
    const sessionId = this.sessionController.getSessionId() ?? undefined;

    this.interruptAgent = null;
    if (!this.pendingInterrupt) {
      this.wasInterrupted = false;
    }
    await this.awaitMcpLoadIfBlocking();
    this.beginAgentLoop();

    try {
      await resumeAgentWithSession(
        {
          permissionHandler: this.permissionHandler,
          systemPromptOverride: this.getSystemPromptOverride(),
          getIdeClient: () =>
            IdeContextManager.getInstance().getIdeClient() ?? undefined,
          getIdeState: () => this.ideState,
        },
        {
          onInterruptReady: (interruptFn) => {
            this.interruptAgent = interruptFn;

            // Apply pre-start interrupt latch.
            if (this.pendingInterrupt) {
              this.pendingInterrupt = false;
              void interruptFn().catch((error) => {
                logException(
                  error,
                  '[JsonRpc] Pending interrupt handler failed during resume'
                );
              });
            }
          },
          drainAllQueuedUserMessages: () => this.drainQueuedMessages(),
          drainEndOfLoopQueuedUserMessage: () =>
            this.drainEndOfLoopQueuedMessage(),
          getTurnCompletionReason: (defaultReason) =>
            this.getTurnCompletionReason(defaultReason),
        }
      );
    } catch (err) {
      logWarn('[JsonRpc] resume on load_session failed', {
        cause: err,
        sessionId,
      });
    } finally {
      this.finishAgentLoop();
    }
  }

  private async executeUserPromptSubmitHooks(params: {
    prompt: string;
    hasImages: boolean;
  }): Promise<{ prompt: string; hookContext?: string; blocked: boolean }> {
    const sessionService = getSessionService();
    const sessionId = this.sessionController.getSessionId() ?? 'unknown';
    const transcriptPath = sessionService.getSessionTranscriptPath() || '';
    const hookResults = await getHookService().executeHooks({
      eventName: HookEventName.UserPromptSubmit,
      input: {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: process.cwd(),
        permission_mode: getPermissionModeString(
          sessionService.getCurrentAutonomyMode()
        ),
        hook_event_name: HookEventName.UserPromptSubmit,
        prompt: params.prompt,
        has_images: params.hasImages,
      },
    });

    let prompt = params.prompt;
    let hookContext: string | undefined;

    for (const result of hookResults) {
      if (result.exitCode === 2 || result.continue === false) {
        const reason =
          result.stderr ||
          result.stopReason ||
          result.systemMessage ||
          'User prompt submission blocked by hook';
        this.sessionController.setWorkingState(
          DroolWorkingState.StreamingAssistantMessage
        );
        agentEventBus.emit(AgentEvent.AgentError, {
          error: new Error(reason),
          sessionId,
        });
        this.sessionController.setWorkingState(DroolWorkingState.Idle);
        return { prompt, hookContext, blocked: true };
      }

      const updatedPrompt = result.hookSpecificOutput?.updatedInput?.prompt;
      if (typeof updatedPrompt === 'string') {
        prompt = updatedPrompt;
      }

      const additionalContext = result.hookSpecificOutput?.additionalContext;
      if (typeof additionalContext === 'string' && !hookContext) {
        hookContext = additionalContext;
      } else if (
        result.exitCode === 0 &&
        result.stdout.trim() &&
        !hookContext
      ) {
        hookContext = result.stdout.trim();
      }

      if (result.exitCode === 3) {
        const reason =
          result.stderr || 'User prompt submission aborted by hook';
        this.sessionController.setWorkingState(
          DroolWorkingState.StreamingAssistantMessage
        );
        agentEventBus.emit(AgentEvent.AgentError, {
          error: new Error(reason),
          sessionId,
        });
        this.sessionController.setWorkingState(DroolWorkingState.Idle);
        return { prompt, hookContext, blocked: true };
      }
    }

    return { prompt, hookContext, blocked: false };
  }

  private async processUserMessage(
    request: AddUserMessageRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Processing user message');
    this.ensureSessionInitialized();

    const resolvedRequest =
      await this.resolveDeferredUserMessageRequest(request);
    if (!resolvedRequest) {
      const sessionId = this.sessionController.getSessionId();
      if (sessionId) {
        emitAgentTurnCompletedNotification({
          sessionId,
          reason: AgentTurnCompletionReason.Error,
        });
      }
      return;
    }
    const activeRequest = resolvedRequest;

    const {
      text,
      images,
      files,
      outputFormat,
      skipAgentLoop,
      role,
      visibility,
      userMessageSource,
    } = activeRequest.params;

    // When skipAgentLoop is set, persist the message without running the agent.
    // Used by bash mode and daemon-owned notices that should not start a turn.
    if (skipAgentLoop) {
      const sessionService = getSessionService();
      const messageContent = [
        { type: MessageContentBlockType.Text, text } as const,
      ];
      const messageRole = role ?? MessageRole.User;
      const messageVisibility = visibility ?? MessageVisibility.Both;
      const message: IndustryDroolMessage = {
        id: activeRequest.params.messageId ?? generateUUID(),
        role: messageRole,
        content: messageContent,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        visibility: messageVisibility,
        ...(userMessageSource ? { userMessageSource } : {}),
      };
      await sessionService.appendMessage(message, {
        requestId: activeRequest.id,
      });
      // Also add to the in-memory ConversationStateManager so the agent
      // loop sees this message in conversation history on the next turn.
      getConversationStateManager().updateAction({
        type: 'ADD_USER_MESSAGE',
        content: messageContent,
        id: message.id,
        role: messageRole,
        visibility: messageVisibility,
      });
      // Note: the enqueueRequest() caller already sent a success response for
      // this request.id, so we only return here without emitting another one.
      return;
    }

    const promptHookResult = await this.executeUserPromptSubmitHooks({
      prompt: text,
      hasImages: (images?.length ?? 0) > 0,
    });
    if (promptHookResult.blocked) {
      const sessionId = this.sessionController.getSessionId();
      if (sessionId) {
        emitAgentTurnCompletedNotification({
          sessionId,
          reason: AgentTurnCompletionReason.Error,
        });
      }
      return;
    }
    const finalPrompt = promptHookResult.prompt;

    const compressedImages = await this.compressBase64ImagesForLLM(images);

    // Process file attachments
    const sessionId = this.sessionController.getSessionId()!;
    const processedFiles = await this.sessionController.processFileAttachments(
      sessionId,
      files
    );

    // Reset interrupt state for new execution, but preserve a pre-start latch
    // set by interrupt_session while this queued request was being prepared.
    this.interruptAgent = null;
    if (!this.pendingInterrupt) {
      this.wasInterrupted = false;
    }
    await this.awaitMcpLoadIfBlocking();
    this.beginAgentLoop();

    const systemPromptOverride = this.getSystemPromptOverride();

    try {
      // Use shared agent runner
      // Resolve ideClient lazily via getter so it picks up the connection
      // even if the IDE connects after the user message starts processing
      const getIdeClient = () =>
        IdeContextManager.getInstance().getIdeClient() ?? undefined;

      const result = await runAgentWithSession(
        {
          prompt: finalPrompt,
          images: compressedImages,
          files: processedFiles,
          permissionHandler: this.permissionHandler,
          systemPromptOverride,
          requestId: activeRequest.id,
          role,
          visibility,
          outputFormat,
          hookContext: promptHookResult.hookContext,
          userMessageSource,
          getIdeClient,
          getIdeState: () => this.ideState,
        },
        {
          onInterruptReady: (interruptFn) => {
            this.interruptAgent = interruptFn;

            // If an interrupt was requested before the handler was ready, execute it now
            if (this.pendingInterrupt) {
              this.pendingInterrupt = false;
              void interruptFn().catch((error) => {
                logException(
                  error,
                  '[JsonRpc] Pending interrupt handler failed'
                );
              });
            }
          },
          drainAllQueuedUserMessages: () => this.drainQueuedMessages(),
          drainEndOfLoopQueuedUserMessage: () =>
            this.drainEndOfLoopQueuedMessage(),
          getTurnCompletionReason: (defaultReason) =>
            this.getTurnCompletionReason(defaultReason),
        }
      );

      logInfo('[JsonRpc] Message processed', {
        sessionId,
        success: !result.isError,
      });
    } catch (error) {
      logWarn('[JsonRpc] Error during agent execution', { cause: error });
      agentEventBus.emit(AgentEvent.AgentError, { error, sessionId });
    } finally {
      this.finishAgentLoop();
    }

    // Delegated sessions exit after a completed turn unless interrupted for follow-up.
    if (this.shouldExitAfterDelegatedTurn() && !this.wasInterrupted) {
      logInfo('[JsonRpc] Delegated session exiting after completing turn');
      await this.stop();
      await exitWithCode(0);
    }
  }

  private shouldExitAfterDelegatedTurn(): boolean {
    const tags = getSessionService().getCurrentSessionTags() ?? [];
    return (
      isMissionWorkerSession(tags) ||
      tags.some((tag) => tag.name === SESSION_TAG_SUBAGENT)
    );
  }

  private async handleInterruptSession(
    request: InterruptSessionRequest
  ): Promise<void> {
    const sessionId = this.sessionController.getSessionId();

    logInfo('[JsonRpc] Handling interrupt_session', {
      sessionId: sessionId ?? undefined,
      isActive: this.isAgentLoopInProgress,
      isLoading: this.isProcessing,
      messageCount: this.messageQueue.length,
      // eslint-disable-next-line industry/no-nested-log-metadata -- interrupt-handler state flags consumed as a unit
      value: {
        hasInterruptHandler: !!this.interruptAgent,
        pendingInterrupt: this.pendingInterrupt,
      },
    });

    // Cancel pending interactive requests immediately
    this.protocolAdapter.rejectAllPendingPermissions();
    this.protocolAdapter.rejectAllPendingAskUserRequests();

    const tags = getSessionService().getCurrentSessionTags() ?? [];
    const isDelegatedSession =
      isMissionWorkerSession(tags) ||
      tags.some((tag) => tag.name === SESSION_TAG_SUBAGENT);

    const hasActiveExecution =
      this.isAgentLoopInProgress ||
      this.interruptAgent !== null ||
      this.isProcessing ||
      this.messageQueue.length > 0;

    if (!hasActiveExecution) {
      // For non-delegated sessions, pause the mission when interrupted while idle.
      if (!isDelegatedSession && sessionId) {
        const missionSessionId =
          getSessionService().getDecompMissionId() ?? sessionId;
        await pauseMissionRunner(missionSessionId);
      }
      this.sessionController.setWorkingState(DroolWorkingState.Idle);
      // No active execution - return success anyway (idempotent)
      this.protocolAdapter.emitResponse(request.id, {});
      logInfo('[JsonRpc] No active execution to interrupt');

      // Delegated sessions stay alive after interrupt for follow-up messages.
      if (isDelegatedSession) {
        this.wasInterrupted = true;
      }
      return;
    }

    if (this.activeInterruptPromise) {
      await this.activeInterruptPromise;
      this.protocolAdapter.emitResponse(request.id, {});
      logInfo('[JsonRpc] Duplicate interrupt_session joined active interrupt');
      return;
    }

    // Mark active turns as interrupted so their completion reason is Cancelled.
    // Delegated sessions also use this flag to skip post-turn exit.
    this.wasInterrupted = true;

    try {
      const interruptPromise = (async () => {
        if (this.interruptAgent) {
          await this.interruptAgent();
          this.interruptAgent = null;
          this.pendingInterrupt = false;
        } else {
          // Handler not ready yet: only latch interrupts for a turn that is
          // actively preparing/running, not for queue-only drains.
          this.pendingInterrupt =
            this.isProcessing || this.isAgentLoopInProgress;
        }

        // Drain queued user messages and emit notification so the client
        // can restore the text into the chat input.
        this.drainQueueAndNotify();

        await this.activeTurnSettledPromise;
      })();
      this.activeInterruptPromise = interruptPromise;
      await interruptPromise;

      this.protocolAdapter.emitResponse(request.id, {});
      logInfo('[JsonRpc] Session interrupted successfully');
    } catch (error) {
      this.interruptAgent = null;
      if (
        error instanceof ToolAbortError ||
        (error instanceof Error && error.name === 'ToolAbortError')
      ) {
        this.protocolAdapter.emitResponse(request.id, {});
        logInfo('[JsonRpc] Session interrupted successfully after abort');
        return;
      }
      if (isDelegatedSession) {
        this.protocolAdapter.emitResponse(request.id, {});
        logWarn('[JsonRpc] Delegated session interrupt completed with error', {
          cause: error,
        });
        return;
      }
      logException(error, '[JsonRpc] Error interrupting session');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeInterruptPromise = null;
    }
  }

  /**
   * When `blockOnMcpLoad` is set (delegation autorun), wait for MCP servers to
   * finish loading before the first agent turn so MCP tools are present in the
   * turn's tool list. `McpService.start()` is idempotent and returns the
   * in-flight load already kicked off at process startup, so this never
   * re-triggers a reload. Bounded by `getMcpBlockingLoadTimeoutMs()`; on
   * timeout/failure we proceed with whatever tools have registered (later
   * turns still pick up servers as they settle). Runs at most once per process.
   */
  private async awaitMcpLoadIfBlocking(): Promise<void> {
    if (!this.blockOnMcpLoad || this.mcpLoadGateDone) {
      return;
    }
    this.mcpLoadGateDone = true;
    const timeoutMs = getMcpBlockingLoadTimeoutMs();
    logInfo('[JsonRpc] Gating first agent turn on MCP load', {
      timeout: timeoutMs,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        getMcpService().start(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('MCP load timed out')),
            timeoutMs
          );
        }),
      ]);
    } catch (err) {
      logWarn(
        '[JsonRpc] Proceeding without full MCP toolset (MCP load slow or failed)',
        { cause: err }
      );
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private beginAgentLoop(): void {
    this.isAgentLoopInProgress = true;
    this.activeTurnSettledPromise = new Promise<void>((resolve) => {
      this.activeTurnSettledResolve = resolve;
    });
  }

  private finishAgentLoop(): void {
    this.isAgentLoopInProgress = false;
    this.interruptAgent = null;
    this.pendingInterrupt = false;

    const resolve = this.activeTurnSettledResolve;
    this.activeTurnSettledPromise = null;
    this.activeTurnSettledResolve = null;
    resolve?.();
  }

  private async handleCloseSession(
    request: CloseSessionRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling close_session', {
      sessionId: this.sessionController.getSessionId() ?? undefined,
      reason: request.params.reason,
    });

    try {
      await getSessionService().executeSessionEndHooks(
        request.params.reason ?? 'other'
      );
      this.protocolAdapter.emitResponse(request.id, {});
      void Promise.resolve().then(() => this.stop());
    } catch (error) {
      logException(error, '[JsonRpc] Error closing session');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getTurnCompletionReason(
    defaultReason: AgentTurnCompletionReason
  ): AgentTurnCompletionReason {
    if (this.wasInterrupted) {
      return AgentTurnCompletionReason.Cancelled;
    }
    if (this.didReceiveProcessExitSignal) {
      return AgentTurnCompletionReason.ProcessExit;
    }
    return defaultReason;
  }

  /**
   * Handle kill_worker_session RPC - kills a worker session and updates mission state.
   * This runs on the ORCHESTRATOR session (not the worker), so it:
   * - Logs WorkerFailed in the mission progress log
   * - Requeues the feature to Pending
   * - Emits notifications on the orchestrator session (so frontend receives them)
   * - Interrupts both the worker session and the orchestrator's current execution
   */
  private async handleKillWorkerSession(
    request: KillWorkerSessionRequest
  ): Promise<void> {
    const { workerSessionId } = request.params;

    logInfo('[JsonRpc] Handling kill_worker_session', {
      workerSessionId,
    });

    // Need an active execution to interrupt
    if (!this.interruptAgent) {
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: 'No active execution to interrupt',
      });
      return;
    }

    try {
      // Create interrupt callback that will cancel the current execution
      const interruptCallback = async () => {
        if (this.interruptAgent) {
          await this.interruptAgent();
          this.interruptAgent = null;
          this.pendingInterrupt = false;
        }
      };

      // Kill worker session and interrupt orchestrator via SessionController
      await this.sessionController.killWorkerSession(
        workerSessionId,
        interruptCallback
      );

      this.protocolAdapter.emitResponse(request.id, {});
      logInfo('[JsonRpc] Worker session killed successfully', {
        workerSessionId,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Error killing worker session');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleUpdateSessionSettings(
    request: UpdateSessionSettingsRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling update_session_settings');
    this.ensureSessionInitialized();

    const {
      modelId,
      reasoningEffort,
      autonomyMode,
      interactionMode,
      autonomyLevel,
      specModeModelId,
      specModeReasoningEffort,
      missionSettings,
      tags,
      compactionTokenLimit,
      compactionThresholdCheckEnabled,
      enabledToolIds,
      disabledToolIds,
    } = request.params;

    const sessionService = getSessionService();
    const shouldCheckModelNotices =
      interactionMode !== undefined ||
      modelId !== undefined ||
      specModeModelId !== undefined;
    const previousInteractionMode =
      interactionMode !== undefined
        ? sessionService.getInteractionMode()
        : undefined;
    const previousActiveModel = shouldCheckModelNotices
      ? resolveActiveModel(sessionService)
      : undefined;

    // Handle model switch with compaction via SessionController
    if (modelId !== undefined) {
      const currentSettings = this.sessionController.getSettings();
      if (modelId !== currentSettings.modelId) {
        const result = await this.sessionController.switchModel(
          modelId,
          reasoningEffort
        );
        if (!result.success) {
          this.emitError(request.id, {
            code: JsonRpcErrorCode.INTERNAL_ERROR,
            message: result.error || 'Failed to switch model',
          });
          return;
        }
      } else if (reasoningEffort !== undefined) {
        // Same model, just update reasoning effort
        this.sessionController.setReasoningEffort(reasoningEffort);
      }
    } else if (reasoningEffort !== undefined) {
      this.sessionController.setReasoningEffort(reasoningEffort);
    }

    // Apply other settings
    const hasDecoupledAutonomyFields = hasDecoupledInteractionSettings({
      interactionMode,
      autonomyLevel,
    });

    if (interactionMode !== undefined) {
      this.sessionController.setInteractionMode(interactionMode);
    }

    if (autonomyLevel !== undefined) {
      this.sessionController.setAutonomyLevel(autonomyLevel);
    } else if (!hasDecoupledAutonomyFields && autonomyMode !== undefined) {
      this.sessionController.setAutonomyMode(autonomyMode);
    }

    if (specModeModelId !== undefined) {
      if (specModeModelId === null) {
        this.sessionController.clearSpecModeModel();
      } else {
        this.sessionController.setSpecModeModel(
          specModeModelId,
          specModeReasoningEffort ?? undefined
        );
      }
    } else if (specModeReasoningEffort !== undefined) {
      if (specModeReasoningEffort !== null) {
        sessionService.setSpecModeReasoningEffort(specModeReasoningEffort);
      }
    }

    if (shouldCheckModelNotices) {
      const activeModel = resolveActiveModel(sessionService);
      if (
        activeModel !== previousActiveModel ||
        (interactionMode !== undefined &&
          interactionMode !== previousInteractionMode)
      ) {
        const notices = [
          getDeprecatedModelNotice(activeModel),
          getExpensiveModelNotice(activeModel),
        ].filter((notice): notice is { message: string } => notice !== null);
        if (notices.length > 0) {
          const conversationStateManager = getConversationStateManager();
          for (const notice of notices) {
            if (
              !isMessageText(
                conversationStateManager.getLastMessage(),
                notice.message
              )
            ) {
              persistSystem(
                (action) => conversationStateManager.updateAction(action),
                notice.message,
                MessageVisibility.UserOnly
              );
            }
          }
        }
      }
    }

    // Update tags if provided (needed for tool filtering)
    if (tags !== undefined) {
      logInfo('[JsonRpc] Updating session tags for tool filtering', {
        sessionId: this.sessionController.getSessionId() ?? undefined,
        sessionTags: JSON.stringify(tags),
      });
      this.sessionController.setTags(tags);
    } else {
      logInfo('[JsonRpc] No tags provided in updateSessionSettings', {
        sessionId: this.sessionController.getSessionId() ?? undefined,
      });
    }

    if (enabledToolIds !== undefined || disabledToolIds !== undefined) {
      this.sessionController.setToolSelectionOverrides({
        enabledToolIds,
        disabledToolIds,
      });
    }

    if (compactionTokenLimit !== undefined) {
      if (!Number.isFinite(compactionTokenLimit) || compactionTokenLimit <= 0) {
        this.emitError(request.id, {
          code: JsonRpcErrorCode.INVALID_PARAMS,
          message: 'compactionTokenLimit must be a positive number',
        });
        return;
      }
      getSettingsService().setDefaultCompactionTokenLimit(compactionTokenLimit);
    }

    if (compactionThresholdCheckEnabled !== undefined) {
      sessionService.setCompactionThresholdCheckEnabled(
        compactionThresholdCheckEnabled
      );
    }

    if (missionSettings !== undefined) {
      await this.sessionController.updateMissionSettings(missionSettings);
    }

    this.applyProtocolToolSelection({
      skipPermissionsUnsafe: getExecRuntimeConfig().getSkipAllConfirmations(),
    });

    this.protocolAdapter.emitSettingsUpdatedAck(request.id);
    this.protocolAdapter.emitResponse(request.id, {});
    logInfo('[JsonRpc] Settings updated');
  }

  private async handleToggleMcpServer(
    request: ToggleMcpServerRequest
  ): Promise<void> {
    const { serverName, enabled, settingsLevel } = request.params;
    const result = await this.sessionController.toggleMcpServer(
      serverName,
      enabled,
      settingsLevel
    );

    if (result.success) {
      this.protocolAdapter.emitResponse(request.id, { success: true });
    } else {
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: result.error || 'Failed to toggle server',
      });
    }
  }

  private async handleAuthenticateMcpServer(
    request: AuthenticateMcpServerRequest
  ): Promise<void> {
    const result = await this.sessionController.authenticateMcpServer(
      request.params.serverName
    );

    if (result.success) {
      this.protocolAdapter.emitResponse(request.id, { success: true });
    } else {
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: result.error || 'Failed to authenticate',
      });
    }
  }

  private async handleClearMcpAuth(
    request: ClearMcpAuthRequest
  ): Promise<void> {
    const result = await this.sessionController.clearMcpAuth(
      request.params.serverName
    );

    if (result.success) {
      this.protocolAdapter.emitResponse(request.id, { success: true });
    } else {
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message: result.error || 'Failed to clear auth',
      });
    }
  }

  /**
   * Handle drool.add_mcp_server request
   *
   * Adds a new MCP server to the user's configuration.
   */
  private async handleAddMcpServer(
    request: AddMcpServerRequest
  ): Promise<void> {
    const { name, type, url, headers, command, args, env, oauth } =
      request.params;

    logInfo('[JsonRpc] Handling add_mcp_server', {
      name,
      type,
    });

    const mcpService = getMcpService();

    try {
      // Build server config based on type
      let serverConfig;
      if (type !== 'stdio') {
        if (!url) {
          this.emitError(request.id, {
            code: JsonRpcErrorCode.INVALID_PARAMS,
            message: getI18n().t('common:execRunner.urlRequired'),
          });
          return;
        }
        serverConfig = {
          type,
          url,
          headers,
          oauth: normalizeProtocolMcpOAuthConfig(oauth),
          disabled: false,
        };
      } else {
        if (!command) {
          this.emitError(request.id, {
            code: JsonRpcErrorCode.INVALID_PARAMS,
            message: getI18n().t('common:execRunner.commandRequired'),
          });
          return;
        }
        serverConfig = {
          type: 'stdio' as const,
          command,
          args: args || [],
          env,
          disabled: false,
        };
      }

      // Save config first (fast), then respond. The server connection
      // proceeds in the background — the TUI receives McpStatusChanged
      // events when the connection status changes.
      await mcpService.saveServerConfig(name, serverConfig);
      this.protocolAdapter.emitResponse(request.id, { success: true });

      void mcpService.startAddedServer(name).catch((error) => {
        logException(error, '[JsonRpc] Failed to start MCP server', {
          name,
          type,
        });
      });

      logInfo('[JsonRpc] MCP server added', { name, type });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to add MCP server');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to add MCP server',
      });
    }
  }

  /**
   * Handle drool.remove_mcp_server request
   *
   * Removes an MCP server from the user's configuration.
   */
  private async handleRemoveMcpServer(
    request: RemoveMcpServerRequest
  ): Promise<void> {
    const { serverName, settingsLevel } = request.params;

    logInfo('[JsonRpc] Handling remove_mcp_server', {
      name: serverName,
    });

    try {
      const mcpService = getMcpService();
      await mcpService.removeServer(serverName, settingsLevel);

      // Emit success response
      this.protocolAdapter.emitResponse(request.id, { success: true });

      // Emit updated MCP status
      void this.emitCurrentMcpStatus();

      logInfo('[JsonRpc] MCP server removed', {
        name: serverName,
        state: settingsLevel,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to remove MCP server');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to remove MCP server',
      });
    }
  }

  /**
   * Handle drool.list_mcp_registry request
   *
   * Returns the list of available MCP servers from the hardcoded registry.
   */
  private async handleListMcpRegistry(
    request: ListMcpRegistryRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling list_mcp_registry');

    try {
      const registryServers = getRegistryServers();

      // Transform to the schema format
      const servers = registryServers.map((server) => ({
        name: server.name,
        description: server.description,
        type: server.type as 'stdio' | 'http' | 'sse',
        url:
          server.type === 'http' || server.type === 'sse'
            ? server.url
            : undefined,
        command: server.type === 'stdio' ? server.command : undefined,
        args: server.type === 'stdio' ? server.args : undefined,
        note: server.note,
      }));

      // Emit success response
      this.protocolAdapter.emitResponse(request.id, { servers });

      logInfo('[JsonRpc] MCP registry listed', {
        count: servers.length,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to list MCP registry');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to list MCP registry',
      });
    }
  }

  /**
   * Handle drool.list_mcp_tools request
   *
   * Returns all MCP tools across all servers with their enabled/disabled state.
   *
   * Does NOT await `mcpService.start()`: the navigator renders this in
   * parallel with list_mcp_servers, so blocking it would defeat the
   * early-render behavior of list_mcp_servers. We kick start() off in the
   * background and return whatever tools are already known (empty during
   * the very first load). The UI refreshes on each MCP_STATUS_CHANGED
   * notification, so tools populate incrementally as servers come online.
   */
  private async handleListMcpTools(
    request: ListMcpToolsRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling list_mcp_tools');

    try {
      const mcpService = getMcpService();
      void mcpService.start().catch((error) => {
        logException(
          error,
          '[JsonRpc] Background MCP startup failed during list_mcp_tools'
        );
      });

      // Snapshot current tools without awaiting the initial bulk reload.
      // `getAllTools` would otherwise block here until every MCP server
      // finishes connecting (or hits its ~15s timeout); the UI refreshes
      // via MCP_STATUS_CHANGED notifications as servers come online.
      const toolsByServer = await mcpService.getAllToolsSnapshot({
        includeDisabled: true,
      });
      const userConfigs = mcpService.getUserMcpConfigs();

      // Flatten and transform to the schema format
      const tools: Array<{
        serverName: string;
        name: string;
        description?: string;
        isEnabled: boolean;
        isReadOnly?: boolean;
        inputSchema: {
          type: 'object';
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }> = [];

      for (const [serverName, serverTools] of Object.entries(toolsByServer)) {
        const serverConfig = userConfigs[serverName];
        const disabledTools = new Set(serverConfig?.disabledTools ?? []);
        for (const tool of serverTools) {
          tools.push({
            serverName,
            name: tool.name,
            description: tool.description,
            isEnabled: !disabledTools.has(tool.name),
            inputSchema: tool.inputSchema,
          });
        }
      }

      // Emit success response
      this.protocolAdapter.emitResponse(request.id, { tools });

      logInfo('[JsonRpc] MCP tools listed', {
        count: tools.length,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to list MCP tools');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to list MCP tools',
      });
    }
  }

  private async handleListTools(request: ListToolsRequest): Promise<void> {
    logInfo('[JsonRpc] Handling list_tools');

    try {
      const currentSettings = this.sessionController.getSettings();
      const sessionService = getSessionService();
      const selection = this.buildResolvedToolSelection({
        modelId: request.params.modelId ?? currentSettings.modelId,
        autonomyMode:
          request.params.autonomyMode ?? currentSettings.autonomyMode,
        interactionMode:
          request.params.interactionMode ?? currentSettings.interactionMode,
        autonomyLevel:
          request.params.autonomyLevel ?? currentSettings.autonomyLevel,
        specModeModelId:
          request.params.specModeModelId ?? currentSettings.specModeModelId,
        additiveToolIds:
          request.params.enabledToolIds ?? sessionService.getEnabledToolIds(),
        disabledToolIds:
          request.params.disabledToolIds ?? sessionService.getDisabledToolIds(),
        skipPermissionsUnsafe:
          request.params.skipPermissionsUnsafe ??
          getExecRuntimeConfig().getSkipAllConfirmations(),
        depth: request.params.depth,
      });

      this.protocolAdapter.emitResponse(request.id, {
        tools: buildToolCatalogResponse(selection),
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to list tools');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to list tools',
      });
    }
  }

  /**
   * Handle drool.list_mcp_servers request
   *
   * Returns current MCP server statuses (same shape as MCP_STATUS_CHANGED notification).
   * This enables pull-based status recovery after page refresh.
   *
   * Does NOT await `mcpService.start()`: the initial bulk reload can take
   * up to ~15s when a remote server is unresponsive, and blocking the list
   * response makes the MCP navigator appear frozen. Instead we kick off
   * start() in the background and return the current best-effort state
   * (configured servers are shown as Connecting until they come online).
   * The UI keeps up via MCP_STATUS_CHANGED notifications fired from
   * SERVERS_RELOADING / SERVERS_RELOADED.
   */
  private async handleListMcpServers(
    request: ListMcpServersRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling list_mcp_servers');

    try {
      const mcpService = getMcpService();
      void mcpService.start().catch((error) => {
        logException(
          error,
          '[JsonRpc] Background MCP startup failed during list_mcp_servers'
        );
      });
      const notification = await buildMcpStatusNotification(mcpService);

      this.protocolAdapter.emitResponse(request.id, {
        servers: notification.servers,
        summary: notification.summary,
      });

      logInfo('[JsonRpc] MCP servers listed', {
        count: notification.servers.length,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to list MCP servers');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to list MCP servers',
      });
    }
  }

  /**
   * Handle drool.toggle_mcp_tool request
   *
   * Enables or disables a specific MCP tool.
   */
  private async handleToggleMcpTool(
    request: ToggleMcpToolRequest
  ): Promise<void> {
    const { serverName, toolName, enabled } = request.params;

    logInfo('[JsonRpc] Handling toggle_mcp_tool', {
      name: serverName,
      toolName,
      isEnabled: enabled,
    });

    try {
      const mcpService = getMcpService();
      await mcpService.toggleTool(serverName, toolName, enabled);

      // Emit success response
      this.protocolAdapter.emitResponse(request.id, { success: true });

      logInfo('[JsonRpc] MCP tool toggled', {
        name: serverName,
        toolName,
        isEnabled: enabled,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to toggle MCP tool');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to toggle MCP tool',
      });
    }
  }

  /**
   * Handle drool.cancel_mcp_auth request
   *
   * Cancels an in-progress MCP OAuth authentication flow.
   */
  private async handleCancelMcpAuth(
    request: CancelMcpAuthRequest
  ): Promise<void> {
    const { serverName } = request.params;

    logInfo('[JsonRpc] Handling cancel_mcp_auth', {
      name: serverName,
    });

    try {
      const result = await this.sessionController.cancelMcpAuth(serverName);

      if (result.success) {
        this.protocolAdapter.emitResponse(request.id, { success: true });
        void this.emitCurrentMcpStatus();
      } else {
        this.emitError(request.id, {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: result.error || 'Failed to cancel auth',
        });
      }
    } catch (error) {
      logException(error, '[JsonRpc] Failed to cancel MCP auth');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to cancel MCP auth',
      });
    }
  }

  /**
   * Handle drool.submit_mcp_auth_code request
   *
   * Submits an OAuth authorization code for a remote session.
   * The frontend relays the code from the user's browser callback
   * through the daemon to this handler.
   */
  private handleSubmitMcpAuthCode(request: SubmitMcpAuthCodeRequest): void {
    const { serverName, code, state } = request.params;

    logInfo('[JsonRpc] Handling submit_mcp_auth_code', {
      name: serverName,
      hasState: Boolean(state),
    });

    try {
      const mcpService = getMcpService();
      const resolved = mcpService.submitAuthCode({ serverName, code, state });

      this.protocolAdapter.emitResponse(request.id, { success: resolved });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to submit MCP auth code');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to submit MCP auth code',
      });
    }
  }

  private handleSubmitMcpAuthError(request: SubmitMcpAuthErrorRequest): void {
    const {
      serverName,
      error: providerError,
      errorDescription,
      state,
    } = request.params;

    try {
      const mcpService = getMcpService();
      const resolved = mcpService.submitAuthError({
        serverName,
        error: providerError,
        errorDescription,
        state,
      });

      this.protocolAdapter.emitResponse(request.id, { success: resolved });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to submit MCP auth error');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to submit MCP auth error',
      });
    }
  }

  /**
   * Handle drool.list_skills request
   *
   * Returns all available skills (builtin + filesystem).
   */
  private async handleListSkills(request: ListSkillsRequest): Promise<void> {
    logInfo('[JsonRpc] Handling list_skills');

    try {
      const { getAllSkills } = await import('@/skills/builtin');
      const allSkills = await getAllSkills();

      // Map skills to the response format, including resources
      const skills = await Promise.all(
        allSkills.map(async (skill) => {
          // Get resources (files in skill folder except SKILL.md)
          const resources = await getSkillResources(skill.filePath);

          return {
            name: skill.metadata.name,
            description: skill.metadata.description,
            location: skill.location,
            filePath: skill.filePath,
            enabled: skill.metadata.enabled,
            userInvocable: skill.metadata.userInvocable,
            version: skill.metadata.version,
            content: skill.systemPrompt,
            resources,
          };
        })
      );

      this.protocolAdapter.emitResponse(request.id, { skills });
      logInfo('[JsonRpc] Skills listed', { count: skills.length });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to list skills');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to list skills',
      });
    }
  }

  /**
   * Handle drool.list_commands request
   *
   * Returns all custom slash commands (user + project scope). Resolution of a
   * selected command happens on the normal add_user_message path, which turns
   * `/name args` into the command's resolved prompt.
   */
  private async handleListCommands(
    request: ListCommandsRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling list_commands');

    try {
      const { customCommandsLoader } = await import(
        '@/commands/custom/CustomCommandsLoader'
      );
      const customCommands = await customCommandsLoader.getCommands();

      const commands = customCommands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
        isExecutable: command.isExecutable,
      }));

      this.protocolAdapter.emitResponse(request.id, { commands });
      logInfo('[JsonRpc] Commands listed', { count: commands.length });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to list commands');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to list commands',
      });
    }
  }

  private async handleGetContextStats(
    request: GetContextStatsRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling get_context_stats');
    this.ensureSessionInitialized();

    try {
      const contextStats = await getContextStats();
      this.protocolAdapter.emitResponse(request.id, contextStats);
    } catch (error) {
      logException(error, '[JsonRpc] Failed to get context stats');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to get context stats',
      });
    }
  }

  private async handleGetContextBreakdown(
    request: GetContextBreakdownRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling get_context_breakdown');
    this.ensureSessionInitialized();

    try {
      const { buildContextBreakdown } = await import(
        '@/services/contextBreakdown'
      );
      const breakdown = await buildContextBreakdown();
      this.protocolAdapter.emitResponse(request.id, breakdown);
    } catch (error) {
      logException(error, '[JsonRpc] Failed to get context breakdown');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to get context breakdown',
      });
    }
  }

  /**
   * Handle drool.submit_bug_report request
   *
   * Creates and uploads a bug report with session data and logs.
   */
  private async handleSubmitBugReport(
    request: SubmitBugReportRequest
  ): Promise<void> {
    const { userComment, clientLogs } = request.params;

    logInfo('[JsonRpc] Handling submit_bug_report');

    try {
      const { submitBugReport } = await import(
        '@/commands/bug/submitBugReport'
      );
      const result = await submitBugReport(userComment, clientLogs);

      this.protocolAdapter.emitResponse(request.id, {
        bugReportId: result.bugReportId,
      });
      logInfo('[JsonRpc] Bug report submitted', {
        bugReportId: result.bugReportId,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to submit bug report');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof AuthenticationError
            ? getAuthErrorMessage()
            : error instanceof Error
              ? error.message
              : 'Failed to submit bug report',
      });
    }
  }

  private async handleGetRewindInfo(
    request: GetRewindInfoRequest
  ): Promise<void> {
    const { messageId } = request.params;
    logInfo('[JsonRpc] Handling get_rewind_info', { messageId });
    this.ensureSessionInitialized();

    try {
      const snapshotService = getFileSnapshotService();
      const sessionId = this.sessionController.getSessionId()!;
      const snapshotInfo = await snapshotService.getSnapshotsAfterBoundary(
        sessionId,
        messageId
      );

      this.protocolAdapter.emitResponse(request.id, {
        availableFiles: snapshotInfo.availableFiles.map((f) => ({
          filePath: f.filePath,
          contentHash: f.contentHash,
          size: f.size,
        })),
        createdFiles: snapshotInfo.createdFiles.map((f) => ({
          filePath: f.filePath,
        })),
        evictedFiles: snapshotInfo.evictedFiles.map((f) => ({
          filePath: f.filePath,
          reason: f.reason,
        })),
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to get rewind info');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to get rewind info',
      });
    }
  }

  private async handleExecuteRewind(
    request: ExecuteRewindRequest
  ): Promise<void> {
    const { messageId, filesToRestore, filesToDelete, forkTitle } =
      request.params;
    logInfo('[JsonRpc] Handling execute_rewind', { messageId });
    this.ensureSessionInitialized();

    try {
      const snapshotService = getFileSnapshotService();
      let restoredCount = 0;
      let deletedCount = 0;
      let failedRestoreCount = 0;
      let failedDeleteCount = 0;

      if (filesToRestore.length > 0) {
        const restoreResult = await snapshotService.restoreFiles(
          filesToRestore.map((f) => ({
            filePath: f.filePath,
            contentHash: f.contentHash,
            size: f.size,
            capturedAt: 0,
          }))
        );
        restoredCount = restoreResult.restored.length;
        failedRestoreCount = restoreResult.failed.length;
      }

      if (filesToDelete.length > 0) {
        const deleteResult = await snapshotService.deleteCreatedFiles(
          filesToDelete.map((f) => ({
            filePath: f.filePath,
            createdAt: 0,
          }))
        );
        deletedCount = deleteResult.deleted.length;
        failedDeleteCount = deleteResult.failed.length;
      }

      const sessionService = getSessionService();
      const currentSessionId = sessionService.getCurrentSessionId()!;

      const newSessionId = await sessionService.forkSession(
        currentSessionId,
        messageId,
        forkTitle,
        currentSessionId,
        'rewind'
      );

      this.protocolAdapter.emitResponse(request.id, {
        newSessionId,
        restoredCount,
        deletedCount,
        failedRestoreCount,
        failedDeleteCount,
      });

      logInfo('[JsonRpc] Rewind executed', {
        newSessionId,
        count: restoredCount,
        deletedCount,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to execute rewind');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to execute rewind',
      });
    }
  }

  private async handleCompactSession(
    request: CompactSessionRequest
  ): Promise<void> {
    const { customInstructions } = request.params;
    logInfo('[JsonRpc] Handling compact_session', {
      hasState: !!customInstructions,
    });
    this.ensureSessionInitialized();

    try {
      const sessionService = getSessionService();
      const sessionId = this.sessionController.getSessionId()!;

      const session = await sessionService.loadSession(sessionId);
      const messages = session.messages;
      if (messages.length === 0) {
        this.emitError(request.id, {
          code: JsonRpcErrorCode.INVALID_PARAMS,
          message: 'Nothing to compact — the conversation is empty.',
        });
        return;
      }

      const { compactToNewSession } = await import('@/hooks/compaction/flows');
      const { createSummarizer } = await import(
        '@/hooks/compaction/Summarizer'
      );
      const { getSystemInfo: getCompactionSystemInfo } = await import(
        '@/utils/systemInfo'
      );

      const summarize = createSummarizer();
      const systemInfo = await getCompactionSystemInfo().catch(() => undefined);

      const compactionResult = await compactToNewSession({
        sessionId,
        messages,
        summarize,
        systemInfo,
        customInstructions,
      });

      if (!compactionResult) {
        this.emitError(request.id, {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: 'Failed to generate summary for compaction.',
        });
        return;
      }

      this.protocolAdapter.emitResponse(request.id, {
        newSessionId: compactionResult.newSessionId,
        removedCount: compactionResult.removedCount,
      });

      logInfo('[JsonRpc] Session compacted', {
        oldSessionId: sessionId,
        newSessionId: compactionResult.newSessionId,
        deletedCount: compactionResult.removedCount,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to compact session');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to compact session',
      });
    }
  }

  private async handleForkSession(request: ForkSessionRequest): Promise<void> {
    logInfo('[JsonRpc] Handling fork_session');
    this.ensureSessionInitialized();

    try {
      const sessionService = getSessionService();
      const currentSessionId = sessionService.getCurrentSessionId()!;

      const requestTitle = request.params?.title;
      const requestTags = request.params?.tags;

      let forkTitle: string;
      if (requestTitle) {
        forkTitle = requestTitle;
      } else {
        const originalTitle = sessionService.getSessionTitle(currentSessionId);
        const baseTitle =
          originalTitle && originalTitle.trim().length > 0
            ? originalTitle.trim()
            : getI18n().t('common:appMessages.sessionFallback');
        forkTitle = getI18n().t('common:appMessages.forkPrefix', {
          title: baseTitle,
        });
      }

      const hasTags = requestTags && requestTags.length > 0;
      const isBtwFork =
        hasTags && requestTags.some((t) => t.name === SESSION_TAG_BTW_FORK);
      const newSessionId = await sessionService.forkSession(
        currentSessionId,
        null,
        forkTitle,
        currentSessionId,
        isBtwFork ? 'btw' : 'fork',
        hasTags
          ? {
              extraTags: requestTags,
              skipRemoteCreation: isBtwFork,
              preserveCurrentSession: isBtwFork,
              useBtwDirectory: isBtwFork,
            }
          : undefined
      );

      this.protocolAdapter.emitResponse(request.id, {
        newSessionId,
      });

      logInfo('[JsonRpc] Session forked', {
        oldSessionId: currentSessionId,
        newSessionId,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to fork session');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to fork session',
      });
    }
  }

  private async handleRenameSession(
    request: RenameSessionRequest
  ): Promise<void> {
    logInfo('[JsonRpc] Handling rename_session');
    this.ensureSessionInitialized();

    try {
      const sessionService = getSessionService();
      const sessionId = sessionService.getCurrentSessionId()!;

      await sessionService.updateSessionTitle(sessionId, request.params.title, {
        manual: true,
      });

      const persistedTitle = sessionService.getSessionTitleText(sessionId);
      if (persistedTitle == null) {
        throw new MetaError('Session title update did not persist');
      }

      agentEventBus.emit(AgentEvent.SessionTitleUpdated, {
        sessionId,
        title: persistedTitle,
        updateType: SessionTitleUpdateType.ManualRename,
        requestId: request.id,
      });

      this.protocolAdapter.emitResponse(request.id, {
        success: true,
      });

      logInfo('[JsonRpc] Session renamed', {
        sessionId,
        length: persistedTitle.length,
      });
    } catch (error) {
      logException(error, '[JsonRpc] Failed to rename session');
      this.emitError(request.id, {
        code: JsonRpcErrorCode.INTERNAL_ERROR,
        message:
          error instanceof Error ? error.message : 'Failed to rename session',
      });
    }
  }

  private async handleWarmupCache(request: WarmupCacheRequest): Promise<void> {
    logInfo('[JsonRpc] Ignoring deprecated warmup_cache');
    this.ensureSessionInitialized();

    this.protocolAdapter.emitResponse(request.id, {});
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private getSystemPromptOverride(): string | undefined {
    const sessionService = getSessionService();
    const sessionTags = sessionService.getCurrentSessionTags();
    const squadSession = isSquadSession(sessionTags);
    const decompSessionType = getDecompSessionTypeFromTags(sessionTags);
    const missionId =
      decompSessionType === DecompSessionType.Worker
        ? sessionService.getDecompMissionId()
        : undefined;
    const missionFileService = missionId
      ? getMissionFileService(missionId)
      : null;
    const missionDir = missionFileService?.getMissionDir();
    const workerSessionId =
      decompSessionType === DecompSessionType.Worker
        ? (this.sessionController.getSessionId() ?? undefined)
        : undefined;
    const feature = workerSessionId
      ? (missionFileService?.getFeatureForWorkerSessionSync(workerSessionId) ??
        undefined)
      : undefined;
    let override: string | undefined =
      this.systemPromptOverride ??
      (decompSessionType === DecompSessionType.Orchestrator
        ? `${SYSTEM_PROMPT}\n\n${
            squadSession
              ? getSquadOrchestratorSystemPrompt()
              : getOrchestratorSystemPrompt()
          }`
        : decompSessionType === DecompSessionType.Worker
          ? `${EXEC_SYSTEM_PROMPT}\n\n${
              squadSession
                ? getSquadWorkerSystemPrompt()
                : getWorkerSystemPrompt(missionDir, feature)
            }`
          : undefined);

    const appendText = getExecRuntimeConfig().getAppendSystemPrompt();
    if (appendText) {
      override = override
        ? `${override}\n\n${appendText}`
        : `${SYSTEM_PROMPT}\n\n${appendText}`;
    }

    return override;
  }

  private ensureSessionInitialized(): void {
    if (!this.sessionController.getSessionId()) {
      throw new MetaError(getI18n().t('common:execRunner.noActiveSession'));
    }
  }

  private getSandboxStatus(): { sandbox?: SandboxStatus } {
    const status = getSandboxService().getStatus();
    if (!status.enabled) return {};
    return { sandbox: status };
  }

  private emitError(requestId: string | null, error: JsonRpcError): void {
    const response: JsonRpcBaseResponseFailure = {
      jsonrpc: JSONRPC_VERSION,
      type: 'response',
      industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
      industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
      id: requestId,
      error,
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  private setupInputHandlers(resolve: () => void): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on('line', (line) => {
      this.processJsonRpcMessage(line);
    });

    this.rl.on('close', async () => {
      await this.shutdown();
      resolve();
    });
  }

  private setupSignalHandlers(resolve: () => void): void {
    this.signalHandler = async (signal: NodeJS.Signals) => {
      logInfo('[JsonRpc] Shutdown signal received', { signal });
      this.didReceiveProcessExitSignal = true;
      // Surface a clean shutdown notice so the client can distinguish a
      // graceful teardown from an abrupt worker disconnect.
      agentEventBus.emit(AgentEvent.WorkingStateChanged, {
        state: DroolWorkingState.Idle,
        sessionId: this.sessionController.getSessionId() ?? '',
      });
      this.removeSignalHandlers();
      this.rl?.close();
      resolve();
    };
    process.on('SIGINT', this.signalHandler);
    process.on('SIGTERM', this.signalHandler);
    process.on('SIGHUP', this.signalHandler);
  }

  private removeSignalHandlers(): void {
    if (this.signalHandler) {
      process.removeListener('SIGINT', this.signalHandler);
      process.removeListener('SIGTERM', this.signalHandler);
      process.removeListener('SIGHUP', this.signalHandler);
      this.signalHandler = undefined;
    }
  }

  private processJsonRpcMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.emitError(null, {
        code: JsonRpcErrorCode.PARSE_ERROR,
        message: 'Invalid JSON',
      });
      return;
    }

    const baseResult = JsonRpcMessageSchema.safeParse(parsed);
    if (!baseResult.success) {
      this.emitError(null, {
        code: JsonRpcErrorCode.PARSE_ERROR,
        message: 'Invalid JSON-RPC message',
      });
      return;
    }

    const { type } = baseResult.data;

    if (type === 'response') {
      const responseResult = JsonRpcBaseResponseSchema.safeParse(parsed);
      if (!responseResult.success) return;

      this.protocolAdapter.tryHandleToolingResponse(responseResult.data);
      return;
    }

    if (type === 'request') {
      const requestResult = ClientRequestSchema.safeParse(parsed);
      if (!requestResult.success) {
        this.emitError(null, {
          code: JsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid request format',
        });
        return;
      }
      this.routeRequest(requestResult.data);
    }
  }

  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    logInfo('[JsonRpc] Shutting down', {
      bufferLength: this.messageQueue.length,
      pendingRequestCount: this.pendingRequestCount,
      isLoading: this.isProcessing,
    });

    // Wait for message queue to drain and pending requests to complete
    const startTime = Date.now();
    const SHUTDOWN_TIMEOUT_MS = 30000;

    while (
      (this.messageQueue.length > 0 ||
        this.isProcessing ||
        this.pendingRequestCount > 0) &&
      Date.now() - startTime < SHUTDOWN_TIMEOUT_MS
    ) {
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((r) => setTimeout(r, 100));
    }

    if (Date.now() - startTime >= SHUTDOWN_TIMEOUT_MS) {
      logWarn('[JsonRpc] Shutdown timeout - forcing exit', {
        bufferLength: this.messageQueue.length,
        pendingRequestCount: this.pendingRequestCount,
        isLoading: this.isProcessing,
      });
      const sessionId = this.sessionController.getSessionId();
      if (this.isAgentLoopInProgress && sessionId) {
        emitAgentTurnCompletedNotification({
          sessionId,
          reason: this.getTurnCompletionReason(AgentTurnCompletionReason.Error),
        });
      }
    }

    await this.stop();
  }
}
