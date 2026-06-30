import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import {
  DroolExecutionStatus,
  REQUEST_INTERRUPTED_BY_USER_RESULT_TEXT,
  TOOL_EXECUTION_CANCELLED_BY_USER_RESULT_TEXT,
} from '@industry/common/session';
import { SessionTitleAutoStage } from '@industry/common/session/summary';
import { PROXY_API_KEY_PLACEHOLDER } from '@industry/drool-core/llms/client/constants';
import { RetryStrategy } from '@industry/drool-core/llms/client/enums';
import { createLlmClients } from '@industry/drool-core/llms/client/llmClients';
import { StructuredOutputError } from '@industry/drool-core/llms/client/structured-output/errors';
import {
  extractEmptyResponseTelemetry,
  getIndustryDisplayable402Body,
  isContentModerationError,
  isContextLimitError,
  isCorporateFirewallError,
  isDnsOrConnectionError,
  isOverloadedError,
  isThinkingSignatureError,
  isTimeoutError,
  isToolSchemaCompatibilityError,
  isTlsCertificateError,
  LLMContentModerationError,
} from '@industry/drool-core/llms/errors';
import { LanguageModelFinishReason } from '@industry/drool-core/streaming/enums';
import {
  DroolWorkingState,
  MissionState,
  SessionNotificationType,
  type OutputFormat,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  ApiProvider,
  BillingPool,
  INDUSTRY_ROUTER_MODEL_ID,
  ModelID,
  ModelProvider,
} from '@industry/drool-sdk-ext/protocol/llm';
import { SessionOrigin } from '@industry/drool-sdk-ext/protocol/session';
import {
  ContentBlock,
  DocumentSource,
  IndustryDroolMessage,
  IndustryDroolMessageWithCaching,
  MessageContentBlockType,
  MessageVisibility,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';
import {
  RESUMABLE_TOOL_LLM_IDS,
  TOOL_LLM_ID_APPLY_PATCH,
  TOOL_LLM_ID_CREATE,
  TOOL_LLM_ID_EDIT,
  TOOL_LLM_ID_EXECUTE,
  TOOL_LLM_ID_START_MISSION_RUN,
} from '@industry/drool-sdk-ext/protocol/tools';
import {
  logInfo,
  logWarn,
  logException,
  Metrics,
  Metric,
} from '@industry/logging';
import { AuthenticationError, MetaError } from '@industry/logging/errors';
import {
  getAuthedUser,
  getCachedRegion,
  resolveCliApiBaseUrl,
} from '@industry/runtime/auth';
import { getFlag } from '@industry/runtime/feature-flags';
import { getIndustryDirName } from '@industry/utils/environment';
import { isAbortError } from '@industry/utils/function';
import {
  approxTokensFromChars,
  DROOL_CORE_CONTEXT_LIMIT_COMPACTION_MODEL,
  getLLMConfig,
  getLLMModel,
} from '@industry/utils/llm';
import { buildUserMessageContentBlocks } from '@industry/utils/messages';
import { findCustomModel, isBedrockCustomModel } from '@industry/utils/models';
import { hasSubagentSessionTag } from '@industry/utils/session';

import { createDoSendFunction } from '@/agent/messaging';
import type { ApprovedSpecNewSessionPayload } from '@/agent/types';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import { ABORT_NOTICE_TEXT } from '@/components/chat/constants';
import { ERROR_PREFIX } from '@/constants/constants';
import { getSessionController } from '@/controllers/SessionController';
import { buildSpecModeReminder } from '@/core/specModeReminder';
import { ToolExecutor } from '@/core/ToolExecutor';
import type { AgentLoopParams, TokenLimitChoice } from '@/core/types';
import { getRuntimeAuthConfig } from '@/environment';
import {
  AgentEvent,
  agentEventBus,
  SessionTitleUpdateType,
} from '@/events/AgentEventBus';
import { convertAttachmentsToBase64Images } from '@/exec/imageAttachments';
import {
  compactAfterContextLimit as compactConversation,
  attachExistingSummary,
} from '@/hooks/compaction/CompactionManager';
import { CompactionSummaryKind } from '@/hooks/compaction/enums';
import {
  isAnchoredAtLastMessage,
  persistSignatureRecoveryBoundary,
  serializeAndPersistForProviderSwitch,
} from '@/hooks/compaction/providerSwitchUtils';
import { createSummarizer } from '@/hooks/compaction/Summarizer';
import { loadLastSummaryMetas } from '@/hooks/compaction/summaryMeta';
import type { LastSummaryMeta, SummarizeFn } from '@/hooks/compaction/types';
import {
  MAX_CONSECUTIVE_NO_OUTPUT_TURNS,
  TODO_STALE_THRESHOLD,
} from '@/hooks/constants';
import {
  AgentStatusState,
  HookEventName,
  MessageRole,
  MessageType,
  ToolCallStatus,
} from '@/hooks/enums';
import { AgentAbortError, HookStopError } from '@/hooks/errors';
import {
  AgentState,
  HistoryMessage,
  StateAction,
  ToolResultContent,
} from '@/hooks/types';
import { getI18n } from '@/i18n';
import { getTuiModelConfig } from '@/models/config';
import { buildCliModelRoutingDeps } from '@/models/modelRoutingDeps';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { TokenLimitAction } from '@/services/enums';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { executeHooksWithDisplay } from '@/services/hook-utils';
import {
  buildDeferredToolsReminderForSession,
  createLLMStreamingCore,
} from '@/services/llmStreamingClient';
import { getMcpServiceIfCreated } from '@/services/mcp/McpService';
import { convertStreamingBlocksToContentBlocks } from '@/services/message-converters';
import { collectAndMarkNewWorkerHandoffs } from '@/services/mission/handoffs';
import { getMissionFileService } from '@/services/mission/MissionFileService';
import { getMissionOveragePreferenceBlockMessage } from '@/services/mission/overagePreferenceGate';
import { getMissionPausedReminder } from '@/services/mission/prompts';
import {
  isMissionOrchestratorSession,
  isMissionWorkerSession,
} from '@/services/mission/sessionTags';
import type { ArtifactLayoutMarker } from '@/services/mission/types';
import {
  getPermissionModeString,
  getSessionService,
} from '@/services/SessionService';
import { generateAndUpdateSessionTitle } from '@/services/SessionTitleGenerator';
import { getSettingsService } from '@/services/SettingsService';
import { getFileSnapshotService } from '@/services/snapshots/FileSnapshotService';
import { playCompletionSoundIfRegistered } from '@/services/soundCallbacks';
import {
  type BillingLimitsFetchResult,
  deriveOveragePreferenceStatus,
  deriveTokenLimitChoice,
  fetchBillingLimitsRaw,
  fetchTokenLimits,
  handleTokenLimitAction,
} from '@/services/TokenLimitService';
import { DroolSession } from '@/services/types';
import {
  formatAvailableSkillsReminder,
  getAvailableSkillsForReminder,
} from '@/skills/availableSkillsReminder';
import { isConnectivityReminder } from '@/tools/executors/client/connectors/format';
import { buildConnectorToolsReminderForSession } from '@/tools/executors/client/connectors/reminder';
import { ImageAttachment } from '@/types/types';
import type { BatchToolConfirmationDetails } from '@/types/types';
import { logAgentException } from '@/utils/agentErrorLogger';
import { attemptDroolCoreFallback402 } from '@/utils/attemptDroolCoreFallback402';
import { validateByokProviderConfig } from '@/utils/byokValidation';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { computeLastCallCompactionTokens } from '@/utils/contextUsage';
import {
  ghosttyProgressClear,
  ghosttyProgressMarkError,
  ghosttyProgressStartIndeterminate,
} from '@/utils/ghosttyProgress';
import { persistSystem as persistSystemHelper } from '@/utils/messages/persistSystem';
import {
  resolveActiveModel,
  resolveTurnModelContext,
} from '@/utils/modelUtils';
import { applyOutputTransforms } from '@/utils/outputTransform';
import { ensureProviderLocks } from '@/utils/providerLocking';
import { isQueuedMessagesFeatureEnabled } from '@/utils/queuedMessagesFeatureFlag';
import { signalUnrecoverable402ToMission } from '@/utils/signalUnrecoverable402ToMission';
import {
  buildStructuredOutputInstruction,
  buildStructuredOutputRetryMessage,
  validateStructuredOutputText,
} from '@/utils/structuredOutput';
import { MAX_STRUCTURED_OUTPUT_RETRIES } from '@/utils/structuredOutput/constants';
import { maybeInjectUpgradeNudges } from '@/utils/stuckPhraseDetector';
import {
  formatResumeSystemReminder,
  formatSystemReminder,
  getResumeSystemInfo,
  getSystemInfo,
  prefetchSystemInfo,
} from '@/utils/systemInfo';
import {
  formatIdeContextMessage,
  formatFileChangeReminder,
  formatCurrentDateReminder,
  isCurrentDateReminderForDate,
  formatWorktreeReminder,
  wrapInSystemReminder,
} from '@/utils/systemReminderUtils';
import { buildTaggedPathReminderBlocks } from '@/utils/tagged-files';
import { parseTodosInput } from '@/utils/todo-utils';
import { getTextContent } from '@/utils/tool-result-helpers';
import { SystemInfo } from '@/utils/types';
import { deriveUiRenderCutoffMessageId } from '@/utils/uiRenderCutoff';
import { generateUUID } from '@/utils/uuid';

import type {
  LlmClients,
  StreamingResult,
} from '@industry/drool-core/llms/client/types';
import type { TodoWriteToolParams } from '@industry/drool-core/tools/definitions/todo';

// ─── Utility functions (moved from useAgent.ts) ───────────────────────

const TODO_WRITE_NOT_CALLED_REMINDER =
  "IMPORTANT: TodoWrite was not called yet. You must call it for any non-trivial task requested by the user. It would benefit overall performance. Make sure to keep the todo list up to date to the state of the conversation. Performance tip: call the TodoWrite tool in parallel to the main flow related tool calls to save user's time and tokens.";

const SUBAGENT_RESUMABLE_TOOL_LLM_IDS: readonly string[] = [
  TOOL_LLM_ID_EXECUTE,
  TOOL_LLM_ID_CREATE,
  TOOL_LLM_ID_EDIT,
  TOOL_LLM_ID_APPLY_PATCH,
];

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === MessageContentBlockType.ToolUse;
}

const getNetworkErrorKey = (error: unknown): string => {
  if (isCorporateFirewallError(error)) {
    return 'errors:agent.networkFirewallError';
  }
  if (isTlsCertificateError(error)) {
    return 'errors:agent.networkTlsCertificateError';
  }
  return 'errors:agent.networkConnectionError';
};

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === MessageContentBlockType.ToolResult;
}

function safeStringifyLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Cheap char estimate for a single content block used only by the outbound
 * request diagnostic log. Runs on every send, so it reads string `.length`
 * fields directly (never materializing base64 `image`/`document` data) and
 * only falls back to `JSON.stringify` for small/unknown shapes.
 */
function estimateContentBlockChars(block: unknown): number {
  if (block === null || typeof block !== 'object') {
    return typeof block === 'string' ? block.length : 0;
  }
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' ? b.text.length : 0;
    case 'thinking':
      return (
        (typeof b.thinking === 'string' ? b.thinking.length : 0) +
        (typeof b.signature === 'string' ? b.signature.length : 0)
      );
    case 'redacted_thinking':
      return typeof b.data === 'string' ? b.data.length : 0;
    case 'image':
    case 'document': {
      const source =
        typeof b.source === 'object' && b.source !== null
          ? (b.source as Record<string, unknown>)
          : undefined;
      return typeof source?.data === 'string' ? source.data.length : 0;
    }
    case 'tool_use':
      return (
        (typeof b.name === 'string' ? b.name.length : 0) +
        safeStringifyLength(b.input)
      );
    case 'tool_result': {
      const content = b.content;
      if (typeof content === 'string') return content.length;
      if (Array.isArray(content)) {
        let sum = 0;
        for (const sub of content) sum += estimateContentBlockChars(sub);
        return sum;
      }
      return safeStringifyLength(content);
    }
    default:
      return safeStringifyLength(b);
  }
}

function shouldContinueFromIncompleteStop(
  stopReason: LanguageModelFinishReason | undefined
): boolean {
  return (
    stopReason === LanguageModelFinishReason.Length ||
    stopReason === LanguageModelFinishReason.PauseTurn ||
    stopReason === LanguageModelFinishReason.ModelContextWindowExceeded
  );
}

const THINKING_TAG_REGEX = /<thinking>[\s\S]*?<\/thinking>/gi;

// Strips <thinking>...</thinking> blocks so the "no visible output" guard in
// the agent loop sees only user-facing text. Models replay prior-turn thinking
// as `<thinking>...</thinking>` text via prepareMessagesWithCaching's signature
// downgrade, and Gemini preview sometimes returns a final assistant turn whose
// only content is one of those wrapper blocks (CL-452).
function getVisibleAssistantText(content: string): string {
  return content.replace(THINKING_TAG_REGEX, '').trim();
}

/**
 * Counts tool calls since the last TodoWrite call in the conversation history.
 * Returns the count of tool calls if TodoWrite was found, or total count if not found.
 */
export function countToolCallsSinceLastTodoWrite(
  conversationHistory: IndustryDroolMessage[]
): number {
  let toolCallCount = 0;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Iterate blocks in reverse to correctly count tool calls that appear
      // after a TodoWrite within the same assistant message.
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (isToolUseBlock(block)) {
          if (block.name === 'TodoWrite') {
            return toolCallCount;
          }
          toolCallCount++;
        }
      }
    }
  }
  return toolCallCount;
}

/**
 * Checks if the todo list has any pending or in_progress items.
 * Handles both string format and array format for todos.
 */
export function hasPendingTodos(
  todos: TodoWriteToolParams | undefined
): boolean {
  if (!todos?.todos) return false;

  const parsedTodos = parseTodosInput(todos);

  if (!parsedTodos || parsedTodos.length === 0) return false;

  return parsedTodos.some(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress'
  );
}

export function getContextLimitCompactionFallbackModel(
  modelId: string
): string | undefined {
  if (modelId === DROOL_CORE_CONTEXT_LIMIT_COMPACTION_MODEL) {
    return undefined;
  }

  try {
    return getLLMConfig({ modelId: modelId as ModelID }).billingPool ===
      BillingPool.Core
      ? DROOL_CORE_CONTEXT_LIMIT_COMPACTION_MODEL
      : undefined;
  } catch {
    return undefined;
  }
}

function getNonCompletedTodoLines(todos: TodoWriteToolParams): string[] {
  return parseTodosInput(todos)
    .filter(
      (todo) => todo.status === 'pending' || todo.status === 'in_progress'
    )
    .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`);
}

function formatTodoCompletionReminder(todos: TodoWriteToolParams): string {
  const nonCompletedTodos = getNonCompletedTodoLines(todos);
  const nonCompletedList =
    nonCompletedTodos.length > 0 ? nonCompletedTodos.join('\n') : 'None.';

  return `IMPORTANT: It looks like you may have completed the user-facing turn, but the current TodoWrite plan still has pending or in-progress items.

These items are still marked as pending or in_progress:
${nonCompletedList}

Only respond by calling TodoWrite to update these items accurately, or if no TodoWrite update is needed, reply exactly: Plan is up-to-date.
Do not reference this system reminder in any user-facing messages.`;
}

function messageTextMatches(
  message: IndustryDroolMessage,
  predicate: (text: string) => boolean
): boolean {
  const content: unknown = message.content;
  if (typeof content === 'string') {
    return predicate(content);
  }

  return (
    Array.isArray(content) &&
    content.some((block) => {
      const contentBlock = block as ContentBlock;
      return (
        contentBlock.type === MessageContentBlockType.Text &&
        predicate(contentBlock.text)
      );
    })
  );
}

function messageContainsText(
  message: IndustryDroolMessage,
  text: string
): boolean {
  return messageTextMatches(message, (value) => value.includes(text));
}

function getSummarySuffixStart(
  messages: IndustryDroolMessage[],
  lastSummary: LastSummaryMeta | null | undefined
): number {
  if (!lastSummary) {
    return 0;
  }

  let resolvedIndex = -1;
  if (lastSummary.anchorId) {
    resolvedIndex = messages.findIndex((m) => m.id === lastSummary.anchorId);
  }
  if (resolvedIndex < 0) {
    resolvedIndex = lastSummary.anchorIndex;
  }

  let suffixStart = Math.max(0, resolvedIndex + 1);
  while (
    suffixStart < messages.length &&
    messages[suffixStart].role === MessageRole.Tool
  ) {
    suffixStart++;
  }

  return suffixStart;
}

function historyContainsReminderAfterSummary(
  messages: IndustryDroolMessage[],
  reminder: string,
  lastSummary: LastSummaryMeta | null | undefined
): boolean {
  const retainedMessages = messages.slice(
    getSummarySuffixStart(messages, lastSummary)
  );
  return retainedMessages.some((msg) => messageContainsText(msg, reminder));
}

function historyContainsCurrentDateReminderAfterSummary(
  messages: IndustryDroolMessage[],
  lastSummary: LastSummaryMeta | null | undefined,
  date: Date
): boolean {
  const retainedMessages = messages.slice(
    getSummarySuffixStart(messages, lastSummary)
  );
  return retainedMessages.some((msg) =>
    messageTextMatches(msg, (text) => isCurrentDateReminderForDate(text, date))
  );
}

function createDeferredToolsReminderMessage(
  reminder: string
): IndustryDroolMessage {
  return {
    id: `deferred-tools-reminder-${generateUUID()}`,
    role: MessageRole.User,
    content: [
      {
        type: MessageContentBlockType.Text,
        text: reminder,
      },
    ],
    visibility: MessageVisibility.LLMOnly,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function ensureRemindersVisible(
  messages: IndustryDroolMessage[],
  reminders: string[]
): IndustryDroolMessage[] {
  let result = messages;
  for (const reminder of reminders) {
    if (!reminder || result.some((msg) => messageContainsText(msg, reminder))) {
      continue;
    }
    result = [createDeferredToolsReminderMessage(reminder), ...result];
  }
  return result;
}

/**
 * Strip every connector connectivity-reminder text block from a copy of the
 * history so the caller can re-inject only the current connectivity state.
 * Connectivity reminders are deduped by exact text, so a state change (e.g.
 * "no apps connected" -> "github connected") would otherwise leave the older,
 * now-contradictory reminder in the retained history. Pruning here (then
 * re-adding the latest via {@link ensureRemindersVisible}) keeps exactly one
 * current connectivity reminder visible to the model, and is reload-safe since
 * it runs every time the request history is assembled. Messages and blocks are
 * copied rather than mutated; messages left empty by the strip are dropped.
 */
function pruneStaleConnectivityReminders(
  messages: IndustryDroolMessage[]
): IndustryDroolMessage[] {
  const pruned: IndustryDroolMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      pruned.push(message);
      continue;
    }
    const hasConnectivity = message.content.some(
      (block) =>
        block.type === MessageContentBlockType.Text &&
        isConnectivityReminder(block.text)
    );
    if (!hasConnectivity) {
      pruned.push(message);
      continue;
    }
    const filtered = message.content.filter(
      (block) =>
        !(
          block.type === MessageContentBlockType.Text &&
          isConnectivityReminder(block.text)
        )
    );
    if (filtered.length > 0) {
      pruned.push({ ...message, content: filtered });
    }
  }
  return pruned;
}

function shouldSendTodoCompletionReminder(
  todoState:
    | {
        todos: TodoWriteToolParams;
      }
    | null
    | undefined,
  alreadySent: boolean
): boolean {
  return !alreadySent && !!todoState && hasPendingTodos(todoState.todos);
}

/**
 * Walks back conversation history to check if the last StartMissionRun tool_use
 * was cancelled. Returns true if the most recent StartMissionRun's tool_result
 * is an error (indicating cancellation / pause).
 */
function wasLastStartMissionRunCancelled(
  conversationHistory: IndustryDroolMessage[]
): boolean {
  // Walk backwards to find the most recent StartMissionRun tool_use
  let startMissionRunToolUseId: string | null = null;

  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (
          isToolUseBlock(block) &&
          block.name === TOOL_LLM_ID_START_MISSION_RUN
        ) {
          startMissionRunToolUseId = block.id;
          break;
        }
      }
      if (startMissionRunToolUseId) break;
    }
  }

  if (!startMissionRunToolUseId) return false;

  // Find the corresponding tool_result
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          isToolResultBlock(block) &&
          block.toolUseId === startMissionRunToolUseId
        ) {
          return block.isError === true;
        }
      }
    }
  }

  return false;
}

function formatImportedPathsSummary(importedPaths: string[]): string {
  if (importedPaths.length === 0) {
    return '';
  }

  const visiblePaths = importedPaths
    .slice(0, 5)
    .map((artifactPath) => `\`${artifactPath}\``);
  const hiddenCount = importedPaths.length - visiblePaths.length;

  return ` Imported artifacts: ${visiblePaths.join(', ')}${hiddenCount > 0 ? `, and ${hiddenCount} more` : ''}.`;
}

function buildCanonicalArtifactLayoutNotice(params: {
  marker: ArtifactLayoutMarker;
  missionDir: string;
}): string {
  const { marker, missionDir } = params;
  const importedPathsSummary = formatImportedPathsSummary(marker.importedPaths);

  if (marker.ambiguousSkillNames.length > 0) {
    const ambiguousSkills = marker.ambiguousSkillNames
      .map((skillName: string) => `\`${skillName}\``)
      .join(', ');

    return `LEGACY MISSION MIGRATION: Legacy repo-root \`.industry\` mission artifacts were imported into ${missionDir}. Some legacy skills could not be auto-imported because their names were ambiguous: ${ambiguousSkills}. Treat ${missionDir} as canonical for migrated artifacts and resolve those skill references before resuming work.${importedPathsSummary}`;
  }

  return `LEGACY MISSION MIGRATION: This mission was created before the current artifact layout. Legacy repo-root \`.industry\` mission artifacts were imported into ${missionDir}. ${missionDir} is now the canonical location for mission artifacts. Do not edit repo-root \`.industry\` copies.${importedPathsSummary}`;
}

/**
 * Fallback for providers that don't emit contentBlocks (index-based interleaved tracking).
 * Builds content blocks from the flat streamingResult fields in legacy order:
 * thinking -> text -> tool_use.
 */
export function buildFallbackContentBlocks(
  streamingResult: StreamingResult,
  modelProvider: ModelProvider
): ContentBlock[] {
  const content: ContentBlock[] = [];

  if (streamingResult.thinkingContent) {
    const thinkingBlock: ThinkingBlock = {
      type: MessageContentBlockType.Thinking,
      thinking: streamingResult.thinkingContent,
      signature: streamingResult.thinkingSignature || '',
      signatureProvider: modelProvider,
    };
    content.push(thinkingBlock);
  }

  if (streamingResult.content.trim()) {
    content.push({
      type: MessageContentBlockType.Text,
      text: streamingResult.content.trim(),
    });
  }

  for (const toolUse of streamingResult.toolUses) {
    const toolUseBlock: ToolUseBlock = {
      type: MessageContentBlockType.ToolUse,
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
      ...(toolUse.thoughtSignature && {
        thoughtSignature: toolUse.thoughtSignature,
      }),
    };
    content.push(toolUseBlock);
  }

  return content;
}

function emitToolStreamingUpdate({
  toolId,
  toolName,
  update,
}: {
  toolId: string;
  toolName: string;
  update: ToolStreamingUpdate;
}): void {
  const sessionId = getSessionService().getCurrentSessionId();
  if (sessionId) {
    agentEventBus.emit(AgentEvent.ToolStreamingUpdate, {
      id: toolId,
      name: toolName,
      update,
      sessionId,
    });
  }
}

// ─── AgentLoop Class ──────────────────────────────────────────────────

type UserMessageRunParams = {
  message: string;
  images?: ImageAttachment[];
  additionalContentBlocks?: TextBlock[];
  files?: DocumentSource[];
  hookContext?: string;
  messageId?: string;
  requestId?: string;
  role?: string;
  visibility?: string;
  userMessageSource?: SessionOrigin;
  outputFormat?: OutputFormat;
};

type ResumablePendingToolItem = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type RunAgentMode =
  | { kind: 'user'; userMessageRun: UserMessageRunParams }
  | { kind: 'resume'; pendingToolUseItems: ResumablePendingToolItem[] };

function mergeUserMessageSourceForTurn(
  current: SessionOrigin | undefined,
  next: SessionOrigin | undefined
): SessionOrigin | undefined {
  if (!next) return current;
  if (!current || current === next) return next;
  if (current === SessionOrigin.Slack) return next;
  if (next === SessionOrigin.Slack) return current;
  return next;
}

export class AgentLoop {
  // ── Dependencies (from params) ──
  private params: AgentLoopParams;

  // ── State (replaces useState) ──
  private _state: AgentState = {
    status: {
      state: AgentStatusState.Idle,
    },
    error: null,
  };

  private _tokenLimitChoice: TokenLimitChoice | null = null;

  private _isCancelling = false;

  // True when the most recent turn ended because an approver-backed subagent's
  // forwarded permission was rejected (subagents_v2). Read by the runner to
  // emit AgentTurnCompletionReason.PermissionRejected.
  private _endedDueToPermissionRejection = false;

  // ── Refs (replaces useRef) ──
  private cancellationPromiseRef: Promise<void> | null = null;

  private lastActiveFileRef: string | null = null;

  private compactionAbortRef: AbortController | null = null;

  private lastSummaryRef: LastSummaryMeta | undefined = undefined;

  private lastLlmSummaryRef: LastSummaryMeta | undefined = undefined;

  private thresholdCompactionSuppressionRef: {
    sessionId: string;
    modelId: string;
    limit: number;
  } | null = null;

  private runningRef = false;

  private _pendingSpecHandoff: ApprovedSpecNewSessionPayload | null = null;

  private stopHookActiveRef = false;

  // ── LLM streaming core (replaces useLLMStreaming) ──
  private llmClientsRef: { current: LlmClients } = {
    current: createLlmClients(),
  };

  private abortControllerRef: { current: AbortController | null } = {
    current: null,
  };

  private ideToolsRef: { current: Anthropic.Tool[] | null } = {
    current: null,
  };

  private systemPromptOverrideRef: { current: string | undefined };

  private isS3LoggingEnabledRef: { current: boolean } = { current: false };

  private llmCore: ReturnType<typeof createLLMStreamingCore>;

  // ── Tool executor (replaces useToolExecution) ──
  private toolExecutor: ToolExecutor;

  constructor(params: AgentLoopParams) {
    this.params = params;

    // Set up ref-like objects for LLM streaming core
    const self = this;
    this.systemPromptOverrideRef = { current: params.systemPromptOverride };
    const getRetryStrategy = () =>
      getDroolRuntimeService().isNonInteractiveCLIMode() ||
      isMissionWorkerSession(getSessionService().getCurrentSessionTags?.())
        ? RetryStrategy.NonInteractive
        : RetryStrategy.Interactive;

    this.llmCore = createLLMStreamingCore({
      llmClientsRef: this.llmClientsRef,
      abortControllerRef: this.abortControllerRef,
      ideToolsRef: this.ideToolsRef,
      getSystemPromptOverride: () => this.systemPromptOverrideRef.current,
      isS3LoggingEnabled: () => this.isS3LoggingEnabledRef.current,
      session: getSessionService(),
      settings: getSettingsService(),
      ide: { getIdeClient: () => self.params.getIdeClient?.() },
      getRetryStrategy,
    });

    // Initialize tool executor
    this.toolExecutor = new ToolExecutor({
      updateToolResult: this.wrappedUpdateToolResult.bind(this),
      setToolError: this.wrappedSetToolError.bind(this),
      updateToolStatus: params.updateToolStatus,
      updateToolCallInput: params.updateToolCallInput,
      context: {
        ...params.toolExecutionContext,
        get ideClient() {
          return params.getIdeClient?.();
        },
      },
      updateAction: params.updateAction,
      getToolExecutions: params.getToolExecutions,
      onToolStreamingUpdate: emitToolStreamingUpdate,
      keypressCallbacks: params.keypressCallbacks,
      onPendingConfirmationChange: (confirmation) => {
        params.onPendingConfirmationChange?.(confirmation);
        // Update agent status based on confirmation state
        this.updateAgentStatusForConfirmation(
          !!confirmation,
          this._state.status.state
        );
      },
    });
  }

  // ── Public getters ──

  get state(): AgentState {
    return this._state;
  }

  get tokenLimitChoice() {
    return this._tokenLimitChoice;
  }

  get isCancelling(): boolean {
    return this._isCancelling;
  }

  didEndDueToPermissionRejection(): boolean {
    return this._endedDueToPermissionRejection;
  }

  get pendingConfirmation(): BatchToolConfirmationDetails | null {
    return this.toolExecutor.getPendingConfirmation();
  }

  /**
   * Consume the pending spec handoff payload (if any).
   * Returns the payload and clears it, so callers get it exactly once.
   * Used by non-TUI modes (exec, JSON-RPC) via sharedAgentRunner.
   */
  consumePendingSpecHandoff(): ApprovedSpecNewSessionPayload | null {
    const payload = this._pendingSpecHandoff;
    this._pendingSpecHandoff = null;
    return payload;
  }

  // ── State management (replaces setState) ──

  private setState(
    updater: AgentState | ((prev: AgentState) => AgentState)
  ): void {
    const newState =
      typeof updater === 'function' ? updater(this._state) : updater;
    this._state = newState;
    this.params.onStateChange?.(newState);
  }

  private setTokenLimitChoice(choice: typeof this._tokenLimitChoice): void {
    this._tokenLimitChoice = choice;
    this.params.onTokenLimitChoiceChange?.(choice);
  }

  private setIsCancelling(value: boolean): void {
    this._isCancelling = value;
    this.params.onCancellingChange?.(value);
  }

  // ── Param updates (for keeping in sync with React re-renders) ──

  updateParams(params: Partial<AgentLoopParams>): void {
    this.params = { ...this.params, ...params };

    // Unconditionally sync refs from merged params so explicit `undefined` clears them
    this.systemPromptOverrideRef.current = this.params.systemPromptOverride;

    // Update tool executor context with lazy ideClient getter

    const instance = this;
    this.toolExecutor.updateParams({
      updateToolResult: this.wrappedUpdateToolResult.bind(this),
      setToolError: this.wrappedSetToolError.bind(this),
      updateToolStatus: this.params.updateToolStatus,
      updateToolCallInput: this.params.updateToolCallInput,
      context: {
        ...this.params.toolExecutionContext,
        get ideClient() {
          return instance.params.getIdeClient?.();
        },
      },
      updateAction: this.params.updateAction,
      getToolExecutions: this.params.getToolExecutions,
      onToolStreamingUpdate: emitToolStreamingUpdate,
      keypressCallbacks: this.params.keypressCallbacks,
    });

    // Update S3 logging flag from feature flag service
    this.isS3LoggingEnabledRef.current = getFlag(
      IndustryFeatureFlags.LogFailedLLMRequestsToS3
    );
  }

  // ── Initialize LLM clients (mirrors useLLMStreaming's client setup) ──

  initializeLLMClients(): boolean {
    try {
      const sessionService = getSessionService();
      const selectedModel = resolveActiveModel(sessionService);
      const customModels = getSettingsService().getCustomModels();
      const customModel = findCustomModel(selectedModel, customModels);
      const modelProvider = getTuiModelConfig(selectedModel).modelProvider;

      let isFireworksAnthropicCompat = false;
      try {
        const registryConfig = getLLMConfig({
          modelId: selectedModel as ModelID,
        });
        isFireworksAnthropicCompat =
          modelProvider === ModelProvider.INDUSTRY &&
          (registryConfig.apiProviders?.includes(ApiProvider.FIREWORKS) ??
            false) &&
          registryConfig.apiModelProvider === ModelProvider.ANTHROPIC;
      } catch {
        // custom/unknown model
      }

      // Bedrock custom models use AWS credentials (no apiKey/baseUrl on the
      // CustomModel itself). Their SDK client is constructed and cached
      // lazily by drool-core's `ensureBedrockClient` on the first streaming
      // turn via the shared `llmClientsRef` — nothing to validate or
      // prebuild here. BYOK custom models must work even when Industry auth
      // and feature-flag fetches are unavailable.
      if (isBedrockCustomModel(customModel)) {
        return true;
      }

      // Validate custom model configuration
      if (customModel) {
        if (!customModel.apiKey || customModel.apiKey.includes('YOUR_')) {
          throw new MetaError('Invalid API key for custom model', {
            value: {
              modelId: customModel.model,
              configPath: `${getIndustryDirName()}/config.json`,
              hint: 'Please replace placeholder API key with a valid API key',
            },
          });
        }
        if (!customModel.baseUrl) {
          throw new MetaError('Invalid base URL for custom model', {
            value: {
              modelId: customModel.model,
              configPath: `${getIndustryDirName()}/config.json`,
              hint: 'Please provide a valid base URL',
            },
          });
        }
      }

      const baseConfig = customModel
        ? {
            apiKey: customModel.apiKey,
            baseURL: customModel.baseUrl,
            organization: null,
            project: null,
          }
        : {
            apiKey: PROXY_API_KEY_PLACEHOLDER,
            baseURL: `${resolveCliApiBaseUrl(getRuntimeAuthConfig(), getCachedRegion())}/api/llm/${
              isFireworksAnthropicCompat
                ? 'a'
                : modelProvider === ModelProvider.OPENAI ||
                    modelProvider ===
                      ModelProvider.GENERIC_CHAT_COMPLETION_API ||
                    modelProvider === ModelProvider.INDUSTRY ||
                    modelProvider === ModelProvider.GOOGLE ||
                    modelProvider === ModelProvider.XAI
                  ? 'o/v1'
                  : 'a'
            }`,
            organization: null,
            project: null,
          };

      const apiTimeout = getSettingsService().getLlmRequestTimeout();

      const clients = this.llmClientsRef.current;
      if (isFireworksAnthropicCompat) {
        clients.anthropic = new Anthropic({
          ...baseConfig,
          timeout: apiTimeout,
        });
        clients.openai = null;
      } else if (
        modelProvider === ModelProvider.OPENAI ||
        modelProvider === ModelProvider.GENERIC_CHAT_COMPLETION_API ||
        modelProvider === ModelProvider.INDUSTRY ||
        modelProvider === ModelProvider.GOOGLE ||
        modelProvider === ModelProvider.XAI
      ) {
        clients.openai = new OpenAI({
          ...baseConfig,
          timeout: apiTimeout,
        });
        clients.anthropic = null;
      } else {
        clients.anthropic = new Anthropic({
          ...baseConfig,
          timeout: apiTimeout,
        });
        clients.openai = null;
      }

      return true;
    } catch (error) {
      logException(error, 'Failed to initialize LLM clients in AgentLoop');
      const clients = this.llmClientsRef.current;
      clients.anthropic = null;
      clients.openai = null;
      clients.bedrock = null;
      return false;
    }
  }

  // ── Wrapped tool result callbacks (forward to exec event callbacks) ──

  private wrappedUpdateToolResult(
    toolId: string,
    content: ToolResultContent
  ): void {
    const sessionId = getSessionService().getCurrentSessionId();
    const contentStr = getTextContent(content);
    const isError = contentStr.startsWith(ERROR_PREFIX);

    this.params.updateToolResult(toolId, content);

    if (sessionId) {
      const payload = {
        id: toolId,
        result: contentStr,
        isError,
        sessionId,
      };
      agentEventBus.emit(AgentEvent.ToolCallComplete, payload);

      // Emit individual tool result so the SessionStore updates incrementally.
      // Without this, tool completion only reaches the SessionStore when the
      // entire batch is persisted via appendMessage, causing all tool headers
      // to switch from shimmer (pending) to active color (complete) at once.
      this.emitIncrementalToolResult(toolId, contentStr, isError, sessionId);
    }
  }

  private wrappedSetToolError(toolId: string, error: string): void {
    const sessionId = getSessionService().getCurrentSessionId();

    this.params.setToolError(toolId, error);

    if (sessionId) {
      const errorContent = `${ERROR_PREFIX} ${error}`;
      const payload = {
        id: toolId,
        result: errorContent,
        isError: true,
        sessionId,
      };
      agentEventBus.emit(AgentEvent.ToolCallComplete, payload);

      this.emitIncrementalToolResult(toolId, errorContent, true, sessionId);
    }
  }

  /**
   * Emit an individual tool result so the SessionStore (and therefore the UI)
   * can update incrementally as each tool completes, rather than waiting for
   * the entire batch to be persisted via appendMessage.
   */
  private emitIncrementalToolResult(
    toolId: string,
    content: string,
    isError: boolean,
    sessionId: string
  ): void {
    const toolMessageId = this.params.getLastToolMessageId();
    if (!toolMessageId) return;

    agentEventBus.emit(AgentEvent.ToolResult, {
      toolUseId: toolId,
      messageId: toolMessageId,
      content,
      isError,
      sessionId,
    });
  }

  // ── Helper: persist a system message ──

  private persistSystem(
    text: string,
    visibility: MessageVisibility = MessageVisibility.Both
  ): HistoryMessage {
    return persistSystemHelper(this.params.updateAction, text, visibility);
  }

  // ── Public methods ──

  isAgentRunning(): boolean {
    return this.runningRef;
  }

  async stopAgent(): Promise<void> {
    // Prevent duplicate cancellations
    if (this.cancellationPromiseRef) {
      logInfo(
        '[Agent] stopAgent already in progress, returning existing promise'
      );
      return this.cancellationPromiseRef;
    }

    const cancellationPromise = (async () => {
      try {
        this.setIsCancelling(true);
        logInfo('[Agent] stopAgent called');
        this.llmCore.abortStreaming();
        // Abort any in-flight compaction summarization
        try {
          this.compactionAbortRef?.abort();
        } catch {
          logWarn('[Agent] Failed to abort compaction summarization');
        }

        try {
          await this.toolExecutor.cancelAllTools();
        } catch (error) {
          logWarn('[Agent] Error cancelling tools', { cause: error });
        }

        ghosttyProgressMarkError();

        const pendingToolIds = this.params.getPendingToolIds();

        if (pendingToolIds.length > 0) {
          pendingToolIds.forEach((toolId) => {
            this.wrappedSetToolError(
              toolId,
              TOOL_EXECUTION_CANCELLED_BY_USER_RESULT_TEXT
            );
          });

          // Persist tool cancellation results so the daemon emits TOOL_RESULT
          // notifications to connected TUI clients via SessionService → MessageCreated.
          const toolResults = pendingToolIds.map((toolId) => ({
            type: MessageContentBlockType.ToolResult as const,
            toolUseId: toolId,
            content: `${ERROR_PREFIX} ${TOOL_EXECUTION_CANCELLED_BY_USER_RESULT_TEXT}`,
            isError: true,
          }));
          const toolResultMessage: IndustryDroolMessage = {
            id: this.params.getLastToolMessageId() || generateUUID(),
            role: MessageRole.Tool,
            content: toolResults,
            visibility: MessageVisibility.UserOnly,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const sessionService = getSessionService();
          const sessionId = sessionService.getCurrentSessionId();
          void sessionService
            .appendMessage(toolResultMessage)
            .catch((error) => {
              logWarn('[Agent] Failed to persist cancelled tool results', {
                cause: error,
              });
            })
            .finally(() => {
              if (sessionId) {
                agentEventBus.emit(AgentEvent.ToolMessage, {
                  message: toolResultMessage,
                  sessionId,
                });
              }
            });

          this.params.updateAction({
            type: 'APPEND_TO_TOOL_RESULTS',
            content: REQUEST_INTERRUPTED_BY_USER_RESULT_TEXT,
          });

          this.persistSystem(
            REQUEST_INTERRUPTED_BY_USER_RESULT_TEXT,
            MessageVisibility.LLMOnly
          );
        } else {
          this.persistSystem(
            REQUEST_INTERRUPTED_BY_USER_RESULT_TEXT,
            MessageVisibility.LLMOnly
          );
        }
      } finally {
        // Don't clear isCancelling here - it will be cleared when ref is cleared
      }
    })();

    this.cancellationPromiseRef = cancellationPromise;

    void cancellationPromise.finally(() => {
      if (this.cancellationPromiseRef === cancellationPromise) {
        this.cancellationPromiseRef = null;
        this.setIsCancelling(false);
      }
    });

    return cancellationPromise;
  }

  async stopAgentWithTimeout(timeoutMs = 5000): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    await Promise.race([
      this.stopAgent().finally(() => {
        // Cancel the timeout if stopAgent resolves before it fires
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          logWarn('[Agent] Cancellation timeout exceeded', {
            timeout: timeoutMs,
          });
          // Clear the stale cancellation promise so future cancel attempts
          // don't return a stuck/unresolved promise
          this.cancellationPromiseRef = null;
          this.setIsCancelling(false);
          resolve();
        }, timeoutMs);
      }),
    ]);
  }

  clearConversation(): void {
    this.params.updateAction({ type: 'CLEAR_HISTORY' });
    this.setState((prev) => ({
      ...prev,
      status: {
        ...prev.status,
        lastTokenUsage: undefined,
      },
    }));
  }

  clearSummary(): void {
    this.lastSummaryRef = undefined;
    this.lastLlmSummaryRef = undefined;
  }

  loadConversationHistoryFromSession(session: DroolSession): void {
    this.params.loadConversationHistory(session.messages);
    logInfo('[Agent] Loaded session history', {
      sessionId: session.id,
      messageThreadLength: session.messages.length,
    });

    this.setState((prev) => ({
      ...prev,
      status: {
        ...prev.status,
        lastTokenUsage: undefined,
      },
    }));

    // Asynchronously load latest compaction summary
    void (async () => {
      try {
        const sessionService = getSessionService();
        const { latest, latestLlm } = await loadLastSummaryMetas(
          sessionService,
          session.id
        );
        this.lastSummaryRef = latest;
        this.lastLlmSummaryRef = latestLlm;

        if (this.lastSummaryRef) {
          logInfo('[Agent] Loaded latest compaction summary', {
            summaryMessageId: this.lastSummaryRef.id,
            index: this.lastSummaryRef.anchorIndex,
            messageId: this.lastSummaryRef.anchorId,
            tokens: this.lastSummaryRef.tokens,
            numMessagesRemoved: this.lastSummaryRef.removedCount,
            summaryKind: this.lastSummaryRef.summaryKind,
          });
        }
      } catch {
        logWarn('[Agent] Failed to load latest compaction summary');
        this.lastSummaryRef = undefined;
        this.lastLlmSummaryRef = undefined;
      }
    })();
  }

  get prepareMessagesWithCaching() {
    return this.llmCore.prepareMessagesWithCaching;
  }

  get createSystemMessage() {
    return this.llmCore.createSystemMessage;
  }

  /**
   * Resolve the display name for a model, accounting for custom/BYOK models.
   */
  private resolveModelDisplayName(model: string): string {
    const customModels = getSettingsService().getCustomModels();
    const customModel = findCustomModel(model, customModels);
    const modelConfig = getTuiModelConfig(model);
    return (
      customModel?.displayName ??
      customModel?.model ??
      modelConfig.displayName ??
      model
    );
  }

  // ── Helper for confirmation status ──

  private updateAgentStatusForConfirmation(
    hasPendingConfirmation: boolean,
    currentState: AgentStatusState
  ): void {
    if (
      hasPendingConfirmation &&
      currentState !== AgentStatusState.ToolConfirmation
    ) {
      this.setState((prev) => ({
        ...prev,
        status: {
          ...prev.status,
          state: AgentStatusState.ToolConfirmation,
        },
      }));
    } else if (
      !hasPendingConfirmation &&
      currentState === AgentStatusState.ToolConfirmation
    ) {
      this.setState((prev) => ({
        ...prev,
        status: {
          ...prev.status,
          state: AgentStatusState.ExecutingTool,
          executionStartTime: Date.now(),
        },
      }));
    }
  }

  private setAgentIdle(): void {
    this.runningRef = false;
    getSessionService().syncDroolStatusToCloud(DroolExecutionStatus.Idle, null);
  }

  // ── Token limit choice handlers ──

  async handleTokenLimitChoice(
    action: 'droolCore' | 'extraUsage' | 'openBilling' | 'cancel'
  ): Promise<void> {
    const recommendedModel = this._tokenLimitChoice?.recommendedCoreModel;
    this.setTokenLimitChoice(null);

    const message = await handleTokenLimitAction(action as TokenLimitAction, {
      recommendedCoreModel: recommendedModel,
      onMessage: (msg) => this.persistSystem(msg),
    });
    this.persistSystem(message);
  }

  dismissTokenLimitChoice(): void {
    this.setTokenLimitChoice(null);
  }

  /**
   * Run a batch of tool_use items and persist the resulting tool-result message.
   * Used both by the normal agent loop iteration and by the resume-after-interrupt
   * path, so that both flows share identical state transitions and persistence.
   */
  private async executeToolsAndPersist(
    toolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>,
    assistantMessageId: string,
    sessionId: string
  ): Promise<{
    wasCancelled: boolean;
    permissionRejected: boolean;
    shouldStopAfterTools: boolean;
    specHandoffPayload: ApprovedSpecNewSessionPayload | undefined;
  }> {
    this.setState((prev) => ({
      ...prev,
      status: {
        ...prev.status,
        state: AgentStatusState.ExecutingTool,
        executionStartTime: Date.now(),
        invokingTools: false,
      },
    }));

    getSessionController().setWorkingState(DroolWorkingState.ExecutingTool);

    const {
      results: toolResults,
      wasCancelled,
      permissionRejected,
      shouldStopAfterTools,
      specHandoffPayload,
    } = await this.toolExecutor.executeTools(toolUses, assistantMessageId);

    if (permissionRejected) {
      this._endedDueToPermissionRejection = true;
    }

    const toolResultMessage: IndustryDroolMessage = {
      id: this.params.getLastToolMessageId() || generateUUID(),
      role: MessageRole.Tool,
      content: toolResults,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    void getSessionService()
      .appendMessage(toolResultMessage, {
        compactionSummaryId: this.lastSummaryRef?.id,
      })
      .catch((error) => {
        logException(error, '[Agent] Failed to persist tool results');
      })
      .finally(() => {
        agentEventBus.emit(AgentEvent.ToolMessage, {
          message: toolResultMessage,
          sessionId,
        });
      });

    return {
      wasCancelled,
      permissionRejected,
      shouldStopAfterTools,
      specHandoffPayload,
    };
  }

  // ── Main agent loop ──

  // User-driven entry point; runs the agent loop with an explicit user message.
  async runAgentWithUserMessage(
    params: UserMessageRunParams
  ): Promise<boolean> {
    try {
      return await this.runAgentInternal({
        kind: 'user',
        userMessageRun: params,
      });
    } finally {
      this.llmCore.clearPendingAbort();
    }
  }

  private isSubagentSession(): boolean {
    const tags = getSessionService().getCurrentSessionTags?.() ?? [];
    return hasSubagentSessionTag(tags);
  }

  /**
   * Build the list of pending tool_uses that are safe to auto-resume after
   * a daemon respawn (single source of truth for the allow-list filter).
   * Tools without a known input are dropped; non-resumable tools are kept
   * in their Pending state so they are not silently lost.
   */
  private getResumablePendingToolItems(): {
    items: ResumablePendingToolItem[];
    nonResumable: Array<{ id: string; name: string }>;
  } {
    const pendingToolIds = this.params.getPendingToolIds();
    if (pendingToolIds.length === 0) {
      return { items: [], nonResumable: [] };
    }

    const toolExecutions = this.params.getToolExecutions();
    const resumable = new Set<string>(RESUMABLE_TOOL_LLM_IDS);
    const subagentResumable = new Set<string>(
      this.isSubagentSession() ? SUBAGENT_RESUMABLE_TOOL_LLM_IDS : []
    );
    const items: ResumablePendingToolItem[] = [];
    const nonResumable: Array<{ id: string; name: string }> = [];

    for (const toolId of pendingToolIds) {
      const execution = toolExecutions.get(toolId);
      const name = execution?.name;
      const canResumeSubagentPermissionTool =
        name !== undefined &&
        subagentResumable.has(name) &&
        execution?.status === ToolCallStatus.Pending;
      if (
        name &&
        (resumable.has(name) || canResumeSubagentPermissionTool) &&
        execution.input
      ) {
        items.push({
          id: toolId,
          name,
          input: execution.input as Record<string, unknown>,
        });
      } else {
        nonResumable.push({ id: toolId, name: name ?? '<unknown>' });
      }
    }

    return { items, nonResumable };
  }

  /** Resume pending allow-listed elicitation tools after a daemon respawn. */
  async resumeLoop(): Promise<boolean> {
    try {
      const { items, nonResumable } = this.getResumablePendingToolItems();

      if (nonResumable.length > 0) {
        logInfo(
          '[Agent] Leaving non-resumable orphan tool_uses in Pending state on resume',
          {
            count: nonResumable.length,
            toolIds: nonResumable.map((t) => t.name),
          }
        );
      }

      if (items.length === 0) {
        return true;
      }

      logInfo('[Agent] Resuming pending resumable tools', {
        count: items.length,
        toolIds: items.map((t) => t.name),
      });

      // Avoid re-playing the awaiting-input sound for auto-resumed prompts.
      this.toolExecutor.setSuppressNextAwaitingSound(true);

      return await this.runAgentInternal({
        kind: 'resume',
        pendingToolUseItems: items,
      });
    } finally {
      this.llmCore.clearPendingAbort();
    }
  }

  // Shared loop used by user-message and resume entry points.
  // Private so callers must go through runAgentWithUserMessage() or resumeLoop()
  // and cannot accidentally trigger a resume by calling a no-arg public method.
  private async runAgentInternal(mode: RunAgentMode): Promise<boolean> {
    const userMessageRun = mode.kind === 'user' ? mode.userMessageRun : null;

    const message = userMessageRun?.message ?? '';
    const images = userMessageRun?.images;
    const additionalContentBlocks = userMessageRun?.additionalContentBlocks;
    const files = userMessageRun?.files;
    const hookContext = userMessageRun?.hookContext;
    const messageId = userMessageRun?.messageId;
    const requestId = userMessageRun?.requestId;
    const role = userMessageRun?.role;
    const visibility = userMessageRun?.visibility;
    let userMessageSource = userMessageRun?.userMessageSource;
    // Resume runs skip user-message insertion to preserve tool_use/tool_result pairing.
    const skipUserMessageInsertion = mode.kind === 'resume';

    this._endedDueToPermissionRejection = false;

    if (this.runningRef) {
      logException(
        new MetaError('Concurrent runAgent invocation prevented'),
        '[Agent] runAgent called while another run is in-flight'
      );
      return false;
    }

    // Cached billing-limits fetch, populated by the mission gate below and
    // reused by the 402-fallback snapshot later in this method to avoid a
    // duplicate `/api/billing/limits` request per turn.
    let billingLimitsRaw: BillingLimitsFetchResult | null = null;

    // Enforce mission access policy before any LLM work.
    // Checked on every turn so that mid-session policy changes take effect
    // and resumed mission sessions are also gated.
    {
      const svc = getSessionService();
      const tags = svc.getCurrentSessionTags?.();
      if (
        svc.isMissionMode() ||
        isMissionOrchestratorSession(tags) ||
        isMissionWorkerSession(tags)
      ) {
        const policy =
          getSettingsService().getSettings().general?.missionPolicy;
        if (policy?.restrictedAccess) {
          const user = await getAuthedUser(getRuntimeAuthConfig());
          const allowedUserIds = policy.allowedUserIds ?? [];
          if (!user?.userId || !allowedUserIds.includes(user.userId)) {
            // Surface as a UserOnly system message (same pattern used for
            // LLM/API errors below) so it renders inline in the chat log
            // instead of flowing through the ERROR notification path.
            this.persistSystem(
              'Missions have been restricted by your organization admin. Contact your admin to request access.',
              MessageVisibility.UserOnly
            );
            return false;
          }
        }

        billingLimitsRaw = await fetchBillingLimitsRaw();
        const overageStatus = deriveOveragePreferenceStatus(billingLimitsRaw);
        const overageBlockMessage =
          getMissionOveragePreferenceBlockMessage(overageStatus);
        if (overageBlockMessage) {
          this.persistSystem(overageBlockMessage, MessageVisibility.UserOnly);
          return false;
        }
      }
    }

    this.runningRef = true;

    getSessionService().syncDroolStatusToCloud(
      DroolExecutionStatus.Running,
      process.pid
    );

    const telemetryClient = CliTelemetryClient.getInstance();

    // Initialize LLM clients before each run
    const isInitialized = this.initializeLLMClients();
    // Update S3 logging flag
    this.isS3LoggingEnabledRef.current = getFlag(
      IndustryFeatureFlags.LogFailedLLMRequestsToS3
    );

    if (!isInitialized) {
      const errorMsg = getI18n().t('errors:agent.initFailed');
      this.setState((prev) => ({
        ...prev,
        error: errorMsg,
      }));
      this.persistSystem(errorMsg, MessageVisibility.UserOnly);
      this.setAgentIdle();
      telemetryClient.setModelId(null);
      return true;
    }

    // Airgap mode forbids hitting Industry's LLM proxy. If the resolved model
    // is not BYOK (custom:*), refuse to start the turn with a clear hint to
    // switch models, instead of letting the SDK leak a request to the proxy.
    {
      const runtimeAuthCfg = getRuntimeAuthConfig();
      if (runtimeAuthCfg.airgapEnabled) {
        const sessionSvc = getSessionService();
        // Use the per-turn resolved model (spec mode can override the
        // session model) so a Industry-routed spec model can't slip past the
        // preflight and a BYOK spec override isn't wrongly refused.
        const { modelSetting: turnModelId } =
          resolveTurnModelContext(sessionSvc);
        const isBYOK = turnModelId?.startsWith('custom:') ?? false;
        if (!isBYOK) {
          const errorMsg = `Airgap Mode is enabled. Model "${turnModelId ?? 'default'}" routes through Industry's LLM proxy and cannot be used. Configure a BYOK custom model in settings.json to continue. See https://docs.example.com/cli/byok/overview`;
          this.setState((prev) => ({ ...prev, error: errorMsg }));
          this.persistSystem(errorMsg, MessageVisibility.UserOnly);
          this.setAgentIdle();
          telemetryClient.setModelId(null);
          this.runningRef = false;
          return true;
        }
      }
    }

    this.setState((prev) => ({
      ...prev,
      status: {
        ...prev.status,
        state: AgentStatusState.Thinking,
        toolUseCount: 0,
        invokingTools: false,
      },
      error: null,
    }));
    ghosttyProgressStartIndeterminate();

    let wasCancelled = false;
    let progressOutcome: 'success' | 'cancelled' | 'error' | null = null;
    let structuredOutputRetryCount = 0;
    const structuredOutputMessages: IndustryDroolMessage[] = [];

    const sessionService = getSessionService();
    let isSpecMode = sessionService.isSpecMode();
    let { modelSetting, modelConfig, provider, reasoningEffort } =
      resolveTurnModelContext(sessionService);
    // Industry Router resolves its concrete model in primeForMessage() below;
    // until then resolveActiveModel() returns the default placeholder.
    const isUnprimedIndustryRouterTurn =
      sessionService.getDisplayActiveModel() === INDUSTRY_ROUTER_MODEL_ID &&
      sessionService.getEffectiveIndustryRouterModel() === undefined;
    // Before priming resolves the routed pick, report the router pseudo-model
    // rather than the placeholder default so first-turn telemetry/logs aren't
    // misattributed to the fallback model. The post-prime re-sync below
    // re-points telemetry at the concrete routed model.
    const prePrimeModelId = isUnprimedIndustryRouterTurn
      ? INDUSTRY_ROUTER_MODEL_ID
      : modelSetting;

    let errorMessage: string | null = null;

    // Snapshots used by the 402 → Drool Core auto-swap path below.
    let overagePreferenceSnapshot: 'droolCore' | 'extraUsage' | null = null;
    let recommendedCoreModelSnapshot: string | null = null;
    // One-shot per runAgent so a 402 from the core model can't loop.
    let hasAttemptedDroolCoreFallback = false;

    let shouldContinueFromStopHook = false;
    let stopHookReasonToInject: string | null = null;
    let queuedEndOfLoopMessage: UserMessageRunParams | null = null;
    let shouldSkipEndOfLoopQueueDrain = false;
    let todoCompletionReminderSent = false;
    let consecutiveNoOutputTurns = 0;

    const settingsService = getSettingsService();
    const _settings = settingsService.getSettings();
    const isQueuedMessagesEnabled = isQueuedMessagesFeatureEnabled();

    const agentRunStartTime = Date.now();

    try {
      const isFirstMessage = this.params.isConversationEmpty();

      let sessionId = sessionService.getCurrentSessionId();
      if (!sessionId) {
        sessionId = await sessionService.createNewSession({
          firstUserMessage: message,
        });
      }

      telemetryClient.setModelId(prePrimeModelId);

      if (isFirstMessage) {
        logInfo('[Agent] Agent session started', {
          sessionId,
          modelId: prePrimeModelId,
          isByok: prePrimeModelId.startsWith('custom:') ? 'true' : 'false',
          isSpecMode,
        });
      }

      // Defer the lock until the router picks a concrete model; locking the
      // placeholder default would later read as a provider switch.
      if (!isUnprimedIndustryRouterTurn) {
        ensureProviderLocks({
          sessionService,
          provider,
          modelId: modelConfig.modelId,
          isCustomModel: modelConfig.isCustom,
        });
      }

      // Refresh latest compaction summary
      try {
        const { latest, latestLlm } = await loadLastSummaryMetas(
          sessionService,
          sessionId
        );
        this.lastSummaryRef = latest;
        this.lastLlmSummaryRef = latestLlm;
      } catch {
        // ignore
      }

      const batchActions: StateAction[] = [];

      const resolvedIdeState = this.params.getIdeState?.();

      const hasRealSelection =
        resolvedIdeState?.activeFileSelection != null &&
        resolvedIdeState.activeFileSelection.selectedText.length > 0;
      const shouldIncludeIdeContext =
        resolvedIdeState?.activeFile &&
        (resolvedIdeState.activeFile.path !== this.lastActiveFileRef ||
          hasRealSelection);

      const contextMessageContent: ContentBlock[] = [];
      const userMessageContent: ContentBlock[] = [];

      const isSessionResume = sessionService.checkAndClearWasSessionResumed();
      const needsSystemInfoRefresh =
        sessionService.checkAndClearSystemInfoRefreshNeeded();
      const rawHistoryForReminders = this.params.getConversationHistory();
      const isSubagent = this.isSubagentSession();
      let currentDeferredToolsReminder = '';
      let currentConnectorInstructionsReminder = '';
      let currentConnectorConnectivityReminder: string | null = null;

      // Inject a pre-turn reminder block only when it is non-empty and not
      // already present in the history after the last summary. Used by the
      // connector-tools reminders below.
      const pushReminderIfNew = (reminder: string): void => {
        if (
          reminder &&
          !historyContainsReminderAfterSummary(
            rawHistoryForReminders,
            reminder,
            this.lastSummaryRef
          )
        ) {
          contextMessageContent.push({
            type: MessageContentBlockType.Text,
            text: reminder,
          });
        }
      };

      try {
        // Delivered transiently per request via ensureRemindersVisible at the
        // send sites below. Not persisted into history: as tools load the list
        // shrinks and the text changes, so a persisted copy would leave stale
        // reminders that list already-loaded tools as deferred and prompt
        // redundant ToolSearch calls.
        currentDeferredToolsReminder =
          await buildDeferredToolsReminderForSession(sessionId);
      } catch (error) {
        logWarn('[Agent] Failed to build deferred tools reminder', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      try {
        const connectorReminder =
          await buildConnectorToolsReminderForSession(sessionId);
        if (connectorReminder) {
          currentConnectorInstructionsReminder = connectorReminder.instructions;
          currentConnectorConnectivityReminder = connectorReminder.connectivity;
          // Instructions are stable and dedup by exact text. The connectivity
          // reminder is persisted here too (when its state is new) so the
          // durable transcript records it; the request-assembly prune below
          // guarantees only the latest state is ever shown to the model.
          pushReminderIfNew(currentConnectorInstructionsReminder);
          if (currentConnectorConnectivityReminder) {
            pushReminderIfNew(currentConnectorConnectivityReminder);
          }
        }
      } catch (error) {
        logWarn('[Agent] Failed to build connector tools reminder', {
          errorMessage:
            error instanceof Error ? error.message : 'Unknown error',
        });
      }

      const currentDate = new Date();
      const currentDateReminder = formatCurrentDateReminder(currentDate);
      if (
        !isSubagent &&
        !historyContainsCurrentDateReminderAfterSummary(
          rawHistoryForReminders,
          this.lastSummaryRef,
          currentDate
        )
      ) {
        contextMessageContent.push({
          type: MessageContentBlockType.Text,
          text: currentDateReminder,
        });
      }

      if (isFirstMessage || isSessionResume || needsSystemInfoRefresh) {
        try {
          const skillsReminder = formatAvailableSkillsReminder(
            await getAvailableSkillsForReminder()
          );
          if (
            skillsReminder &&
            !rawHistoryForReminders.some((msg) =>
              messageContainsText(msg, skillsReminder)
            )
          ) {
            contextMessageContent.push({
              type: MessageContentBlockType.Text,
              text: skillsReminder,
            });
          }
        } catch (error) {
          logWarn('[Agent] Failed to build skills reminder', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      if (isFirstMessage || isSessionResume || needsSystemInfoRefresh) {
        try {
          const customModels = getSettingsService().getCustomModels();
          const customModel = findCustomModel(modelSetting, customModels);
          const modelName = this.resolveModelDisplayName(
            sessionService.getDisplayActiveModel()
          );

          if (isFirstMessage && customModel) {
            const providerWarning = validateByokProviderConfig(customModel);
            if (providerWarning) {
              this.persistSystem(
                getI18n().t('errors:agent.errorPrefix', {
                  message: providerWarning,
                })
              );
            }
          }

          let systemNotificationContent: string;
          // Use full system info (with AGENTS.md guidelines) for first messages.
          // When the TUI pre-creates a session on disk and the daemon child loads
          // it, both isFirstMessage and isSessionResume can be true simultaneously.
          // Prioritize isFirstMessage to ensure guidelines are always included on
          // the first user message, even if the session was technically "resumed".
          if (isSessionResume && !isFirstMessage && !needsSystemInfoRefresh) {
            const resumeSystemInfo = await getResumeSystemInfo();
            systemNotificationContent = formatResumeSystemReminder(
              resumeSystemInfo,
              modelName
            );
          } else {
            // Use a full refresh after cwd changes so the next turn sees the new
            // repo state, guidelines, drools, and tool context immediately.
            logInfo('[Agent] Collecting system info for first message', {
              cwd: process.cwd(),
              isInitial: isFirstMessage,
              refreshCache: needsSystemInfoRefresh,
            });
            const systemInfo = needsSystemInfoRefresh
              ? await getSystemInfo()
              : await prefetchSystemInfo();
            logInfo('[Agent] System info collected', {
              hasState: (systemInfo.guidelinesInfo ?? []).length > 0,
              count: (systemInfo.guidelinesInfo ?? []).length,
            });
            systemNotificationContent = formatSystemReminder(
              systemInfo,
              modelName,
              sessionService.getCurrentSessionTags(),
              sessionService.getCurrentSessionOrigin()
            );
          }
          contextMessageContent.push({
            type: MessageContentBlockType.Text,
            text: systemNotificationContent,
          });
        } catch (systemReminderError) {
          logException(
            systemReminderError,
            '[Agent] Failed to generate system reminder (AGENTS.md may not be ingested)'
          );
        }
      }

      const existingTodos = sessionService.getLatestTodoState();

      if (
        !isSubagent &&
        (!existingTodos || !existingTodos?.todos?.todos?.length) &&
        !rawHistoryForReminders.some((msg) =>
          messageContainsText(msg, TODO_WRITE_NOT_CALLED_REMINDER)
        )
      ) {
        contextMessageContent.push({
          type: MessageContentBlockType.Text,
          text: wrapInSystemReminder(TODO_WRITE_NOT_CALLED_REMINDER),
        });
      } else if (existingTodos && hasPendingTodos(existingTodos.todos)) {
        const toolCallsSinceLastTodo = countToolCallsSinceLastTodoWrite(
          rawHistoryForReminders
        );

        if (toolCallsSinceLastTodo >= TODO_STALE_THRESHOLD) {
          contextMessageContent.push({
            type: MessageContentBlockType.Text,
            text: wrapInSystemReminder(
              `IMPORTANT: Your todo list has pending items but hasn't been updated in the last ${toolCallsSinceLastTodo} tool calls. Please review and update the todo list status to reflect your current progress.`
            ),
          });
        }
      }

      if (shouldIncludeIdeContext && resolvedIdeState?.activeFile) {
        this.lastActiveFileRef = resolvedIdeState.activeFile.path;
        const ideContextMessage = formatIdeContextMessage(
          resolvedIdeState.activeFile,
          resolvedIdeState.activeFileSelection
        );
        contextMessageContent.push({
          type: MessageContentBlockType.Text,
          text: wrapInSystemReminder(`\n${ideContextMessage}\n`),
        });
      }

      try {
        const fileChangeReminder = await formatFileChangeReminder();
        if (fileChangeReminder) {
          contextMessageContent.push({
            type: MessageContentBlockType.Text,
            text: wrapInSystemReminder(`\n${fileChangeReminder}\n`),
          });
        }
      } catch (error) {
        logWarn('[useAgent] Failed to check for file changes', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // Add worktree context reminder if running in a worktree
      const worktreeInfo = getExecRuntimeConfig().getWorktreeInfo();
      if (worktreeInfo) {
        contextMessageContent.push({
          type: MessageContentBlockType.Text,
          text: wrapInSystemReminder(
            `\n${formatWorktreeReminder(worktreeInfo)}\n`
          ),
        });
      }

      const isSpecModeActive = getSessionService().isSpecMode();
      const isMissionModeActive = getSessionService().isMissionMode();

      if (isSpecModeActive && !isMissionModeActive) {
        const currentModelConfig = getTuiModelConfig(
          getSessionService().getModel()
        );
        const isNonOpenAI =
          currentModelConfig.modelProvider !== ModelProvider.OPENAI;

        // AskUser is always enabled outside of ACP mode.
        const isAskUserEnabled = !getDroolRuntimeService().isAcpMode();

        contextMessageContent.push({
          type: MessageContentBlockType.Text,
          text: wrapInSystemReminder(
            buildSpecModeReminder({ isAskUserEnabled, isNonOpenAI })
          ),
        });
      }

      let missionFileServiceForNotice:
        | ReturnType<typeof getMissionFileService>
        | undefined;
      let pendingCanonicalArtifactLayoutNotice: ArtifactLayoutMarker | null =
        null;
      if (
        isMissionOrchestratorSession(sessionService.getCurrentSessionTags?.())
      ) {
        contextMessageContent.push({
          type: MessageContentBlockType.Text,
          text: wrapInSystemReminder(
            'REMINDER: You are the orchestrator. Your role is to plan, design worker systems, and steer execution. Do NOT implement code yourself. When the user asks for changes or fixes, utilize workers to perform the implementations. Focus on high-level planning, task delegation, and steering the mission to success.'
          ),
        });

        try {
          const missionSessionId =
            getSessionService().getDecompMissionId() ?? sessionId;
          const missionFileService = getMissionFileService(missionSessionId);
          missionFileServiceForNotice = missionFileService;

          if (mode.kind === 'user') {
            try {
              await missionFileService.ensurePlanningState(process.cwd());
            } catch (error) {
              logException(
                error,
                '[Agent] Failed to persist planning mission artifacts'
              );
            }
          }

          const missionArtifactsExist =
            await missionFileService.hasMissionArtifacts();
          if (missionArtifactsExist) {
            const missionDir = missionFileService.getMissionDir();
            contextMessageContent.push({
              type: MessageContentBlockType.Text,
              text: wrapInSystemReminder(
                `MISSION CONTEXT: The current mission directory is ${missionDir}. All mission artifacts (features.json, AGENTS.md, etc.) are located there.`
              ),
            });
            pendingCanonicalArtifactLayoutNotice =
              await missionFileService.getPendingCanonicalArtifactLayoutNotice();
            if (pendingCanonicalArtifactLayoutNotice) {
              contextMessageContent.push({
                type: MessageContentBlockType.Text,
                text: wrapInSystemReminder(
                  buildCanonicalArtifactLayoutNotice({
                    marker: pendingCanonicalArtifactLayoutNotice,
                    missionDir,
                  })
                ),
              });
            }

            // If the last StartMissionRun was cancelled (paused), inject resume context
            const rawHistory = this.params.getConversationHistory();
            if (wasLastStartMissionRunCancelled(rawHistory)) {
              try {
                const [state, interruptedWorkerSessionId, handoffResult] =
                  await Promise.all([
                    missionFileService.readState(),
                    missionFileService.getInterruptedWorkerSessionId(),
                    collectAndMarkNewWorkerHandoffs({ missionFileService }),
                  ]);
                if (state?.state === MissionState.Paused) {
                  const inProgressFeature =
                    await missionFileService.getInProgressFeature();
                  contextMessageContent.push({
                    type: MessageContentBlockType.Text,
                    text: getMissionPausedReminder(
                      interruptedWorkerSessionId,
                      inProgressFeature,
                      handoffResult.workerHandoffs
                    ),
                  });
                }
              } catch (error) {
                logWarn('[Agent] Failed to build paused mission reminder', {
                  cause: error,
                });
              }
            }
          }
        } catch (error) {
          logWarn('[Agent] Failed to inject mission context', {
            cause: error,
          });
        }
      }

      userMessageContent.push(
        ...buildUserMessageContentBlocks({
          text: message,
          images: convertAttachmentsToBase64Images(images),
          files,
        })
      );

      try {
        const cwd = process.cwd();
        const reminders = await buildTaggedPathReminderBlocks(message, cwd);
        if (reminders.length) {
          contextMessageContent.push(...reminders);
          logInfo('[Agent] Injected tagged path reminders', {
            count: reminders.length / 2,
          });
        }
      } catch (e) {
        logWarn('[Agent] Failed injecting tagged-file reminders', {
          error: e,
        });
      }

      if (additionalContentBlocks && additionalContentBlocks.length > 0) {
        userMessageContent.push(...additionalContentBlocks);
        logInfo('[Agent] Injected additional content blocks', {
          count: additionalContentBlocks.length,
        });
      }

      const freshSettings = getSettingsService();
      Metrics.addToCounter(Metric.CLI_USER_MESSAGE_COUNT, 1, {
        reasoningEffort,
        autoAcceptRiskLevel: freshSettings.getAutonomyLevel(),
        modelId: prePrimeModelId,
      });

      const userMessageId = messageId ?? generateUUID();
      const contextMessageId =
        contextMessageContent.length > 0
          ? `context-${userMessageId}`
          : undefined;

      const conversationHistory = this.params.getConversationHistory();
      const messageIndex =
        conversationHistory.length + (contextMessageId ? 1 : 0);
      const snapshotService = getFileSnapshotService();
      snapshotService.setMessageContext(userMessageId, messageIndex);

      if (isFirstMessage) {
        const sessionStartContext =
          sessionService.consumePendingSessionStartContext();
        if (sessionStartContext) {
          batchActions.push({
            type: 'ADD_MESSAGE',
            role: MessageRole.System,
            content: sessionStartContext,
            options: { visibility: MessageVisibility.LLMOnly },
          });
          logInfo('[Agent] Injected SessionStart hook context', {
            sessionId,
            length: sessionStartContext.length,
          });
        }
      }

      if (hookContext) {
        batchActions.push({
          type: 'ADD_MESSAGE',
          role: MessageRole.System,
          content: hookContext,
          options: { visibility: MessageVisibility.LLMOnly },
        });
        logInfo('[Agent] Injected UserPromptSubmit hook context', {
          sessionId,
          length: hookContext.length,
        });
      }

      // Resume runs apply non-user actions but do not append a user message.
      if (skipUserMessageInsertion) {
        if (batchActions.length > 0) {
          this.params.updateAction(batchActions);
        }
      } else {
        if (contextMessageId) {
          batchActions.push({
            type: 'ADD_CONTEXT_MESSAGE',
            id: contextMessageId,
            content: contextMessageContent,
          });
        }

        batchActions.push({
          type: 'ADD_USER_MESSAGE',
          content: userMessageContent,
          id: userMessageId,
          role: (role as MessageRole) ?? MessageRole.User,
          ...(visibility && {
            visibility: visibility as MessageVisibility,
          }),
        });

        this.params.updateAction(batchActions);
        if (
          pendingCanonicalArtifactLayoutNotice &&
          missionFileServiceForNotice
        ) {
          try {
            await missionFileServiceForNotice.markCanonicalArtifactLayoutNoticeShown();
          } catch (error) {
            logWarn(
              '[Agent] Failed to mark canonical artifact layout notice shown',
              {
                cause: error,
              }
            );
          }
        }

        const userMessageToEmit = {
          id: userMessageId,
          role: (role as MessageRole) ?? MessageRole.User,
          content: userMessageContent,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(userMessageSource ? { userMessageSource } : {}),
          ...(visibility && {
            visibility: visibility as MessageVisibility,
          }),
        };

        const parentId = sessionService.getParentMessageId() ?? undefined;
        const contextMessageToPersist: IndustryDroolMessage | null =
          contextMessageId
            ? {
                id: contextMessageId,
                role: MessageRole.User,
                content: contextMessageContent,
                visibility: MessageVisibility.LLMOnly,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              }
            : null;

        const persistContextMessage = contextMessageToPersist
          ? sessionService.appendMessage(contextMessageToPersist, {
              compactionSummaryId: this.lastSummaryRef?.id,
            })
          : Promise.resolve();

        void persistContextMessage
          .then(() =>
            sessionService.appendMessage(userMessageToEmit, {
              compactionSummaryId: this.lastSummaryRef?.id,
              requestId,
            })
          )
          .then(() => {
            if (
              isFirstMessage &&
              !sessionService.isSessionTitleManuallySet(sessionId)
            ) {
              void sessionService
                .generateSessionTitle(message)
                .then((title) => {
                  if (title) {
                    agentEventBus.emit(AgentEvent.SessionTitleUpdated, {
                      sessionId,
                      title,
                      updateType: SessionTitleUpdateType.FirstUserMessage,
                    });
                  }

                  if (sessionService.isCurrentSessionBtwFork) {
                    return null;
                  }

                  return generateAndUpdateSessionTitle({
                    sessionId,
                    stage: SessionTitleAutoStage.FirstMessage,
                    firstUserText: message,
                  });
                })
                .then((title) => {
                  if (title) {
                    agentEventBus.emit(AgentEvent.SessionTitleUpdated, {
                      sessionId,
                      title,
                      updateType: SessionTitleUpdateType.LlmGenerated,
                    });
                  }
                })
                .catch((error) => {
                  logException(
                    error,
                    '[SessionTitle] Failed to generate first-message title'
                  );
                });
            }
          })
          .catch((error) => {
            logException(error, '[Agent] Failed to persist submitted messages');
          })
          .finally(() => {
            const payload = {
              message: { ...userMessageToEmit, parentId },
              sessionId,
              requestId,
            };
            agentEventBus.emit(AgentEvent.UserMessage, payload);
          });
      }

      // In-memory read on the ConversationStateManager (not disk) —
      // can't reuse the snapshot above because `updateAction(
      // [ADD_USER_MESSAGE, ...])` mutated the manager between the two
      // reads, and the classifier needs to see the just-submitted turn.
      await sessionService.primeForMessage({
        conversationHistory: this.params.getConversationHistory(),
        sessionId,
        routing: buildCliModelRoutingDeps(),
      });

      // Re-resolve against the routed model and apply the deferred lock now
      // that priming has populated the concrete pick.
      if (isUnprimedIndustryRouterTurn) {
        ({ modelSetting, modelConfig, provider, reasoningEffort } =
          resolveTurnModelContext(sessionService));
        telemetryClient.setModelId(modelSetting);
        ensureProviderLocks({
          sessionService,
          provider,
          modelId: modelConfig.modelId,
          isCustomModel: modelConfig.isCustom,
        });
      }

      let systemMessage = await this.llmCore.createSystemMessage();
      let lastEffectiveIndustryRouterModelId =
        sessionService.getEffectiveIndustryRouterModel()?.modelId;

      const summarizeCore = createSummarizer();
      const summarize: SummarizeFn = async (args) => {
        this.setState((prev) => ({
          ...prev,
          status: {
            ...prev.status,
            state: AgentStatusState.Compressing,
          },
        }));
        try {
          return await summarizeCore(args);
        } finally {
          this.setState((prev) => ({
            ...prev,
            status: {
              ...prev.status,
              state: AgentStatusState.Thinking,
            },
          }));
        }
      };

      const runCompaction = async (
        reason: 'context_limit' | 'threshold',
        compactionParams: {
          conversationHistory: IndustryDroolMessage[];
          systemMessage: TextBlock[];
          allTools: Anthropic.Tool[];
          sessionId: string;
          contextLimitFallbackModelId?: string;
        }
      ) => {
        getSessionController().setWorkingState(
          DroolWorkingState.CompactingConversation
        );

        telemetryClient.setCompactionReason(reason);
        const compactionStart = performance.now();
        logInfo('[Compaction] Start (agent)', {
          eventType: 'compaction',
          state: 'start',
          reason,
          source: 'agent',
        });
        let compactionSystemInfo: SystemInfo | undefined;
        try {
          compactionSystemInfo = await getSystemInfo();
        } catch (e) {
          logException(e, '[Agent] Failed to fetch system info for compaction');
        }
        const controller = new AbortController();
        this.compactionAbortRef = controller;
        let compactionSucceeded = false;
        try {
          const summarizeForCompaction: SummarizeFn =
            compactionParams.contextLimitFallbackModelId
              ? (args) =>
                  summarize({
                    ...args,
                    contextLimitFallbackModelId:
                      compactionParams.contextLimitFallbackModelId,
                  })
              : summarize;
          const result = await compactConversation({
            messages: compactionParams.conversationHistory,
            system: compactionParams.systemMessage,
            tools: compactionParams.allTools,
            sessionId: compactionParams.sessionId,
            summarize: summarizeForCompaction,
            lastSummary: this.lastLlmSummaryRef,
            systemInfo: compactionSystemInfo,
            signal: controller.signal,
          });

          logInfo('[Agent] Compaction result', {
            numMessagesRemoved: result.removedCount,
            tokens: result.newSummaryTokens ?? 0,
          });

          if (result.removedCount > 0) {
            this.llmCore.resetPromptCacheSnapshot(compactionParams.sessionId);
          }

          this.params.addMessage(
            MessageRole.System,
            getI18n().t('common:compaction.notice'),
            {
              messageType: MessageType.Text,
              visibility: MessageVisibility.UserOnly,
            }
          );

          if (
            result.newSummaryText &&
            typeof result.newSummaryAnchorIndex === 'number'
          ) {
            const uiRenderCutoffSourceHistory =
              this.params.getRawConversationHistory();
            const uiRenderCutoffMessageId = deriveUiRenderCutoffMessageId(
              uiRenderCutoffSourceHistory
            );

            const compactionSummaryId = sessionService.saveCompactionSummary({
              summaryText: result.newSummaryText,
              summaryTokens: result.newSummaryTokens ?? 0,
              summaryKind: CompactionSummaryKind.LlmSummary,
              anchorMessage: {
                id: result.newSummaryAnchorId,
                index: result.newSummaryAnchorIndex,
              },
              removedCount: result.removedCount,
              systemInfo: compactionSystemInfo,
              uiRenderCutoffMessageId,
            });

            if (uiRenderCutoffMessageId && this.params.setUiRenderCutoff) {
              this.params.setUiRenderCutoff(uiRenderCutoffMessageId);
              logInfo('[Agent] Applied UI render cutoff after compaction', {
                cutoffMessageId: uiRenderCutoffMessageId,
                count: compactionParams.conversationHistory.length,
              });
            }

            agentEventBus.emit(AgentEvent.SessionCompacted, {
              sessionId: compactionParams.sessionId,
              visibleBoundaryMessageId: uiRenderCutoffMessageId ?? null,
              summaryId: compactionSummaryId,
              removedCount: result.removedCount,
            });

            this.lastSummaryRef = {
              id: compactionSummaryId,
              text: result.newSummaryText,
              anchorId: result.newSummaryAnchorId,
              anchorIndex: result.newSummaryAnchorIndex,
              tokens: result.newSummaryTokens ?? 0,
              removedCount: result.removedCount,
              systemInfo: compactionSystemInfo,
              summaryKind: CompactionSummaryKind.LlmSummary,
            };
            this.lastLlmSummaryRef = this.lastSummaryRef;
          }
          const compactionDurationMs = performance.now() - compactionStart;
          logInfo('[Compaction] End (agent succeeded)', {
            eventType: 'compaction',
            state: 'end',
            reason,
            source: 'agent',
            succeeded: true,
            compactionDurationMs,
            numMessagesRemoved: result.removedCount,
            summaryOutputTokens: result.newSummaryTokens ?? 0,
          });
          compactionSucceeded = true;
          return result;
        } catch (error) {
          const compactionDurationMs = performance.now() - compactionStart;
          if (isAbortError(error)) {
            logInfo('[Compaction] End (agent aborted)', {
              eventType: 'compaction',
              state: 'end',
              reason,
              source: 'agent',
              succeeded: false,
              abortReason: 'user_interrupt',
              compactionDurationMs,
            });
          } else {
            logException(error, '[Compaction] End (agent error)', {
              eventType: 'compaction',
              state: 'end',
              reason,
              source: 'agent',
              succeeded: false,
              compactionDurationMs,
              ...(extractEmptyResponseTelemetry(error) ?? {}),
            });
          }
          throw error;
        } finally {
          this.compactionAbortRef = null;
          telemetryClient.clearCompactionReason();

          if (compactionSucceeded) {
            getSessionController().setWorkingState(
              DroolWorkingState.StreamingAssistantMessage
            );
          }
        }
      };

      // Snapshot overage preference + recommended core model for the
      // 402 fallback path (see runAgent-scoped vars above).
      // Reuse the billing-limits result fetched by the mission gate when
      // available so we don't hit `/api/billing/limits` twice per turn.
      try {
        const tokenLimitResult = billingLimitsRaw
          ? await deriveTokenLimitChoice(billingLimitsRaw)
          : await fetchTokenLimits();
        if (tokenLimitResult.type === 'choice') {
          overagePreferenceSnapshot =
            tokenLimitResult.choice.overagePreference ?? null;
          recommendedCoreModelSnapshot =
            tokenLimitResult.choice.recommendedCoreModel ?? null;
        }
      } catch (error) {
        logWarn('[Agent] Failed to snapshot overage preference', {
          cause: error,
        });
      }

      // Resume pending allow-listed tool_uses before making another LLM call.
      // The resumeLoop() entry point pre-filters via getResumablePendingToolItems(),
      // so we trust its output as the single source of truth.
      let resumeFromPendingTools = false;
      let pendingToolUseItems: ResumablePendingToolItem[] = [];
      let resumeAssistantMessageId = '';
      if (mode.kind === 'resume' && mode.pendingToolUseItems.length > 0) {
        // Find the assistant message that originally requested these tools
        const history = this.params.getConversationHistory();
        for (let i = history.length - 1; i >= 0; i--) {
          const msg = history[i];
          if (
            msg.role === 'assistant' &&
            Array.isArray(msg.content) &&
            msg.content.some((b) => isToolUseBlock(b))
          ) {
            resumeAssistantMessageId = msg.id;
            break;
          }
        }

        pendingToolUseItems = mode.pendingToolUseItems;
        resumeFromPendingTools = true;
        logInfo(
          '[Agent] Detected pending tools from interrupted session, will resume execution',
          {
            count: pendingToolUseItems.length,
            toolIds: pendingToolUseItems.map((t) => t.name),
          }
        );
      }

      // Agent loop
      while (true) {
        try {
          // Resolve every message, not once per turn: messages added mid-turn
          // (by the user or a tool) can require a different model. The cached
          // classification makes this a cheap no-op unless a change is needed.
          await sessionService.primeForMessage({
            conversationHistory: this.params.getConversationHistory(),
            sessionId,
            routing: buildCliModelRoutingDeps(),
          });

          const currentEffectiveIndustryRouterModelId =
            sessionService.getEffectiveIndustryRouterModel()?.modelId;
          if (
            currentEffectiveIndustryRouterModelId !==
            lastEffectiveIndustryRouterModelId
          ) {
            systemMessage = await this.llmCore.createSystemMessage();
            lastEffectiveIndustryRouterModelId =
              currentEffectiveIndustryRouterModelId;
          }

          // Resume interrupted tool execution: skip LLM call, re-execute
          // the pending tools, persist results, and continue the loop.
          if (resumeFromPendingTools) {
            resumeFromPendingTools = false;

            const {
              wasCancelled: toolExecCancelled,
              shouldStopAfterTools,
              specHandoffPayload,
            } = await this.executeToolsAndPersist(
              pendingToolUseItems,
              resumeAssistantMessageId,
              sessionId
            );

            if (toolExecCancelled) {
              progressOutcome = 'cancelled';
              break;
            }

            if (shouldStopAfterTools) {
              if (specHandoffPayload) {
                this._pendingSpecHandoff = specHandoffPayload;
              }
              progressOutcome = 'success';
              break;
            }

            // Tools completed, set state to Thinking and continue to LLM call
            this.setState((prev) => ({
              ...prev,
              status: {
                ...prev.status,
                state: AgentStatusState.Thinking,
              },
            }));
            getSessionController().setWorkingState(
              DroolWorkingState.StreamingAssistantMessage
            );
            continue;
          }

          const previousModelSetting = modelSetting;
          isSpecMode = getSessionService().isSpecMode();
          modelSetting = resolveActiveModel(sessionService);
          reasoningEffort =
            isSpecMode && sessionService.hasSpecModeModel()
              ? sessionService.getSpecModeReasoningEffort()
              : sessionService.getReasoningEffort();

          if (
            previousModelSetting &&
            modelSetting &&
            previousModelSetting !== modelSetting
          ) {
            const previousProvider =
              getTuiModelConfig(previousModelSetting).modelProvider;
            const newProvider = getTuiModelConfig(modelSetting).modelProvider;

            if (previousProvider !== newProvider) {
              logInfo(
                '[Agent] Provider changed during agent loop, serializing conversation',
                {
                  previousModelId: previousModelSetting,
                  modelId: modelSetting,
                  fromApiProvider: previousProvider,
                  toApiProvider: newProvider,
                }
              );

              const currentHistory = this.params.getConversationHistory();

              if (
                !isAnchoredAtLastMessage(
                  this.lastSummaryRef,
                  currentHistory.length
                )
              ) {
                const newSummary = await serializeAndPersistForProviderSwitch(
                  sessionService,
                  {
                    sessionId,
                    messages: currentHistory,
                  }
                );

                if (newSummary) {
                  this.lastSummaryRef = newSummary;
                  // Treat provider-switch serialization as a valid baseline
                  // for subsequent compaction so it won't select a suffix
                  // that straddles the provider-switch boundary.
                  this.lastLlmSummaryRef = newSummary;
                  logInfo(
                    '[Agent] Serialized conversation for provider switch',
                    {
                      tokens: newSummary.tokens,
                      adjustedIndex: newSummary.anchorIndex,
                    }
                  );
                }
              }

              sessionService.updateLockedModelProvider(newProvider);
            }
          }

          const rawHistory = this.params.getConversationHistory();
          const allTools = await this.llmCore.getAllTools(sessionId);

          const transformedHistory = applyOutputTransforms([
            ...rawHistory,
            ...structuredOutputMessages,
          ]);
          const historyWithSummary = ensureRemindersVisible(
            pruneStaleConnectivityReminders(
              attachExistingSummary({
                messages: transformedHistory,
                lastSummary: this.lastSummaryRef && {
                  text: this.lastSummaryRef.text,
                  anchorId: this.lastSummaryRef.anchorId,
                  anchorIndex: this.lastSummaryRef.anchorIndex,
                  systemInfo: this.lastSummaryRef.systemInfo,
                  summaryKind: this.lastSummaryRef.summaryKind,
                },
              })
            ),
            [
              currentDeferredToolsReminder,
              currentConnectorInstructionsReminder,
              ...(currentConnectorConnectivityReminder
                ? [currentConnectorConnectivityReminder]
                : []),
            ]
          );
          let cachedHistory: IndustryDroolMessageWithCaching[] =
            this.llmCore.prepareMessagesWithCaching(historyWithSummary);
          cachedHistory = maybeInjectUpgradeNudges(cachedHistory);

          // Snapshot loop-mutable variables so the closure below is safe.
          const currentModel = modelSetting;
          const currentSpecMode = isSpecMode;
          // Router attribution for the persisted assistant message: set when
          // the active slot is router-configured, so `currentModel` is a
          // routed pick rather than a direct user choice.
          const currentRouterId =
            sessionService.getDisplayActiveModel() === INDUSTRY_ROUTER_MODEL_ID
              ? INDUSTRY_ROUTER_MODEL_ID
              : undefined;
          let currentReasoningEffort = reasoningEffort;
          const currentOutputFormat = userMessageRun?.outputFormat;
          const currentSystemMessage: TextBlock[] = currentOutputFormat
            ? [
                ...systemMessage,
                {
                  type: MessageContentBlockType.Text,
                  text: buildStructuredOutputInstruction(currentOutputFormat),
                },
              ]
            : systemMessage;

          // Helper to create a doSend with the shared params for this iteration,
          // varying only the conversation history and S3 logging flag.
          const makeDoSend = (
            history: IndustryDroolMessageWithCaching[],
            allowContextLimitS3Logging: boolean
          ) =>
            createDoSendFunction({
              conversationHistory: history,
              systemMessage: currentSystemMessage,
              sessionId,
              sendMessage: this.llmCore.sendMessage,
              setState: this.setState.bind(this),
              startAssistantMessage: this.params.startAssistantMessage,
              appendAssistantText: this.params.appendAssistantText,
              updateToolCallInput: this.params.updateToolCallInput,
              updateThinkingBlock: this.params.updateThinkingBlock,
              appendThinkingDelta: this.params.appendThinkingDelta,
              markThinkingComplete: this.params.markThinkingComplete,
              markTextComplete: this.params.markTextComplete,
              finalizeAssistantMessage: this.params.finalizeAssistantMessage,
              finalizeContentBlocks: this.params.finalizeContentBlocks,
              addToolCall: this.params.addToolCall,
              addReasoningBlock: this.params.addReasoningBlock,
              addChatCompletionReasoning:
                this.params.addChatCompletionReasoning,
              allowContextLimitS3Logging,
              clearUnfinishedToolCallInvocations:
                this.params.clearUnfinishedToolCallInvocations,
              onReasoningEffortChange: (_from, to) => {
                currentReasoningEffort = to;
                if (currentSpecMode && sessionService.hasSpecModeModel()) {
                  sessionService.setSpecModeReasoningEffort(to);
                } else {
                  sessionService.setReasoningEffort(to);
                }
              },
              modelId: currentModel,
              isSpecMode: currentSpecMode,
              reasoningEffort: currentReasoningEffort,
              outputFormat: currentOutputFormat,
            });

          // Diagnostic fingerprint of exactly what is about to be sent to the
          // provider. Captured so the "agent answered an older turn" class of
          // bug can be root-caused from logs alone: it records whether the
          // latest user turn is still the tail of the outbound history and how
          // large the sent context is relative to the model's hard window.
          // Pair with `[Agent] Streaming result` (provider-reported input) to
          // tell client-side drops from server-side truncation apart.
          {
            let estimatedChars = 0;
            let lastUserMessageId: string | undefined;
            for (const m of cachedHistory) {
              estimatedChars += m.openaiEncryptedContent?.length ?? 0;
              for (const block of m.content) {
                estimatedChars += estimateContentBlockChars(block);
              }
              if (m.role === MessageRole.User) {
                lastUserMessageId = m.id;
              }
            }
            let outboundMaxInputTokens: number | undefined;
            try {
              outboundMaxInputTokens = getLLMModel({
                modelId: currentModel as ModelID,
                reasoningEffort: currentReasoningEffort,
              }).maxInputTokens;
            } catch {
              // Custom/unknown model not in the registry - no static limit
              outboundMaxInputTokens = undefined;
            }
            const lastMessage = cachedHistory.at(-1);
            logInfo('[Agent] Outbound request prepared', {
              sessionId,
              modelId: currentModel,
              messageCount: cachedHistory.length,
              lastUserMessageId,
              lastMessageId: lastMessage?.id,
              lastMessageRole: lastMessage?.role,
              totalEstimatedTokens: approxTokensFromChars(estimatedChars),
              maxInputTokens: outboundMaxInputTokens,
            });
          }

          const { doSend, assistantMessageId } = makeDoSend(
            cachedHistory,
            false
          );

          let assistantMessageIdForPersistence = assistantMessageId;

          let streamingResult: StreamingResult;
          try {
            streamingResult = await doSend();
          } catch (err) {
            if (getIndustryDisplayable402Body(err) !== null) {
              // Industry-displayable 402: try a transparent Drool Core
              // auto-swap. Eligibility (overage preference, recommended
              // core model, eligible slot) is enforced inside the util.
              const swapResult = await attemptDroolCoreFallback402({
                sessionId,
                sessionService,
                overagePreferenceSnapshot,
                recommendedCoreModelSnapshot,
                hasAttemptedDroolCoreFallback,
                persistSystem: (text, messageVisibility) =>
                  this.persistSystem(text, messageVisibility),
              });
              if (swapResult.didSwap) {
                hasAttemptedDroolCoreFallback = true;
                // Leave `modelSetting` unchanged so the next iteration
                // hits the provider-switch path when the new core
                // model is on a different provider.
                continue;
              }
              // Unrecoverable 402: when this is a mission worker session,
              // signal the MissionRunner so it can auto-pause the mission
              // instead of treating the imminent process exit as a generic
              // failure that gets requeued and re-spawned in a tight loop.
              await signalUnrecoverable402ToMission({
                sessionService,
                reason:
                  err instanceof Error
                    ? `Unrecoverable 402: ${err.message}`
                    : 'Unrecoverable 402: usage limit reached',
              });
              throw err;
            } else if (isThinkingSignatureError(err)) {
              // Recover from signature errors by stripping problematic
              // thinking blocks and retrying once.
              logWarn(
                '[Agent] Thinking signature error, stripping blocks and retrying',
                {
                  error: err instanceof Error ? err.message : 'Unknown',
                }
              );
              const failedRequestMessageCount = cachedHistory.length;
              const recovery = this.llmCore.prepareMessagesWithCaching(
                historyWithSummary,
                {
                  signatureRecovery: {
                    error: err,
                    requestMessageCount: failedRequestMessageCount,
                  },
                  returnMetadata: true,
                }
              );
              cachedHistory = recovery.messages;
              const { doSend: retryDoSend, assistantMessageId: retryMsgId } =
                makeDoSend(cachedHistory, true);
              assistantMessageIdForPersistence = retryMsgId;
              streamingResult = await retryDoSend();

              const newSummary =
                recovery.strippedCount > 0
                  ? persistSignatureRecoveryBoundary(sessionService, {
                      rawHistory,
                      cleanedHistoryWithSummary: recovery.sourceMessages,
                      lastStrippedMessageIndex:
                        recovery.lastStrippedMessageIndex,
                      lastSummary: this.lastSummaryRef,
                    })
                  : undefined;
              if (newSummary) {
                this.lastSummaryRef = newSummary;
                this.lastLlmSummaryRef = newSummary;
              }

              logInfo('[Agent] Recovered from thinking signature error', {
                redactedCount: recovery.strippedCount,
              });
            } else if (!isContextLimitError(err)) {
              throw err;
            } else {
              const contextLimitFallbackModelId =
                getContextLimitCompactionFallbackModel(currentModel);
              if (contextLimitFallbackModelId) {
                logInfo(
                  '[Agent] Context-limit compaction will retry with Drool Core fallback model if needed',
                  { modelId: contextLimitFallbackModelId }
                );
              }

              const compactionResult = await runCompaction('context_limit', {
                conversationHistory: transformedHistory,
                systemMessage,
                allTools,
                sessionId,
                ...(contextLimitFallbackModelId
                  ? { contextLimitFallbackModelId }
                  : {}),
              });

              cachedHistory = this.llmCore.prepareMessagesWithCaching(
                ensureRemindersVisible(
                  pruneStaleConnectivityReminders(compactionResult.compacted),
                  [
                    currentDeferredToolsReminder,
                    currentConnectorInstructionsReminder,
                    ...(currentConnectorConnectivityReminder
                      ? [currentConnectorConnectivityReminder]
                      : []),
                  ]
                )
              );
              const { doSend: retryDoSend, assistantMessageId: retryMsgId } =
                makeDoSend(cachedHistory, true);
              assistantMessageIdForPersistence = retryMsgId;
              streamingResult = await retryDoSend();
            }
          }

          const usageInputTokens = streamingResult.usage?.inputTokens ?? 0;
          const usageCacheReadInputTokens =
            streamingResult.usage?.cacheReadInputTokens ?? 0;
          logInfo('[Agent] Streaming result', {
            count: usageInputTokens,
            // Explicit, unambiguous token accounting so server-side input
            // truncation is detectable from logs: `totalInputTokens` (what the
            // provider actually processed) can be compared against the
            // `totalEstimatedTokens` we logged in "Outbound request prepared".
            inputTokens: usageInputTokens,
            cacheReadInputTokens: usageCacheReadInputTokens,
            totalInputTokens: usageInputTokens + usageCacheReadInputTokens,
            reasoningTokens: streamingResult.usage?.thinkingTokens ?? 0,
            contextCount: streamingResult.usage?.cacheCreationInputTokens ?? 0,
            outputTokens: streamingResult.usage?.outputTokens ?? 0,
            reason: streamingResult.stopReason,
            hasReasoningContent:
              !!streamingResult.openaiEncryptedContent &&
              streamingResult.openaiEncryptedContent?.length > 0,
          });

          if (streamingResult.wasAborted) {
            wasCancelled = true;
            progressOutcome = 'cancelled';
            break;
          }

          const hasModelToolUse = streamingResult.toolUses.length > 0;
          const structuredOutputResult =
            userMessageRun?.outputFormat && !hasModelToolUse
              ? validateStructuredOutputText(
                  streamingResult.content.trim(),
                  userMessageRun.outputFormat
                )
              : undefined;

          if (structuredOutputResult && !structuredOutputResult.ok) {
            if (
              structuredOutputRetryCount < MAX_STRUCTURED_OUTPUT_RETRIES &&
              userMessageRun?.outputFormat
            ) {
              structuredOutputRetryCount++;
              structuredOutputMessages.push(
                buildStructuredOutputRetryMessage({
                  candidate: streamingResult.content,
                  errorMessage: structuredOutputResult.message,
                  outputFormat: userMessageRun.outputFormat,
                })
              );
              this.setState((prev) => ({
                ...prev,
                status: {
                  ...prev.status,
                  state: AgentStatusState.Thinking,
                },
              }));
              getSessionController().setWorkingState(
                DroolWorkingState.StreamingAssistantMessage
              );
              continue;
            }

            throw new StructuredOutputError(structuredOutputResult);
          }

          const toolUsesForPersistence = streamingResult.toolUses;

          const totalTokensForUsage = computeLastCallCompactionTokens({
            inputTokens: streamingResult.usage?.inputTokens ?? 0,
            outputTokens: streamingResult.usage?.outputTokens ?? 0,
            cacheReadTokens: streamingResult.usage?.cacheReadInputTokens ?? 0,
          });
          this.setState((prev) => ({
            ...prev,
            status: {
              ...prev.status,
              lastTokenUsage: totalTokensForUsage,
            },
          }));

          const assistantContent: ContentBlock[] = structuredOutputResult?.ok
            ? [
                {
                  type: MessageContentBlockType.Text,
                  text: JSON.stringify(structuredOutputResult?.value),
                },
              ]
            : streamingResult.contentBlocks &&
                streamingResult.contentBlocks.length > 0
              ? convertStreamingBlocksToContentBlocks(
                  streamingResult.contentBlocks,
                  toolUsesForPersistence
                )
              : buildFallbackContentBlocks(
                  { ...streamingResult, toolUses: toolUsesForPersistence },
                  provider
                );

          if (assistantContent.length > 0) {
            if (streamingResult.thinkingContent) {
              logInfo(
                '[Agent] Persisting assistant message with thinking block'
              );
            }

            const assistantMessage: IndustryDroolMessage = {
              id: assistantMessageIdForPersistence,
              role: MessageRole.Assistant,
              content: assistantContent,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              modelId: currentModel,
              ...(currentRouterId ? { routerId: currentRouterId } : {}),
              reasoningEffort: currentReasoningEffort,
              ...(userMessageSource ? { userMessageSource } : {}),
              ...(streamingResult.openaiEncryptedContent && {
                openaiEncryptedContent: streamingResult.openaiEncryptedContent,
              }),
              ...(streamingResult.openaiReasoningId && {
                openaiReasoningId: streamingResult.openaiReasoningId,
              }),
              ...(streamingResult.openaiReasoningSummary && {
                openaiReasoningSummary: streamingResult.openaiReasoningSummary,
              }),
              ...(streamingResult.chatCompletionReasoningField && {
                chatCompletionReasoningField:
                  streamingResult.chatCompletionReasoningField,
              }),
              ...(streamingResult.chatCompletionReasoningContent && {
                chatCompletionReasoningContent:
                  streamingResult.chatCompletionReasoningContent,
              }),
              ...(streamingResult.openaiMessageId && {
                openaiMessageId: streamingResult.openaiMessageId,
              }),
              ...(streamingResult.openaiPhase !== undefined && {
                openaiPhase: streamingResult.openaiPhase,
              }),
            };

            if (streamingResult.openaiMessageId) {
              logInfo(
                '[Agent] Including openai message id in persisted message'
              );
            }

            const assistantParentId =
              sessionService.getParentMessageId() ?? undefined;

            const assistantCallbackPayload = {
              message: {
                ...assistantMessage,
                parentId: assistantParentId,
              },
              sessionId,
              parentId: assistantParentId,
            } as const;

            agentEventBus.emit(
              AgentEvent.AssistantMessage,
              assistantCallbackPayload
            );

            void sessionService
              .appendMessage(assistantMessage, {
                compactionSummaryId: this.lastSummaryRef?.id,
              })
              .catch((error) => {
                logException(
                  error,
                  '[Agent] Failed to persist assistant message'
                );
              });

            if (structuredOutputResult?.ok) {
              agentEventBus.emit(AgentEvent.ProjectNotification, {
                notification: {
                  type: SessionNotificationType.STRUCTURED_OUTPUT,
                  messageId: assistantMessage.id,
                  structuredOutput: structuredOutputResult.value,
                },
              });
            }
          }

          const hasToolUse = toolUsesForPersistence.length > 0;

          let toolWasCancelled = false;

          if (hasToolUse) {
            const {
              wasCancelled: toolExecCancelled,
              shouldStopAfterTools,
              specHandoffPayload,
            } = await this.executeToolsAndPersist(
              toolUsesForPersistence,
              assistantMessageIdForPersistence,
              sessionId
            );

            toolWasCancelled = toolExecCancelled;

            if (toolWasCancelled) {
              if (getDroolRuntimeService().isNonInteractiveCLIMode()) {
                const autonomyMode =
                  getSessionService().getCurrentAutonomyMode();
                const t = getI18n().t;
                let guidance = t('common:execMode.guidanceDefault');
                if (autonomyMode === AutonomyMode.AutoLow) {
                  guidance = t('common:execMode.guidanceLow');
                } else if (autonomyMode === AutonomyMode.AutoMedium) {
                  guidance = t('common:execMode.guidanceMedium');
                } else if (autonomyMode === AutonomyMode.AutoHigh) {
                  guidance = t('common:execMode.guidanceHigh');
                } else if (autonomyMode === AutonomyMode.Spec) {
                  guidance = t('common:execMode.guidanceSpec');
                }
                const finalMsg = t('common:execMode.insufficientPermission', {
                  guidance,
                });
                this.params.addMessage(MessageRole.Assistant, finalMsg);
                const finalMessage: IndustryDroolMessage = {
                  id: generateUUID(),
                  role: MessageRole.Assistant,
                  content: [
                    {
                      type: MessageContentBlockType.Text,
                      text: finalMsg,
                    },
                  ],
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  ...(userMessageSource ? { userMessageSource } : {}),
                };

                const finalParentId =
                  sessionService.getParentMessageId() ?? undefined;

                const finalAssistantPayload = {
                  message: {
                    ...finalMessage,
                    parentId: finalParentId,
                  },
                  sessionId,
                  parentId: finalParentId,
                } as const;

                agentEventBus.emit(
                  AgentEvent.AssistantMessage,
                  finalAssistantPayload
                );

                void sessionService
                  .appendMessage(finalMessage, {
                    compactionSummaryId: this.lastSummaryRef?.id,
                  })
                  .catch((error) => {
                    logException(
                      error,
                      '[Agent] Failed to persist final assistant message after early exit'
                    );
                  });
              }
              progressOutcome = 'cancelled';
              break;
            }

            if (shouldStopAfterTools) {
              if (specHandoffPayload) {
                this._pendingSpecHandoff = specHandoffPayload;
              }
              progressOutcome = 'success';
              break;
            }
          }

          // Compaction threshold check
          if (
            !toolWasCancelled &&
            getSessionService().getCompactionThresholdCheckEnabled()
          ) {
            const compactionTokenLimit =
              getSettingsService().getCompactionTokenLimitForModel(
                modelSetting
              );
            let modelMaxInputTokens: number | undefined;
            try {
              modelMaxInputTokens = getLLMModel({
                modelId: modelSetting as ModelID,
                reasoningEffort: currentReasoningEffort,
              }).maxInputTokens;
            } catch {
              // Custom/unknown model not in the registry - no static limit
              modelMaxInputTokens = undefined;
            }
            // Always-on record of the auto-compaction decision inputs. Surfaces
            // the failure mode where a user-raised compaction limit is clamped
            // to the model's hard window (limit === maxInputTokens), so
            // threshold compaction can never fire and the session runs
            // permanently at the context ceiling.
            logInfo('[Agent] Compaction threshold check', {
              sessionId,
              modelId: modelSetting,
              tokens: totalTokensForUsage,
              limit: compactionTokenLimit,
              maxInputTokens: modelMaxInputTokens,
              state:
                totalTokensForUsage > compactionTokenLimit ? 'over' : 'under',
            });
            if (totalTokensForUsage <= compactionTokenLimit) {
              if (
                this.thresholdCompactionSuppressionRef?.sessionId ===
                  sessionId &&
                this.thresholdCompactionSuppressionRef.modelId ===
                  modelSetting &&
                this.thresholdCompactionSuppressionRef.limit ===
                  compactionTokenLimit
              ) {
                this.thresholdCompactionSuppressionRef = null;
              }
            } else if (
              this.thresholdCompactionSuppressionRef?.sessionId === sessionId &&
              this.thresholdCompactionSuppressionRef.modelId === modelSetting &&
              this.thresholdCompactionSuppressionRef.limit ===
                compactionTokenLimit
            ) {
              logInfo(
                '[Agent] Skipping threshold compaction after previous threshold compaction did not lower usage below limit',
                {
                  tokens: totalTokensForUsage,
                  limit: compactionTokenLimit,
                }
              );
            } else {
              logInfo('[Agent] Compaction triggered', {
                tokens: totalTokensForUsage,
              });
              const freshTransformedHistory = applyOutputTransforms(
                this.params.getConversationHistory()
              );

              try {
                await runCompaction('threshold', {
                  conversationHistory: freshTransformedHistory,
                  systemMessage,
                  allTools,
                  sessionId,
                });
              } catch (compactionError) {
                // A refusal is deterministic for this transcript (the
                // summarizer already tried its fallback), so don't re-attempt
                // and re-fail on every subsequent turn.
                if (isContentModerationError(compactionError)) {
                  this.thresholdCompactionSuppressionRef = {
                    sessionId,
                    modelId: modelSetting,
                    limit: compactionTokenLimit,
                  };
                }
                throw compactionError;
              }
              this.thresholdCompactionSuppressionRef = {
                sessionId,
                modelId: modelSetting,
                limit: compactionTokenLimit,
              };
            }
          }

          // Drain queued user messages
          if (hasToolUse && this.params.drainAllQueuedUserMessages) {
            const drained = await this.params.drainAllQueuedUserMessages();
            if (drained && drained.length > 0) {
              for (const {
                text,
                images: pendingImages,
                files: pendingFiles,
                messageId: drainedMessageId,
                role: drainedRole,
                visibility: drainedVisibility,
                requestId: drainedRequestId,
                userMessageSource: drainedUserMessageSource,
              } of drained) {
                userMessageSource = mergeUserMessageSourceForTurn(
                  userMessageSource,
                  drainedUserMessageSource
                );
                const contentBlocks = buildUserMessageContentBlocks({
                  text,
                  images: convertAttachmentsToBase64Images(pendingImages),
                  files: pendingFiles,
                  trimText: true,
                  includeEmptyText: false,
                });

                if (contentBlocks.length > 0) {
                  const queuedMessageId = drainedMessageId ?? generateUUID();
                  this.params.updateAction({
                    type: 'ADD_USER_MESSAGE',
                    content: contentBlocks,
                    id: queuedMessageId,
                    role: (drainedRole as MessageRole) ?? MessageRole.User,
                    ...(drainedVisibility && {
                      visibility: drainedVisibility as MessageVisibility,
                    }),
                  });

                  const drainedMessage: IndustryDroolMessage = {
                    id: queuedMessageId,
                    role: (drainedRole as MessageRole) ?? MessageRole.User,
                    content: contentBlocks,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    ...(drainedVisibility && {
                      visibility: drainedVisibility as MessageVisibility,
                    }),
                    ...(drainedUserMessageSource
                      ? { userMessageSource: drainedUserMessageSource }
                      : {}),
                  };

                  const drainedParentId =
                    sessionService.getParentMessageId() ?? undefined;

                  void sessionService
                    .appendMessage(drainedMessage, {
                      compactionSummaryId: this.lastSummaryRef?.id,
                      requestId: drainedRequestId,
                    })
                    .catch((error) => {
                      logException(
                        error,
                        '[Agent] Failed to persist drained queued user messages'
                      );
                    })
                    .finally(() => {
                      const payload = {
                        message: {
                          ...drainedMessage,
                          parentId: drainedParentId,
                        },
                        sessionId,
                        requestId: drainedRequestId,
                      };
                      agentEventBus.emit(AgentEvent.UserMessage, payload);
                    });
                }
              }
            }
          }

          if (!hasToolUse) {
            const rawTrimmedLen = streamingResult.content.trim().length;
            const visibleLen = getVisibleAssistantText(
              streamingResult.content
            ).length;
            if (visibleLen > 0) {
              // Visible output is real progress, so the no-output run is
              // broken — only back-to-back no-output turns should count toward
              // the cap, even across continuation branches (incomplete-stop and
              // the todo-completion reminder) that `continue` after output.
              consecutiveNoOutputTurns = 0;
            }

            if (shouldContinueFromIncompleteStop(streamingResult.stopReason)) {
              logInfo(
                '[Agent] Response ended before completion, continuing agent loop',
                {
                  reason: streamingResult.stopReason,
                }
              );
              this.persistSystem(
                'Your previous response ended before completion. Continue where you left off.',
                MessageVisibility.LLMOnly
              );
              this.setState((prev) => ({
                ...prev,
                status: {
                  ...prev.status,
                  state: AgentStatusState.Thinking,
                },
              }));
              continue;
            }

            if (visibleLen === 0) {
              // Anti-runaway: after a Todo reminder nudge, treat *truly empty*
              // content as "model has nothing left to say" and exit cleanly.
              // Thinking-tag-only content (rawTrimmedLen > 0) must still
              // continue, otherwise CL-452 silent-completion regresses on the
              // post-reminder turn.
              if (todoCompletionReminderSent && rawTrimmedLen === 0) {
                progressOutcome = 'success';
                break;
              }

              consecutiveNoOutputTurns += 1;
              if (consecutiveNoOutputTurns >= MAX_CONSECUTIVE_NO_OUTPUT_TURNS) {
                logWarn(
                  '[Agent] Stopping run after consecutive no-output turns',
                  { count: consecutiveNoOutputTurns }
                );
                this.persistSystem(
                  'The model produced several consecutive responses with no visible output and no tool calls, so the agent stopped to avoid consuming the session without making progress. Send a new message to continue.',
                  MessageVisibility.UserOnly
                );
                progressOutcome = 'success';
                break;
              }

              logInfo(
                '[Agent] Response had no visible output, continuing agent loop',
                {
                  length: rawTrimmedLen,
                }
              );
              this.persistSystem(
                wrapInSystemReminder('Continue.'),
                MessageVisibility.LLMOnly
              );
              this.setState((prev) => ({
                ...prev,
                status: {
                  ...prev.status,
                  state: AgentStatusState.Thinking,
                },
              }));
              continue;
            }

            const latestTodoState = sessionService.getLatestTodoState();
            if (
              latestTodoState &&
              shouldSendTodoCompletionReminder(
                latestTodoState,
                todoCompletionReminderSent
              )
            ) {
              todoCompletionReminderSent = true;
              this.persistSystem(
                wrapInSystemReminder(
                  formatTodoCompletionReminder(latestTodoState.todos)
                ),
                MessageVisibility.LLMOnly
              );
              this.setState((prev) => ({
                ...prev,
                status: {
                  ...prev.status,
                  state: AgentStatusState.Thinking,
                },
              }));
              continue;
            }

            progressOutcome = 'success';

            break;
          } else {
            // A tool call is real progress, so the no-output run is broken.
            consecutiveNoOutputTurns = 0;
            this.setState((prev) => ({
              ...prev,
              status: {
                ...prev.status,
                state: AgentStatusState.Thinking,
              },
            }));
            // After tool execution, tell the client we're back to streaming
            // so the UI transitions out of "Executing" before the next LLM
            // turn's thinking/text deltas arrive.
            getSessionController().setWorkingState(
              DroolWorkingState.StreamingAssistantMessage
            );
          }
        } catch (error) {
          if (isAbortError(error)) {
            wasCancelled = true;
            progressOutcome = 'cancelled';
            this.persistSystem(ABORT_NOTICE_TEXT, MessageVisibility.UserOnly);
            break;
          }
          throw error;
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Prefer typed `.status`; fall back to a leading "402 " to avoid
      // matching mid-message substrings.
      const isPaymentRequired402 =
        (error as { status?: number })?.status === 402 ||
        /^402\b/.test(errorMessage);
      const errorName = error instanceof Error ? error.name : undefined;

      if (error instanceof HookStopError || errorName === 'HookStopError') {
        shouldSkipEndOfLoopQueueDrain = true;
        this.params.addMessage(
          MessageRole.System,
          getI18n().t('common:appMessages.executionStoppedByHook', {
            message: errorMessage,
          }),
          { visibility: MessageVisibility.UserOnly }
        );
        ghosttyProgressMarkError();
        this.setAgentIdle();
        telemetryClient.setModelId(null);
        this.setState((prev) => ({
          ...prev,
          status: {
            ...prev.status,
            executionStartTime: undefined,
            state: AgentStatusState.Idle,
          },
        }));
        return true;
      }

      if (error instanceof AgentAbortError || errorName === 'AgentAbortError') {
        shouldSkipEndOfLoopQueueDrain = true;
        this.params.addMessage(
          MessageRole.System,
          getI18n().t('common:appMessages.agentAbortedByHook', {
            message: errorMessage,
          }),
          { visibility: MessageVisibility.UserOnly }
        );
        ghosttyProgressMarkError();
        this.setAgentIdle();
        telemetryClient.setModelId(null);
        this.setState((prev) => ({
          ...prev,
          status: {
            ...prev.status,
            executionStartTime: undefined,
            state: AgentStatusState.Idle,
          },
        }));
        return true;
      }

      if (errorMessage.includes('Request was aborted')) {
        logWarn('[Agent] Request was aborted by user', {
          cause: error,
        });
      } else if (
        !modelConfig.isCustom &&
        (error instanceof AuthenticationError ||
          errorMessage.includes('authenticated'))
      ) {
        logWarn('[Agent] Request failed due to authentication error', {
          cause: error,
        });
      } else if (!modelConfig.isCustom && isPaymentRequired402) {
        logWarn('[Agent] Request failed due to payment required', {
          cause: error,
        });
      } else {
        logAgentException(error, '[Agent] runAgent error', {
          severity: 'severe',
          modelId: modelSetting,
        });
      }

      this.setState((prev) => ({
        ...prev,
        error: errorMessage,
      }));
      ghosttyProgressMarkError();
      progressOutcome = 'error';

      const currentSessionId = getSessionService().getCurrentSessionId();
      if (currentSessionId) {
        agentEventBus.emit(AgentEvent.AgentError, {
          error,
          sessionId: currentSessionId,
        });
      }

      if (isOverloadedError(error)) {
        this.persistSystem(
          getI18n().t('errors:agent.overloaded'),
          MessageVisibility.UserOnly
        );
      } else if (isContentModerationError(error)) {
        this.params.discardInFlightAssistantMessage?.();
        const refusal =
          error instanceof LLMContentModerationError ? error : undefined;
        logWarn('[Agent] Refusal surfaced to user', {
          modelId: modelSetting,
          refusalCategory: refusal?.refusalCategory,
          refusalExplanation: refusal?.refusalExplanation,
          source: 'agent_loop',
        });
        this.persistSystem(
          getI18n().t('errors:agent.contentModeration'),
          MessageVisibility.UserOnly
        );
      } else if (
        isCorporateFirewallError(error) ||
        isDnsOrConnectionError(error) ||
        isTlsCertificateError(error)
      ) {
        let host = 'api.example.com';
        if (modelConfig.isCustom) {
          const byokModel = findCustomModel(
            modelSetting,
            getSettingsService().getCustomModels()
          );
          if (byokModel?.baseUrl) {
            try {
              host = new URL(byokModel.baseUrl).hostname;
            } catch {
              host = getI18n().t('errors:agent.networkEndpointFallback');
            }
          } else {
            host = getI18n().t('errors:agent.networkEndpointFallback');
          }
        }

        const networkMessage = getI18n().t(getNetworkErrorKey(error), {
          host,
        });
        this.persistSystem(networkMessage, MessageVisibility.UserOnly);
      } else if (
        !modelConfig.isCustom &&
        (error instanceof AuthenticationError ||
          errorMessage.includes('authenticated'))
      ) {
        this.persistSystem(getAuthErrorMessage(), MessageVisibility.UserOnly);
      } else if (isTimeoutError(error)) {
        this.persistSystem(
          'The AI model timed out. Please retry or switch models with /model.',
          MessageVisibility.UserOnly
        );
      } else if (
        errorMessage.includes('Connection error') ||
        errorMessage.includes('fetch')
      ) {
        this.persistSystem(
          getI18n().t('errors:agent.networkError', {
            message: errorMessage,
          }),
          MessageVisibility.UserOnly
        );
      } else if (modelConfig.isCustom) {
        const statusMatch = errorMessage.match(/^(\d{3})\s/);
        const statusCode = statusMatch ? statusMatch[1] : undefined;
        const upstreamDetail =
          (error as { error?: { detail?: string } })?.error?.detail ??
          (error as { error?: { message?: string } })?.error?.message;
        const detailSuffix = upstreamDetail
          ? `\n\nUpstream error: ${upstreamDetail}`
          : '';
        const mcpServerNames = Object.keys(
          getMcpServiceIfCreated()?.listServers() ?? {}
        )
          .sort()
          .join(', ');

        if (statusCode === '402') {
          this.persistSystem(
            getI18n().t('errors:agent.byokError402', {
              errorMessage,
              detailSuffix,
            }),
            MessageVisibility.UserOnly
          );
        } else if (
          isToolSchemaCompatibilityError(error) &&
          mcpServerNames.length > 0
        ) {
          this.persistSystem(
            getI18n().t('errors:agent.byokErrorMcpToolSchema', {
              message: errorMessage,
              detailSuffix,
              serverNames: mcpServerNames,
            }),
            MessageVisibility.UserOnly
          );
        } else if (statusCode === '400') {
          this.persistSystem(
            getI18n().t('errors:agent.byokError400', {
              message: errorMessage,
              detailSuffix,
            }),
            MessageVisibility.UserOnly
          );
        } else {
          this.persistSystem(
            getI18n().t('errors:agent.byokErrorGeneric', {
              message: errorMessage,
              detailSuffix,
            }),
            MessageVisibility.UserOnly
          );
        }
      } else if (errorMessage.includes('invalid_request_error')) {
        const validationMatch = errorMessage.match(
          /messages\.\d+\.content\.\d+: (.+)/
        );
        if (validationMatch) {
          this.persistSystem(
            getI18n().t('errors:agent.apiValidationErrorSpecific', {
              detail: validationMatch[1],
            }),
            MessageVisibility.UserOnly
          );
        } else {
          this.persistSystem(
            getI18n().t('errors:agent.apiValidationErrorGeneric', {
              message: errorMessage,
            }),
            MessageVisibility.UserOnly
          );
        }
      } else if (isPaymentRequired402) {
        // Render the backend's `detail` verbatim when it set
        // `displayToUser: true`; otherwise (e.g. BYOK upstream billing)
        // surface the raw error text.
        const industryBody = getIndustryDisplayable402Body(error);
        if (industryBody) {
          this.persistSystem(
            getI18n().t('errors:agent.tokenLimitReachedDetail', {
              detail: industryBody.detail,
            }),
            MessageVisibility.UserOnly
          );
        } else {
          this.persistSystem(
            getI18n().t('errors:agent.errorPrefix', {
              message: errorMessage,
            }),
            MessageVisibility.UserOnly
          );
        }
      } else {
        this.persistSystem(
          getI18n().t('errors:agent.errorPrefix', {
            message: errorMessage,
          }),
          MessageVisibility.UserOnly
        );
      }
      telemetryClient.setModelId(null);
    } finally {
      if (wasCancelled) {
        progressOutcome = 'cancelled';
      }

      Metrics.addToCounter(Metric.AGENT_PROGRESS_COUNT, 1, {
        outcome: progressOutcome || undefined,
        isSpecMode,
        modelId: modelSetting,
        modelProvider: provider,
        reasoningEffort,
        ...(errorMessage ? { errorMessage } : {}),
      });

      if (progressOutcome === 'error' || progressOutcome === 'cancelled') {
        ghosttyProgressMarkError();
      } else {
        ghosttyProgressClear();
      }
      if (wasCancelled) {
        // Persist cancellation context for the LLM (not shown to user)
        this.persistSystem(
          getI18n().t('common:appMessages.requestCancelledByUser'),
          MessageVisibility.LLMOnly
        );
      }

      const isDaemonSilenced = process.env.DROOL_DISABLE_SOUNDS === 'true';
      if (!wasCancelled && !isDaemonSilenced) {
        // No-op in daemon mode (no callback registered).
        playCompletionSoundIfRegistered();
      }

      // Execute Stop hooks
      if (!wasCancelled) {
        const currentSessionId = getSessionService().getCurrentSessionId();
        if (currentSessionId) {
          try {
            const currentMode = getSessionService().getCurrentAutonomyMode();
            const transcriptPath =
              getSessionService().getSessionTranscriptPath() || '';
            const executionTime = this._state.status.executionStartTime
              ? Date.now() - this._state.status.executionStartTime
              : 0;
            const toolCount = this._state.status.toolUseCount || 0;

            const hookResults = await executeHooksWithDisplay(
              HookEventName.Stop,
              {
                session_id: currentSessionId,
                transcript_path: transcriptPath,
                cwd: process.cwd(),
                permission_mode: getPermissionModeString(currentMode),
                hook_event_name: HookEventName.Stop,
                stop_hook_active: this.stopHookActiveRef,
                tool_execution_count: toolCount,
                elapsed_time: executionTime,
              },
              undefined,
              {
                updateAction: this.params.updateAction,
                sessionId: currentSessionId,
              }
            );

            const stopResult = hookResults.find((r) => r.continue === false);
            if (stopResult) {
              shouldSkipEndOfLoopQueueDrain = true;
              const reason =
                stopResult.stopReason || 'Hook requested immediate stop';
              this.params.addMessage(
                MessageRole.System,
                getI18n().t('commands:slashMessages.stopHook', { reason }),
                { visibility: MessageVisibility.UserOnly }
              );
            }

            const systemMsgResult = hookResults.find((r) => r.systemMessage);
            if (systemMsgResult) {
              this.params.addMessage(
                MessageRole.System,
                getI18n().t('common:appMessages.hookMessage', {
                  message: systemMsgResult.systemMessage,
                }),
                { visibility: MessageVisibility.UserOnly }
              );
            }

            const abortResult = hookResults.find((r) => r.exitCode === 3);
            if (abortResult) {
              shouldSkipEndOfLoopQueueDrain = true;
              const errorMsg =
                abortResult.stderr || 'Agent aborted by Stop hook';
              this.params.addMessage(
                MessageRole.System,
                getI18n().t('commands:slashMessages.agentAborted', {
                  message: errorMsg,
                }),
                { visibility: MessageVisibility.UserOnly }
              );
            }

            const blockDecisionResult = hookResults.find(
              (r) => r.decision === 'block'
            );
            if (blockDecisionResult && blockDecisionResult.reason) {
              shouldContinueFromStopHook = true;
              stopHookReasonToInject = blockDecisionResult.reason;
              logInfo('[Agent] Stop hook blocking with decision: block');
            }

            if (!blockDecisionResult) {
              const exitCode2Result = hookResults.find((r) => r.exitCode === 2);
              if (exitCode2Result) {
                shouldContinueFromStopHook = true;
                stopHookReasonToInject =
                  exitCode2Result.stderr || 'Stop hook requested continuation';
                logInfo('[Agent] Stop hook blocking with exit code 2');
              }
            }

            const errorResult = hookResults.find((r) => r.exitCode === 1);
            if (errorResult && errorResult.stderr) {
              this.params.addMessage(
                MessageRole.System,
                getI18n().t('common:appMessages.stopHookWarning', {
                  stderr: errorResult.stderr,
                }),
                { visibility: MessageVisibility.UserOnly }
              );
            }
          } catch (error) {
            logException(error, '[Agent] Failed to execute Stop hooks');
          }
        }
      }

      if (
        !wasCancelled &&
        !shouldSkipEndOfLoopQueueDrain &&
        !shouldContinueFromStopHook &&
        isQueuedMessagesEnabled &&
        this.params.drainEndOfLoopQueuedUserMessage
      ) {
        const queuedMessage =
          await this.params.drainEndOfLoopQueuedUserMessage();
        if (
          queuedMessage &&
          (queuedMessage.text.trim() ||
            (queuedMessage.images?.length ?? 0) > 0 ||
            (queuedMessage.files?.length ?? 0) > 0)
        ) {
          queuedEndOfLoopMessage = {
            message: queuedMessage.text,
            images: queuedMessage.images,
            files: queuedMessage.files,
            outputFormat: queuedMessage.outputFormat,
            messageId: queuedMessage.messageId,
            role: queuedMessage.role,
            visibility: queuedMessage.visibility,
            requestId: queuedMessage.requestId,
            userMessageSource: queuedMessage.userMessageSource,
          };
        }
      }

      if (!shouldContinueFromStopHook && !queuedEndOfLoopMessage) {
        // Track assistant active time for this run
        const elapsed = Date.now() - agentRunStartTime;
        const prevActiveTime = sessionService.getAssistantActiveTime();
        sessionService.setAssistantActiveTime(prevActiveTime + elapsed);

        this.setAgentIdle();
        telemetryClient.setModelId(null);
        this.setState((prev) => ({
          ...prev,
          status: {
            ...prev.status,
            executionStartTime: undefined,
            state: AgentStatusState.Idle,
          },
        }));
      }
    }

    if (queuedEndOfLoopMessage) {
      this.stopHookActiveRef = false;
      this.runningRef = false;
      return this.runAgentWithUserMessage(queuedEndOfLoopMessage);
    }

    // Handle Stop hook continuation
    if (shouldContinueFromStopHook && stopHookReasonToInject) {
      logInfo('[Agent] Continuing with Stop hook reason', {
        reason: stopHookReasonToInject,
      });

      this.stopHookActiveRef = true;

      this.runningRef = false;

      return this.runAgentWithUserMessage({
        message: stopHookReasonToInject,
      });
    }

    this.stopHookActiveRef = false;

    return true;
  }

  // ── Cleanup ──

  dispose(): void {
    // Abort any in-flight LLM streaming
    this.llmCore.abortStreaming();

    // Abort any in-flight compaction summarization
    try {
      this.compactionAbortRef?.abort();
    } catch (error) {
      logWarn('[AgentLoop] Failed to abort compaction during cleanup', {
        cause: error,
      });
    }
    this.compactionAbortRef = null;

    // Cancel running tools and resolve pending confirmations
    this.toolExecutor.cancelAllTools().catch((error) => {
      logWarn('[AgentLoop] Failed to cancel tools during cleanup', {
        cause: error,
      });
    });
    this.toolExecutor.dispose();

    // Clear any unconsumed spec handoff payload
    this._pendingSpecHandoff = null;

    // Mark agent as idle so no further callbacks fire
    this.runningRef = false;
  }
}
