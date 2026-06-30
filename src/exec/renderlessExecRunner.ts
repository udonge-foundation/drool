import { DroolMode } from '@industry/common/shared';
import { ToolConfirmationOutcome } from '@industry/drool-sdk-ext/protocol/drool';
import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import {
  AutonomyMode,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logWarn } from '@industry/logging';
import { getFreshTokenWithSource, verifyToken } from '@industry/runtime/auth';
import { fetchFeatureFlags } from '@industry/runtime/feature-flags';

import type { ToolExecutionContext } from '@/agent/types';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import { AgentLoop } from '@/core/AgentLoop';
import { getRuntimeAuthConfig } from '@/environment';
import { convertBase64ImagesToAttachments } from '@/exec/imageAttachments';
import type {
  ExecEventCallbacks,
  ExecOptions,
  ExecRunnerProps,
  ExecRunResult,
} from '@/exec/types';
import { MessageRole, MessageType } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { getI18n } from '@/i18n';
import {
  getConversationStateManager,
  ConversationStateManager,
} from '@/services/ConversationStateManager';
import { isDelegatedAutoRejectSession } from '@/services/delegatedSession/detection';
import { maybeAutoRejectDelegatedPermission } from '@/services/delegatedSession/permissionGate';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { getMcpService } from '@/services/mcp/McpService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import type { DroolMessageEvent } from '@/services/types';
import type { ImageAttachment } from '@/types/types';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { generateUUID } from '@/utils/uuid';

import type { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

function extractAssistantFinalText(events: DroolMessageEvent[]): string {
  const texts: string[] = [];
  for (const e of events) {
    if (e.message.role !== 'assistant') continue;
    const c = e.message.content as unknown;
    if (typeof c === 'string') {
      const t = c.trim();
      if (t) texts.push(t);
      continue;
    }
    if (Array.isArray(c)) {
      for (const block of c as Array<{ type?: string; text?: string }>) {
        if (block?.type === 'text' && block.text) {
          const t = block.text.trim();
          if (t) texts.push(t);
        }
      }
    }
  }
  return texts.length ? texts[texts.length - 1] : '';
}

function countAssistantTurns(events: DroolMessageEvent[]): number {
  return events.filter((e) => e.message.role === 'assistant').length;
}

export function didEndEarlyDueToPermissions(
  events: DroolMessageEvent[]
): boolean {
  const pattern = /exec ended early: insufficient permission/i;

  const extractTextBlocks = (content: unknown): string[] => {
    if (typeof content === 'string') return [content.trim()].filter(Boolean);
    if (Array.isArray(content)) {
      return (content as Array<{ type?: string; text?: string }>)
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => (b!.text as string).trim())
        .filter(Boolean);
    }
    return [];
  };

  for (const e of events) {
    if (e.message.role !== 'assistant') continue;
    const texts = extractTextBlocks(e.message.content as unknown);
    if (texts.some((t) => pattern.test(t))) return true;
  }
  return false;
}

/**
 * Helper to create an addMessage function compatible with AgentLoopParams
 * using the ConversationStateManager directly.
 */
function createAddMessage(manager: ConversationStateManager): (
  role: MessageRole,
  content: string,
  options?: {
    messageType?: MessageType;
    visibility?: MessageVisibility;
    toolCallStatus?: import('@/hooks/enums').ToolCallStatus;
    toolCallId?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    startTime?: number;
    images?: ImageAttachment[];
  }
) => HistoryMessage {
  return (role, content, options) => {
    const id = generateUUID();
    const newMessage: HistoryMessage = {
      id,
      role,
      content,
      ...options,
    };
    manager.updateAction({
      type: 'ADD_MESSAGE',
      id,
      role,
      content,
      options,
    });
    return newMessage;
  };
}

/**
 * For delegated sessions (today: subagents spawned by the Task tool),
 * install a `requestPermissionFn` that auto-rejects permission-gated
 * tool calls and injects a `<system-reminder>` telling the session to
 * try a different approach. Without this, these sessions would hit the
 * non-interactive "immediate exit" branch in ToolExecutor and crash
 * the whole exec process (exit 1) as soon as any tool needs approval.
 *
 * Mirrors how mission workers are handled in sharedAgentRunner.ts — one
 * delegated-session gate, two callers that each decide whether their
 * session should auto-reject via the shared
 * `isDelegatedAutoRejectSession` predicate.
 *
 * For non-delegated sessions, leave `toolExecutionContext` untouched so
 * direct `drool exec` callers still get the existing "Re-run with
 * --skip-permissions-unsafe" error message, which is the right UX for
 * a human operator.
 */
function buildDelegatedAwareToolExecutionContext(
  toolExecutionContext: ExecRunnerProps['toolExecutionContext']
): ExecRunnerProps['toolExecutionContext'] {
  if (!isDelegatedAutoRejectSession()) {
    return toolExecutionContext;
  }
  const manager = getConversationStateManager();
  const requestPermissionFn: NonNullable<
    ToolExecutionContext['requestPermissionFn']
  > = async (batch) =>
    maybeAutoRejectDelegatedPermission(batch, {
      shouldAutoReject: isDelegatedAutoRejectSession,
      updateAction: (action) => manager.updateAction(action),
    }) ?? {
      outcome: ToolConfirmationOutcome.Cancel,
      approvedToolIds: [],
    };

  return {
    ...(toolExecutionContext ?? {}),
    requestPermissionFn,
  };
}

/**
 * Run the exec agent imperatively using AgentLoop directly (no React/Ink).
 */
async function runExecAgent({
  prompt,
  images,
  files,
  messageId,
  requestId,
  onExit,
  execEventCallbacks,
  toolExecutionContext,
  systemPromptOverride,
  drainAllQueuedUserMessages,
  drainEndOfLoopQueuedUserMessage,
}: ExecRunnerProps): Promise<void> {
  const manager = getConversationStateManager();
  const addMessage = createAddMessage(manager);

  const effectiveToolExecutionContext =
    buildDelegatedAwareToolExecutionContext(toolExecutionContext);

  const agentLoop = new AgentLoop({
    addMessage,
    updateAction: (actions) => manager.updateAction(actions),
    getConversationHistory: () => manager.getConversationHistory(),
    getRawConversationHistory: () => manager.getAllMessages(),
    isConversationEmpty: () => manager.isConversationEmpty(),
    messages: [],
    toolExecutionContext: effectiveToolExecutionContext,
    startAssistantMessage: (id?) => manager.startAssistantMessage(id),
    appendAssistantText: (blockIndex, textChunk) =>
      manager.appendAssistantText(blockIndex, textChunk),
    addToolCall: (id, name, input, thoughtSignature?) =>
      manager.addToolCall(id, name, input, thoughtSignature),
    updateToolCallInput: (id, partialInput) =>
      manager.updateToolCallInput(id, partialInput),
    updateThinkingBlock: (thinkingContent, thinkingSignature?) =>
      manager.updateThinkingBlock(thinkingContent, thinkingSignature),
    appendThinkingDelta: (blockIndex, delta) =>
      manager.appendThinkingDelta(blockIndex, delta),
    markThinkingComplete: (blockIndex, durationMs) =>
      manager.markThinkingComplete(blockIndex, durationMs),
    markTextComplete: (blockIndex) => manager.markTextComplete(blockIndex),
    finalizeAssistantMessage: (openaiMessageId?, openaiPhase?) =>
      manager.finalizeAssistantMessage(openaiMessageId, openaiPhase),
    discardInFlightAssistantMessage: () =>
      manager.discardInFlightAssistantMessage(),
    finalizeContentBlocks: (contentBlocks) =>
      manager.finalizeContentBlocks(contentBlocks),
    addReasoningBlock: (encryptedContent?, openaiReasoningId?, summary?) =>
      manager.addReasoningBlock(encryptedContent, openaiReasoningId, summary),
    addChatCompletionReasoning: (field, content) =>
      manager.addChatCompletionReasoning(field, content),
    clearUnfinishedToolCallInvocations: () =>
      manager.clearUnfinishedToolCallInvocations(),
    updateToolResult: (toolId, content) =>
      manager.updateToolResult(toolId, content),
    setToolError: (toolId, error) => manager.setToolError(toolId, error),
    updateToolStatus: (toolId, status) =>
      manager.updateToolStatus(toolId, status),
    loadConversationHistory: (msgs) => manager.loadConversationHistory(msgs),
    getPendingToolIds: () => manager.getPendingToolIds(),
    getLastToolMessageId: () => manager.getLastToolMessageId(),
    getToolExecutions: () => manager.getToolExecutions(),
    setUiRenderCutoff: (cutoffMessageId) =>
      manager.setUiRenderCutoff(cutoffMessageId),
    drainAllQueuedUserMessages,
    drainEndOfLoopQueuedUserMessage,
    systemPromptOverride,
  });

  let runError: unknown;
  try {
    const runPromise = agentLoop.runAgentWithUserMessage({
      message: prompt,
      images: convertBase64ImagesToAttachments(images),
      files,
      messageId,
      requestId,
    });

    if (execEventCallbacks?.onNewInterruptFunctionReady) {
      execEventCallbacks.onNewInterruptFunctionReady(
        agentLoop.stopAgent.bind(agentLoop)
      );
    }

    await runPromise;
  } catch (err) {
    runError = err;
  } finally {
    agentLoop.dispose();

    const sessionService = getSessionService();
    const sessionId =
      sessionService.getCurrentSessionId() ||
      (await sessionService.createNewSession({ firstUserMessage: prompt }));
    const events = await sessionService.getAllMessageEvents(sessionId);
    const finalText = extractAssistantFinalText(events);
    const numTurns = countAssistantTurns(events);
    const earlyExit = didEndEarlyDueToPermissions(events);
    const isError = !!runError || earlyExit || !!agentLoop.state.error;
    onExit({ finalText, numTurns, isError, sessionId });
  }
}

/**
 * Decide whether to apply the caller-supplied autonomy mode to the session
 * started by `runRenderlessExec`.
 *
 * Preserve spec mode only when the caller explicitly asked for it via
 * `--use-spec` / `--spec-model` on this invocation. Otherwise, always apply
 * the caller-supplied autonomy mode, even if the freshly-created session
 * inherited `interactionMode=Spec` from the user's global session defaults.
 *
 * Before this predicate was tightened, any subagent spawned via the Task
 * tool (which passes `--auto high` via task-cli.ts) would silently stay in
 * spec mode when the user's default `sessionDefaultSettings.interactionMode`
 * was Spec. That left the subagent with `autonomyLevel=Off` and
 * `interactionMode=Spec`, so every Edit/Create/Execute tool call required
 * confirmation and was then auto-rejected by the delegated-session
 * permission gate, blocking the subagent from making progress.
 */
export function shouldApplyExecAutonomyMode(opts: {
  useSpec?: boolean;
  specModelId?: string;
}): boolean {
  return !(opts.useSpec || opts.specModelId);
}

export function requiresIndustryAuthForExecModel(
  modelId: string | null | undefined
): boolean {
  return !modelId?.startsWith('custom:');
}

export async function runRenderlessExec(params: {
  sessionId: string;
  prompt: string;
  images?: ExecRunnerProps['images'];
  opts: ExecOptions;
  toolExecutionContext?: Partial<ToolExecutionContext>;
  execEventCallbacks?: ExecEventCallbacks;
  systemPromptOverride?: string;
}): Promise<ExecRunResult> {
  const {
    sessionId,
    prompt,
    images,
    execEventCallbacks,
    opts: {
      modelId,
      reasoningEffort,
      specModelId,
      specReasoningEffort,
      useSpec,
      autoLevel,
      autonomyMode,
    },
    toolExecutionContext,
    systemPromptOverride,
  } = params;

  // Validate that at least one of autonomyMode or autoLevel is provided
  if (!autonomyMode && !autoLevel) {
    return {
      finalText:
        'Error: Either autonomyMode or autoLevel must be specified in ExecOptions. ' +
        'Example: { autonomyMode: AutonomyMode.AutoMedium } or { autoLevel: "medium" }',
      numTurns: 0,
      isError: true,
      sessionId,
    };
  }
  // Prefer autonomyMode over autoLevel (autoLevel is deprecated but still supported)
  // Map AutonomyLevel values ('low', 'medium', 'high') to AutonomyMode values ('auto-low', 'auto-medium', 'auto-high')
  let effectiveAutonomyMode: AutonomyMode;
  if (autonomyMode) {
    effectiveAutonomyMode = autonomyMode;
  } else if (autoLevel === 'low') {
    effectiveAutonomyMode = AutonomyMode.AutoLow;
  } else if (autoLevel === 'medium') {
    effectiveAutonomyMode = AutonomyMode.AutoMedium;
  } else if (autoLevel === 'high') {
    effectiveAutonomyMode = AutonomyMode.AutoHigh;
  } else {
    // Fallback to AutoLow if autoLevel has an invalid value
    effectiveAutonomyMode = AutonomyMode.AutoLow;
  }

  // Set Drool mode to Exec
  getDroolRuntimeService().setDroolMode(DroolMode.NonInteractiveCLI);

  CliTelemetryClient.getInstance().setDroolMode(DroolMode.NonInteractiveCLI);

  try {
    await getMcpService().start();
  } catch (err) {
    // Surface startup errors to stderr but continue
    // eslint-disable-next-line no-console
    console.error('[exec] MCP start failed:', err);
  }

  // Store the target autonomy level in environment for retrieval later
  process.env.INDUSTRY_EXEC_TARGET_AUTONOMY = effectiveAutonomyMode;

  // Enable spec mode if requested or if spec model is provided
  // This must come after main model is set but before spec model is set
  // Use setInteractionMode to preserve the autonomy level
  if (useSpec || specModelId) {
    getSessionService().setInteractionMode(DroolInteractionMode.Spec);
  }

  // Check both the CLI --model flag and the effective session model (for
  // resumed sessions where --model is not re-specified). Custom/BYOK models
  // route directly to caller-owned providers and must not require Industry auth.
  const effectiveModelId = modelId ?? getSessionService().getModel();
  const runtimeAuthConfig = getRuntimeAuthConfig();
  const requiresIndustryAuth =
    !runtimeAuthConfig.airgapEnabled &&
    requiresIndustryAuthForExecModel(effectiveModelId);

  // Airgap mode forbids Industry's LLM proxy. If the resolved model is not
  // BYOK, refuse to start the run with a clear "switch to BYOK" message
  // instead of letting the SDK hit the proxy URL via global fetch.
  if (
    runtimeAuthConfig.airgapEnabled &&
    requiresIndustryAuthForExecModel(effectiveModelId)
  ) {
    return {
      finalText: `Airgap Mode is enabled. Model "${effectiveModelId ?? 'default'}" routes through Industry's LLM proxy and cannot be used. Configure a BYOK custom model in settings.json to continue. See https://docs.example.com/cli/byok/overview`,
      numTurns: 0,
      isError: true,
      sessionId,
    };
  }

  const authResult = await getFreshTokenWithSource(runtimeAuthConfig);

  // Check if we have any authentication method
  if (!authResult && requiresIndustryAuth) {
    return {
      finalText: getI18n().t('errors:agent.authError', {
        message: getAuthErrorMessage(),
      }),
      numTurns: 0,
      isError: true,
      sessionId, // Use provided session ID if any, otherwise empty
    };
  }

  // If using API key authentication, validate it once at startup.
  // Skip validation for custom/BYOK models — they don't need Industry backend auth.
  if (authResult?.type === 'api-key' && requiresIndustryAuth) {
    try {
      // Validate API key via /whoami endpoint
      await verifyToken(authResult.token, runtimeAuthConfig);
    } catch (err) {
      logWarn(getAuthErrorMessage(), {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return {
        finalText: getI18n().t('errors:agent.authError', {
          message: getAuthErrorMessage(),
        }),
        numTurns: 0,
        isError: true,
        sessionId, // Use provided session ID if any, otherwise empty
      };
    }
  }

  // Session should already be created/loaded by the caller (via SessionController)
  // - CLI exec command: uses SessionController.createSession() or ensureSessionLoaded()
  const sessionService = getSessionService();

  const settingsService = getSettingsService();
  const prevModel = settingsService.getModel();
  const prevReasoning = settingsService.getReasoningEffort();
  const prevPersist = process.env.INDUSTRY_DISABLE_SETTINGS_PERSISTENCE;
  const prevAutonomyMode = getSessionService().getCurrentAutonomyMode();
  // Snapshot before runExecAgent, which clears the flag via useAgent.
  const sessionWasResumed = sessionService.isSessionResumed();
  process.env.INDUSTRY_DISABLE_SETTINGS_PERSISTENCE = 'true';

  // See `shouldApplyExecAutonomyMode`: inherited spec mode must not block
  // the caller-supplied autonomy.
  if (shouldApplyExecAutonomyMode({ useSpec, specModelId })) {
    sessionService.setAutonomyMode(effectiveAutonomyMode);
  }

  // Set main model and reasoning effort AFTER loading session to ensure CLI flags
  // take precedence over restored session settings
  if (modelId) {
    sessionService.setModel(modelId, reasoningEffort);
  } else if (reasoningEffort) {
    sessionService.setReasoningEffort(reasoningEffort);
  }

  // Configure spec model AFTER setting spec mode and main model
  // This ensures proper validation with main model's reasoning effort
  if (specModelId) {
    sessionService.setSpecModeModel(
      specModelId as ModelID,
      specReasoningEffort
    );
  }

  // Initialize feature flags for this exec run
  try {
    await fetchFeatureFlags();
  } catch {
    // Feature flags will use cached/default values
  }

  const restoreSettings = () => {
    try {
      settingsService.setModel(prevModel, prevReasoning);
      // Restore autonomy only for resumed sessions so `--auto` is one-shot;
      // fresh sessions (including task-cli subagents) persist what they ran under.
      if (sessionWasResumed) {
        getSessionService().setAutonomyMode(prevAutonomyMode);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[exec] Failed to restore model settings:', err);
    }
    if (prevPersist === undefined) {
      delete process.env.INDUSTRY_DISABLE_SETTINGS_PERSISTENCE;
    } else {
      process.env.INDUSTRY_DISABLE_SETTINGS_PERSISTENCE = prevPersist;
    }
  };

  return new Promise<ExecRunResult>((resolve) => {
    runExecAgent({
      prompt,
      images: images ?? [],
      toolExecutionContext,
      execEventCallbacks,
      systemPromptOverride,
      onExit: (result) => {
        restoreSettings();
        resolve({ ...result, sessionId: sessionId! });
      },
    }).catch((err) => {
      restoreSettings();
      resolve({
        finalText: `Error: ${err instanceof Error ? err.message : String(err)}`,
        numTurns: 0,
        isError: true,
        sessionId: sessionId!,
      });
    });
  });
}
