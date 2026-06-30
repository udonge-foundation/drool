import {
  AgentTurnCompletionReason,
  DroolWorkingState,
} from '@industry/drool-sdk-ext/protocol/drool';
import { type MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';
import { fetchFeatureFlags } from '@industry/runtime/feature-flags';

import type { ToolExecutionContext } from '@/agent/types';
import { getSessionController } from '@/controllers/SessionController';
import { AgentLoop } from '@/core/AgentLoop';
import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { convertBase64ImagesToAttachments } from '@/exec/imageAttachments';
import { didEndEarlyDueToPermissions } from '@/exec/renderlessExecRunner';
import type {
  AgentRunCallbacks,
  ExecRunResult,
  SharedAgentRunParams,
} from '@/exec/types';
import { MessageRole, MessageType } from '@/hooks/enums';
import { createSpecHandoffSession } from '@/hooks/spec-mode/createSpecImplementationSession';
import type { HistoryMessage } from '@/hooks/types';
import { getI18n } from '@/i18n';
import { getConversationStateManager } from '@/services/ConversationStateManager';
import { isNoApproverDelegatedSession } from '@/services/delegatedSession/detection';
import { maybeAutoRejectDelegatedPermission } from '@/services/delegatedSession/permissionGate';
import { getSessionService } from '@/services/SessionService';
import type { ImageAttachment } from '@/types/types';
import { generateUUID } from '@/utils/uuid';

import type { TokenUsage } from '@industry/common/session/settings';

function subtractTokenUsage(after: TokenUsage, before: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheCreationTokens: Math.max(
      0,
      after.cacheCreationTokens - before.cacheCreationTokens
    ),
    cacheReadTokens: Math.max(
      0,
      after.cacheReadTokens - before.cacheReadTokens
    ),
    thinkingTokens: Math.max(0, after.thinkingTokens - before.thinkingTokens),
    industryCredits: Math.max(
      0,
      (after.industryCredits ?? 0) - (before.industryCredits ?? 0)
    ),
  };
}

export function emitAgentTurnCompletedNotification({
  sessionId,
  reason,
  tokenUsageAtTurnStart,
  callbacks,
}: {
  sessionId: string;
  reason: AgentTurnCompletionReason;
  tokenUsageAtTurnStart?: TokenUsage;
  callbacks?: AgentRunCallbacks;
}): void {
  const cumulativeTokenUsage = getSessionService().getTokenUsage();
  agentEventBus.emit(AgentEvent.AgentTurnCompleted, {
    sessionId,
    reason: callbacks?.getTurnCompletionReason?.(reason) ?? reason,
    tokenUsage: subtractTokenUsage(
      cumulativeTokenUsage,
      tokenUsageAtTurnStart ?? cumulativeTokenUsage
    ),
    cumulativeTokenUsage,
  });
}

function createAgentTurnCompletedEmitter({
  sessionId,
  tokenUsageAtTurnStart,
  callbacks,
}: {
  sessionId: string;
  tokenUsageAtTurnStart: TokenUsage;
  callbacks?: AgentRunCallbacks;
}): {
  emit: (defaultReason: AgentTurnCompletionReason) => void;
  hasEmitted: () => boolean;
} {
  let hasEmitted = false;

  return {
    emit: (defaultReason) => {
      if (hasEmitted) {
        return;
      }
      hasEmitted = true;
      emitAgentTurnCompletedNotification({
        sessionId,
        reason: defaultReason,
        tokenUsageAtTurnStart,
        callbacks,
      });
    },
    hasEmitted: () => hasEmitted,
  };
}

/**
 * Helper to create an addMessage function compatible with AgentLoopParams
 * using the ConversationStateManager directly.
 */
function createAddMessage(
  manager: ReturnType<typeof getConversationStateManager>
): (
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
 * Create an AgentLoop wired to the ConversationStateManager.
 *
 * Centralises the ~40-field constructor for all agent execution paths.
 */
function createAgentLoop(opts: {
  toolExecutionContext: ToolExecutionContext;
  systemPromptOverride?: string;
  getIdeClient?: SharedAgentRunParams['getIdeClient'];
  getIdeState?: SharedAgentRunParams['getIdeState'];
  drainAllQueuedUserMessages?: AgentRunCallbacks['drainAllQueuedUserMessages'];
  drainEndOfLoopQueuedUserMessage?: AgentRunCallbacks['drainEndOfLoopQueuedUserMessage'];
}): AgentLoop {
  const manager = getConversationStateManager();
  const addMessage = createAddMessage(manager);

  return new AgentLoop({
    addMessage,
    updateAction: (actions) => manager.updateAction(actions),
    getConversationHistory: () => manager.getConversationHistory(),
    getRawConversationHistory: () => manager.getAllMessages(),
    isConversationEmpty: () => manager.isConversationEmpty(),
    messages: [],
    toolExecutionContext: opts.toolExecutionContext,
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
    setUiRenderCutoff: (messageId) => manager.setUiRenderCutoff(messageId),
    drainAllQueuedUserMessages: opts.drainAllQueuedUserMessages,
    drainEndOfLoopQueuedUserMessage: opts.drainEndOfLoopQueuedUserMessage,
    systemPromptOverride: opts.systemPromptOverride,
    getIdeClient: opts.getIdeClient,
    getIdeState: opts.getIdeState,
  });
}

/**
 * Run the agent with shared infrastructure.
 *
 * This function provides a unified entry point for running the agent
 * that all modes (TUI, StreamingJSONRPC, ACP) can use. It:
 *
 * 1. Sets up event forwarding to AgentEventBus
 * 2. Manages working state transitions
 * 3. Uses AgentLoop directly for execution (no React/Ink)
 *
 * The caller is responsible for:
 * - Creating and configuring SessionController
 * - Setting up protocol adapters that subscribe to AgentEventBus
 * - Providing a PermissionRequestHandler with mode-specific request logic
 *
 * @example
 * ```typescript
 * const controller = getSessionController();
 * const adapter = new JsonRpcProtocolAdapter(controller);
 * const permissionHandler = new PermissionRequestHandler(async (batch) => {
 *   // Mode-specific permission UI
 *   return { outcome: 'proceed_once' };
 * });
 *
 * const result = await runAgentWithSession({
 *   prompt: "Hello",
 *   permissionHandler,
 * });
 * ```
 */
export async function runAgentWithSession(
  params: SharedAgentRunParams,
  callbacks?: AgentRunCallbacks
): Promise<ExecRunResult> {
  const {
    prompt,
    images = [],
    files,
    permissionHandler,
    systemPromptOverride,
    requestId,
    role,
    visibility,
    userMessageSource,
    getIdeClient,
    getIdeState,
    outputFormat,
    hookContext,
  } = params;

  const sessionService = getSessionService();
  const sessionId = sessionService.getCurrentSessionId();

  if (!sessionId) {
    throw new Error(getI18n().t('common:execRunner.noActiveSessionController'));
  }
  const turnCompletion = createAgentTurnCompletedEmitter({
    sessionId,
    tokenUsageAtTurnStart: sessionService.getTokenUsage(),
    callbacks,
  });
  const emitAgentTurnCompleted = turnCompletion.emit;
  let fallbackCompletionReason = AgentTurnCompletionReason.Error;

  try {
    logInfo('[SharedAgentRunner] Starting agent run', {
      sessionId,
      hasInput: images.length > 0 || !!files,
    });

    // Create the requestPermissionFn that wraps our handler.
    // Mission workers are delegated sessions with no interactive user,
    // so any tool that requires confirmation would otherwise hang
    // waiting for a permission response that will never come.
    // Short-circuit with a synthetic Cancel and push a
    // <system-reminder> into the conversation so the worker's next turn
    // sees *why* it was denied and is nudged toward an alternative
    // approach that doesn't need approval.
    //
    // Subagents are deliberately excluded here: they run with a parent
    // process reachable over JSON-RPC (or ACP), so `permissionHandler`
    // forwards their prompts to that parent for approval instead.
    const conversationStateManager = getConversationStateManager();
    const requestPermissionFn = async (
      batch: Parameters<typeof permissionHandler.requestPermission>[0]
    ) => {
      const shortCircuit = maybeAutoRejectDelegatedPermission(batch, {
        shouldAutoReject: isNoApproverDelegatedSession,
        updateAction: (action) => conversationStateManager.updateAction(action),
      });
      if (shortCircuit) {
        return shortCircuit;
      }
      return permissionHandler.requestPermission(batch);
    };

    const toolExecutionContext = {
      sessionId,
      requestPermissionFn,
    };

    // Emit initial working state
    getSessionController().setWorkingState(
      DroolWorkingState.StreamingAssistantMessage
    );

    // Initialize feature flags
    try {
      await fetchFeatureFlags();
    } catch {
      // Feature flags will use cached/default values
    }

    const agentLoop = createAgentLoop({
      toolExecutionContext,
      systemPromptOverride,
      getIdeClient,
      getIdeState,
      drainAllQueuedUserMessages: callbacks?.drainAllQueuedUserMessages,
      drainEndOfLoopQueuedUserMessage:
        callbacks?.drainEndOfLoopQueuedUserMessage,
    });

    // Collect result from agent run
    const sessionServiceForResult = getSessionService();
    let runError: unknown;
    let specHandoffResult: ExecRunResult | undefined;
    let disposed = false;
    try {
      const runPromise = agentLoop.runAgentWithUserMessage({
        message: prompt,
        images: convertBase64ImagesToAttachments(images),
        files,
        requestId,
        role,
        visibility,
        userMessageSource,
        outputFormat,
        hookContext,
      });

      if (callbacks?.onInterruptReady) {
        callbacks.onInterruptReady(agentLoop.stopAgent.bind(agentLoop));
      }

      await runPromise;

      // Check for pending spec-to-new-session handoff.
      // When ExitSpecMode is approved with proceed_new_session, the agent loop stops
      // and stores the handoff payload. We create a new session and continue there.
      const specPayload = agentLoop.consumePendingSpecHandoff();
      if (specPayload) {
        try {
          const { newSessionId, handoff } =
            await createSpecHandoffSession(specPayload);

          logInfo('[SharedAgentRunner] Spec handoff: new session created', {
            newSessionId,
            state: specPayload.autonomyLevel,
          });

          // Dispose the old agent loop before running the new one.
          // Set disposed flag so the finally block doesn't double-dispose.
          agentLoop.dispose();
          disposed = true;
          specHandoffResult = await runAgentWithSession(
            {
              prompt: handoff.userMessage,
              permissionHandler,
              systemPromptOverride,
              getIdeClient,
              getIdeState,
            },
            callbacks
          );
        } catch (error) {
          logException(
            error,
            '[SharedAgentRunner] Error launching spec handoff in new session'
          );
        }
      }
    } catch (err) {
      runError = err;
      // Surface the error so protocol adapters (JSON-RPC, daemon) can
      // forward it to the client and the TUI can display the message.
      agentEventBus.emit(AgentEvent.AgentError, {
        error: err,
        sessionId,
      });
    } finally {
      if (!disposed) {
        agentLoop.dispose();
      }
    }

    if (specHandoffResult) {
      fallbackCompletionReason = AgentTurnCompletionReason.SpecHandoff;
      emitAgentTurnCompleted(AgentTurnCompletionReason.SpecHandoff);
      getSessionController().setWorkingState(DroolWorkingState.Idle);
      return specHandoffResult;
    }

    // Build result
    const events = await sessionServiceForResult.getAllMessageEvents(sessionId);

    // Extract final text (same logic as renderlessExecRunner)
    let finalText = '';
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
    finalText = texts.length ? texts[texts.length - 1] : '';

    const numTurns = events.filter(
      (e) => e.message.role === 'assistant'
    ).length;
    const earlyExit = didEndEarlyDueToPermissions(events);
    const permissionRejected = agentLoop.didEndDueToPermissionRejection();
    const isError = !!runError || earlyExit || !!agentLoop.state.error;
    const defaultCompletionReason = runError
      ? AgentTurnCompletionReason.Error
      : earlyExit || permissionRejected
        ? AgentTurnCompletionReason.PermissionRejected
        : agentLoop.state.error
          ? AgentTurnCompletionReason.Error
          : AgentTurnCompletionReason.Completed;
    fallbackCompletionReason = defaultCompletionReason;
    emitAgentTurnCompleted(defaultCompletionReason);

    // Emit idle state
    getSessionController().setWorkingState(DroolWorkingState.Idle);

    logInfo('[SharedAgentRunner] Agent run complete', {
      sessionId,
      isError,
      numTurns,
    });

    return { finalText, numTurns, isError, sessionId };
  } finally {
    if (!turnCompletion.hasEmitted()) {
      emitAgentTurnCompleted(fallbackCompletionReason);
    }
  }
}

/** Resume allow-listed pending tools for the current session, if any. */
export async function resumeAgentWithSession(
  params: Pick<
    SharedAgentRunParams,
    | 'permissionHandler'
    | 'systemPromptOverride'
    | 'getIdeClient'
    | 'getIdeState'
  >,
  callbacks?: AgentRunCallbacks
): Promise<void> {
  const sessionService = getSessionService();
  const sessionId = sessionService.getCurrentSessionId();

  if (!sessionId) {
    return;
  }

  // Avoid toggling working state when there is nothing to resume.
  const pendingToolIds = getConversationStateManager().getPendingToolIds();
  if (pendingToolIds.length === 0) {
    return;
  }
  const turnCompletion = createAgentTurnCompletedEmitter({
    sessionId,
    tokenUsageAtTurnStart: sessionService.getTokenUsage(),
    callbacks,
  });
  let fallbackCompletionReason = AgentTurnCompletionReason.Completed;

  try {
    const requestPermissionFn = async (
      batch: Parameters<typeof params.permissionHandler.requestPermission>[0]
    ) => params.permissionHandler.requestPermission(batch);

    const toolExecutionContext = {
      sessionId,
      requestPermissionFn,
    };

    try {
      await fetchFeatureFlags();
    } catch {
      // Feature flags will use cached/default values
    }

    // createAgentLoop() must stay inside this guarded block: if it (or the
    // setup above) throws, the outer finally still emits AgentTurnCompleted so
    // callers awaiting the turn (e.g. the foreground Task loop) cannot hang.
    const agentLoop = createAgentLoop({
      toolExecutionContext,
      systemPromptOverride: params.systemPromptOverride,
      getIdeClient: params.getIdeClient,
      getIdeState: params.getIdeState,
      drainAllQueuedUserMessages: callbacks?.drainAllQueuedUserMessages,
      drainEndOfLoopQueuedUserMessage:
        callbacks?.drainEndOfLoopQueuedUserMessage,
    });

    try {
      const runPromise = agentLoop.resumeLoop();

      if (callbacks?.onInterruptReady) {
        callbacks.onInterruptReady(agentLoop.stopAgent.bind(agentLoop));
      }

      await runPromise;
    } catch (err) {
      fallbackCompletionReason = AgentTurnCompletionReason.Error;
      logException(err, '[SharedAgentRunner] resumeLoop failed');
    } finally {
      agentLoop.dispose();
    }
  } catch (err) {
    fallbackCompletionReason = AgentTurnCompletionReason.Error;
    logException(err, '[SharedAgentRunner] resume setup failed');
  } finally {
    if (!turnCompletion.hasEmitted()) {
      turnCompletion.emit(fallbackCompletionReason);
    }
    getSessionController().setWorkingState(DroolWorkingState.Idle);
  }
}
