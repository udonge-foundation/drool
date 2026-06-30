/**
 * Provider-agnostic send-message orchestration for drool-core.
 *
 * Owns the LLM "send a turn" pipeline: provider selection, retry handling,
 * chunk processing, and provider request construction. Host-specific
 * concerns (auth headers, proxy routing, telemetry, settings, tools
 * registry, IDE integration, etc.) are injected via
 * {@link SendMessageDeps} so this implementation can be reused by any
 * host (interactive CLI streaming, prompt-tuning candidate generation,
 * eval runners, ACP servers, etc.).
 */

import Anthropic from '@anthropic-ai/sdk';
import { ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import OpenAI from 'openai';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '@industry/common/llm';
import {
  ChatCompletionReasoningField,
  ReasoningEffort,
  ModelID,
  ModelProvider,
  ApiProvider,
} from '@industry/drool-sdk-ext/protocol/llm';
import {
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageRole,
  TextBlock,
  CacheLabel,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { TOOL_LLM_ID_APPLY_PATCH } from '@industry/drool-sdk-ext/protocol/tools';
import {
  logWarn,
  type MetricLabels,
  Metrics,
  Metric,
  logInfo,
  MetaError,
} from '@industry/logging';
import {
  FetchError,
  markDroolCoreLlmRequestError,
} from '@industry/logging/errors';
import {
  getCodingSubscriptionAccessTokenSync,
  getCodingSubscriptionAuthStore,
  type CodingSubscriptionProvider,
} from '@industry/runtime/auth';
import { getFlag } from '@industry/runtime/feature-flags';
import { retry } from '@industry/utils';
import { isAbortError } from '@industry/utils/function';
import {
  getLLMConfig,
  findClosestModelId,
  configureGeminiRequest,
} from '@industry/utils/llm';
import { configureAnthropicRequest } from '@industry/utils/llm/providers/anthropic';
import {
  chatCompletionsProviderParams,
  hasReasoningEnabled,
  resolveChatCompletionsProviderReasoningEffort,
  resolveChatCompletionsReasoningRequestConfig,
} from '@industry/utils/llm/providers/completions';
import {
  configureOpenAIRequest,
  getOpenAIPlatformHeadersForCustomModel,
} from '@industry/utils/llm/providers/openai';
import {
  findCustomModel,
  getCustomModelSupportedEfforts,
  getCustomModelUsageBaseUrl,
  getRequiredHttpCustomModel,
  isBedrockCustomModel,
  isConverseBedrockCustomModel,
  isOpenAIBedrockCustomModel,
} from '@industry/utils/models';

import { LanguageModelFinishReason } from '../../streaming/enums';
import { ChatOutcomeRecorder } from '../../streaming/metrics/ChatOutcomeRecorder';
import { LLMContentModerationError, mapStreamReaderError } from '../errors';
import {
  constructBedrockClient,
  mapBedrockReaderError,
} from './bedrock/anthropic';
import {
  constructConverseClient,
  mapConverseReaderError,
  processConverseChunk,
  resolveConverseClientConfig,
} from './bedrock/converse';
import {
  constructBedrockOpenAIClient,
  mapBedrockOpenAIReaderError,
} from './bedrock/openai';
import {
  resolveBedrockClientConfig,
  resolveBedrockOpenAIClientConfig,
} from './bedrock/shared';
import {
  applyEmptyResponseBudgetEscalation,
  assertNonEmptyLLMResponse,
  createEmptyResponseRetryState,
  createInitialStreamingState,
  processAnthropicChunk,
  processOpenAIChunk,
  processOpenAIChatChunk,
  processGeminiSSEChunk,
} from './chunk-processing';
import {
  PROXY_API_KEY_PLACEHOLDER,
  ABORTED_RESULT,
  ONESHOT_USER_MESSAGE_ID_PREFIX,
  ONESHOT_ASSISTANT_MESSAGE_ID_PREFIX,
} from './constants';
import {
  convertDroolToOpenAIMessages,
  convertAnthropicToOpenAITools,
  convertDroolToOpenAiChatMessages,
  convertAnthropicToOpenAIChatTools,
  convertAnthropicToolsToGemini,
  convertAnthropicToConverseTools,
  convertDroolToGeminiContents,
  extractCuratedGeminiHistory,
  ensureGeminiThoughtSignatures,
  sanitizeAnthropicTools,
} from './converters';
import { RetryStrategy } from './enums';
import { stripImagesFromConversation } from './image-limits';
import { prepareMessagesWithCaching as prepareMessagesWithCachingCore } from './message-preparation';
import {
  applyDeprecatedModelFallback,
  resolveHardDeprecatedModelFallback,
} from './model-deprecation';
import { createPromptCacheBreakMonitor } from './prompt-cache-break-monitor';
import {
  isFireworksAnthropicCompatModel,
  isGoogleProvider,
  shouldUseResponsesAPI,
  getGeminiEndpoint,
  resolveChatCompletionsInteropProvider,
  resolveProxyApiProvider,
} from './providerRouting';
import {
  createTimeToFirstTokenRecorder,
  hasOpenAIChatTimeToFirstTokenDelta,
  logProviderResponseDiagnostics,
} from './streaming-telemetry';
import {
  isOverloadedError,
  isProviderCapacityError,
  isRetryableLLMError,
  isRetryableOnAnotherProvider,
} from '../errors/utils';
import { mapAnthropicReaderError } from '../provider/anthropic/stream-error-handler';
import {
  buildConverseRequest,
  isConverseThinkingSignatureEnforcedModel,
} from '../provider/converse/request';
import { mapGoogleError } from '../provider/google/errors-mapper';

import type {
  ChunkProcessingOptions,
  HandleLlmErrorRequest,
  HeadlessHostDepsOptions,
  ModelContext,
  PrepareMessagesWithCachingOptions,
  ProviderMessageParams,
  SendApiProviderMessageResult,
  SendMessageClient,
  SendCompletionParams,
  SendMessageDeps,
  SendMessageHostDeps,
  SendMessageParams,
  SendMessageRequestLimiter,
  SessionLike,
  StreamingCallbacks,
  StreamingContentBlock,
  StreamingResult,
  ToolSearchMetricsMetadata,
  ToolCallInfo,
  ToolUse,
} from './types';
import type { LLMToolDescriptor, LLMToolSpec } from '../../tools/types';
import type { CustomModel } from '@industry/common/settings';
import type { HttpCustomModel } from '@industry/utils/models';
import type { GenerateContentResponse } from '@google/genai';

interface ResolvedTurnTools {
  tools: Anthropic.Tool[];
  toolSearchMetrics?: ToolSearchMetricsMetadata;
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Reasoning efforts cheapest-first, taken straight from the `ReasoningEffort`
 * declaration order (which is already ascending by effort; a sortedness test
 * in `@industry/drool-sdk-ext` guards against a reorder silently breaking the
 * floor). The first level a model supports wins, so the request stays valid
 * for models without an Off switch (GPT-5.x codex floors at Low, MiniMax M2.7
 * stays High and relies on the output-cap headroom instead).
 */
const REASONING_EFFORTS_BY_ASCENDING_EFFORT: ReasoningEffort[] =
  Object.values(ReasoningEffort);

/**
 * Extra output-token allowance when the floored effort still has reasoning
 * enabled, so reasoning that shares the output budget (chat-completions
 * `reasoning_content`, Anthropic thinking) cannot starve small output caps
 * (e.g. the compaction summary reserve).
 */
const REASONING_HEADROOM_TOKENS = 8192;

type CodingSubscriptionHttpCustomModel = CustomModel & {
  codingSubscriptionProvider?: CodingSubscriptionProvider;
  codingSubscriptionAccountId?: string;
};

function resolveCodingSubscriptionCustomModel(
  customModel: CustomModel | null
): CustomModel | null {
  const prefix = 'coding-subs://';
  if (!customModel?.apiKey?.startsWith(prefix)) return customModel;
  const provider = customModel.apiKey.slice(prefix.length) as CodingSubscriptionProvider;
  const auth = getCodingSubscriptionAuthStore().getAuthSync(provider);
  const accessToken = getCodingSubscriptionAccessTokenSync(provider);
  if (!accessToken) {
    throw new MetaError(
      `No OAuth token found for ${provider}. Run /provider to log in.`
    );
  }
  const next: CodingSubscriptionHttpCustomModel = {
    ...customModel,
    apiKey: accessToken,
    codingSubscriptionProvider: provider,
    codingSubscriptionAccountId: auth?.account_id,
  };
  if (provider === 'codex') {
    next.baseUrl = 'https://chatgpt.com/backend-api/codex';
  }
  return next;
}

function isReasoningDisabledEffort(effort: ReasoningEffort): boolean {
  return effort === ReasoningEffort.Off || effort === ReasoningEffort.None;
}

/**
 * Floor the effort to the cheapest level the model supports, so session-level
 * high/xhigh/max reasoning cannot produce thinking-only answers under small
 * output caps. An explicit caller effort wins; models without a registry
 * effort set keep the session effort.
 */
function resolveEffortFloor({
  minimizeReasoning,
  hasExplicitEffort,
  supportedEfforts,
  fallbackEffort,
}: {
  minimizeReasoning: boolean | undefined;
  hasExplicitEffort: boolean;
  supportedEfforts: readonly ReasoningEffort[] | undefined;
  fallbackEffort: ReasoningEffort;
}): ReasoningEffort {
  if (!minimizeReasoning || hasExplicitEffort || !supportedEfforts) {
    return fallbackEffort;
  }
  return (
    REASONING_EFFORTS_BY_ASCENDING_EFFORT.find((effort) =>
      supportedEfforts.includes(effort)
    ) ?? fallbackEffort
  );
}

/**
 * Resolve the output cap when text is required. When the resolved effort still
 * has reasoning enabled (floored models without an Off switch, or pinned-effort
 * callers), add headroom bounded by the model/custom output ceiling so
 * shared-budget reasoning cannot consume the entire cap.
 */
function resolveMaxTokensWithReasoningHeadroom({
  maxTokensOverride,
  expectsText,
  reasoningEffort,
  modelMaxOutputTokens,
  customMaxOutputTokens,
}: {
  maxTokensOverride: number | undefined;
  expectsText: boolean | undefined;
  reasoningEffort: ReasoningEffort;
  modelMaxOutputTokens: number | undefined;
  customMaxOutputTokens: number | undefined;
}): number | undefined {
  if (
    maxTokensOverride === undefined ||
    !expectsText ||
    isReasoningDisabledEffort(reasoningEffort)
  ) {
    return maxTokensOverride;
  }
  return Math.max(
    maxTokensOverride,
    Math.min(
      maxTokensOverride + REASONING_HEADROOM_TOKENS,
      modelMaxOutputTokens ?? Number.POSITIVE_INFINITY,
      customMaxOutputTokens ?? Number.POSITIVE_INFINITY
    )
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    logWarn('[sendMessage] Failed to stringify value for logging', {
      cause: error,
    });
    return '{}';
  }
}

function isApplyPatchToolNameForFallback(name: string | undefined): boolean {
  return name === TOOL_LLM_ID_APPLY_PATCH;
}

function parseBufferedToolInput({
  rawToolInput,
  toolName,
}: {
  rawToolInput: string;
  toolName: string | undefined;
}): Record<string, unknown> {
  if (isApplyPatchToolNameForFallback(toolName)) {
    return { input: rawToolInput };
  }

  const parsed = JSON.parse(rawToolInput);
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Funnel a provider call through the host's optional concurrency
 * limiter. Hosts that don't supply one (the default — interactive UI)
 * call `fn` directly with no overhead.
 */
async function runWithLimiter<T>(
  limiter: SendMessageRequestLimiter | undefined,
  fn: () => Promise<T>
): Promise<T> {
  return limiter ? limiter.run(fn) : fn();
}

function buildProviderResultFromState({
  state,
  wasAborted,
  usedApiProvider,
}: {
  state: ReturnType<typeof createInitialStreamingState>;
  wasAborted: boolean;
  usedApiProvider?: ApiProvider;
}): SendApiProviderMessageResult {
  return {
    finalStreamingContent:
      state.finalStreamingContent || state.streamingContent,
    toolUses: state.toolUses,
    usage: state.usage,
    toolInputBuffers: state.toolInputBuffers,
    openaiMessageId: undefined,
    openaiEncryptedContent: undefined,
    openaiReasoningId: undefined,
    thinkingContent: state.thinkingContent,
    thinkingSignature: state.thinkingSignature,
    contentBlocks: state.contentBlocks.filter(
      (block): block is StreamingContentBlock => block != null
    ),
    wasAborted,
    usedApiProvider,
    stopReason: state.stopReason,
    stopDetails: state.stopDetails,
  };
}

/**
 * Prototype-preserving spread.
 *
 * Equivalent to `{ ...base, ...overrides }` but keeps `base`'s prototype
 * chain intact, so method dispatch works correctly when `base` is a
 * class instance (e.g. CLI's `SessionService`). Plain object spread
 * silently drops prototype methods, which is a footgun whenever a host
 * passes `deps.session = getSessionService()` and we want to override a
 * single method without losing the rest.
 */
function withOverrides<T extends object>(base: T, overrides: Partial<T>): T {
  return Object.assign(Object.create(base) as T, overrides);
}

/**
 * Resolve the active model ID considering spec mode state.
 *
 * The `hasSpecModeModel()` guard is critical because `getSpecModeModel()`
 * has a fallback chain that returns the global default model when no
 * explicit spec model is set.
 */
function resolveActiveModel(session: SessionLike): string {
  if (session.isSpecMode() && session.hasSpecModeModel()) {
    return session.getSpecModeModel();
  }
  return session.getModel();
}

/**
 * Build the merged tool descriptor list for a turn: registry tools + IDE
 * tools, with `openDiff` / `closeDiff` filtered out. The `getTools`
 * test override on host deps short-circuits the entire flow.
 */
async function resolveToolDescriptors(
  deps: SendMessageDeps
): Promise<LLMToolDescriptor[]> {
  if (deps.getTools) {
    return deps
      .getTools()
      .map((tool) => ({ spec: tool as LLMToolSpec, sideEffects: [] }));
  }

  const ideClient = deps.ide.getIdeClient();
  if (ideClient) {
    const tools = ideClient.getAvailableTools();
    const filtered = tools.filter(
      (t) => t.name !== 'openDiff' && t.name !== 'closeDiff'
    );
    deps.ideToolsRef.current = filtered.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }
  const ideTools: LLMToolDescriptor[] = (deps.ideToolsRef.current ?? []).map(
    (tool) => ({ spec: tool as LLMToolSpec, sideEffects: [] })
  );
  const registryTools = await deps.platform.generateToolsFromRegistry();
  return [...registryTools, ...ideTools];
}

async function resolveTurnTools(
  deps: SendMessageDeps,
  sessionId?: string | null,
  outputFormat?: SendMessageParams['outputFormat']
): Promise<ResolvedTurnTools> {
  const descriptors = await resolveToolDescriptors(deps);
  const resolved = await deps.platform.resolveTurnTools?.({
    tools: descriptors,
    sessionId,
    outputFormat,
  });

  if (resolved) {
    return {
      tools: resolved.tools as Anthropic.Tool[],
      toolSearchMetrics: resolved.toolSearchMetrics,
    };
  }

  return {
    tools: descriptors.map((descriptor) => descriptor.spec as Anthropic.Tool),
  };
}

function recordToolSearchMetrics({
  metadata,
  usage,
  modelCtx,
  usedApiProvider,
  sessionId,
  assistantMessageId,
}: {
  metadata?: ToolSearchMetricsMetadata;
  usage: StreamingResult['usage'];
  modelCtx: ModelContext;
  usedApiProvider?: ApiProvider;
  sessionId?: string | null;
  assistantMessageId?: string;
}): void {
  if (!metadata) return;

  const labels: MetricLabels = {
    modelId: (modelCtx.config?.id ?? modelCtx.model) as string,
    modelProvider: modelCtx.provider,
    apiProvider: usedApiProvider ?? modelCtx.apiModelProvider,
    isSpecMode: modelCtx.isSpecMode,
    surface: 'industry-cli',
    sessionId: sessionId ?? undefined,
    assistantMessageId,
    mcpToolSearchEnabled: metadata.mcpToolSearchEnabled,
    toolSearchPhase: metadata.toolSearchPhase,
    exposedToolCount: metadata.exposedToolCount,
    hiddenToolCount: metadata.hiddenToolCount,
    loadedDeferredToolCount: metadata.loadedDeferredToolCount,
    deferredReminderTokens: metadata.deferredReminderTokens,
    estimatedNetToolContextTokens: metadata.estimatedNetToolContextTokens,
    estimatedTokensSaved: metadata.estimatedTokensSaved,
  };

  const tokenMetrics = [
    {
      tokenKind: 'baseline_full_tools',
      value: metadata.baselineToolSchemaTokens,
    },
    {
      tokenKind: 'exposed_tools',
      value: metadata.exposedToolSchemaTokens,
    },
    {
      tokenKind: 'deferred_reminder',
      value: metadata.deferredReminderTokens,
    },
    {
      tokenKind: 'estimated_net_tool_context',
      value: metadata.estimatedNetToolContextTokens,
    },
  ];

  for (const metric of tokenMetrics) {
    Metrics.recordHistogram(
      Metric.MCP_TOOL_SEARCH_CONTEXT_TOKENS,
      metric.value,
      {
        ...labels,
        tokenKind: metric.tokenKind,
      }
    );
  }

  Metrics.recordHistogram(
    Metric.MCP_TOOL_SEARCH_ESTIMATED_TOKEN_SAVINGS,
    metadata.estimatedTokensSaved,
    labels
  );

  const cacheDenominator =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  Metrics.recordHistogram(
    Metric.MCP_TOOL_SEARCH_CACHE_HIT_RATE,
    cacheDenominator > 0 ? usage.cacheReadInputTokens / cacheDenominator : 0,
    labels
  );
}

/**
 * Build a `SendMessageHostDeps` for headless callers — eval runners,
 * prompt-tuning candidate generators, batch scripts. Use this when
 * there's no interactive session backing the turn; just pre-built
 * provider clients, a model id, and (optionally) a concurrency gate.
 *
 * Use {@link createSendMessageClient} directly with full
 * `SendMessageHostDeps` whenever a real session/UI is involved.
 */
export function buildHeadlessHostDeps(
  opts: HeadlessHostDepsOptions
): SendMessageHostDeps {
  return {
    llmClientsRef: {
      current: {
        anthropic: opts.anthropicClient ?? null,
        openai: opts.openaiClient,
        bedrock: null,
        bedrockConverse: null,
        bedrockOpenAI: null,
      },
    },
    abortControllerRef: { current: null },
    ideToolsRef: { current: null },
    getSystemPromptOverride: () => undefined,
    isS3LoggingEnabled: () => false,
    session: {
      getModel: () => opts.modelId,
      setModel: () => {},
      getSpecModeModel: () => opts.modelId,
      setSpecModeModel: () => {},
      hasSpecModeModel: () => false,
      getReasoningEffort: () => opts.reasoningEffort,
      getSpecModeReasoningEffort: () => opts.reasoningEffort,
      isSpecMode: () => false,
      getLockedApiProvider: () => opts.apiProvider ?? null,
      addTokenUsage: () => {},
    },
    settings: {
      getCustomModels: () => opts.customModels ?? [],
      getLlmRequestTimeout: () => 600_000,
    },
    ide: { getIdeClient: () => undefined },
    getRetryStrategy: () => RetryStrategy.NonInteractive,
    requestLimiter: opts.requestLimiter,
    getTools: () => opts.tools,
  };
}

// ---------------------------------------------------------------------------
// Public industry
// ---------------------------------------------------------------------------

function getPromptCacheRequestModelId(
  request: { model?: unknown },
  fallbackModelId: string
): string {
  return typeof request.model === 'string' && request.model.trim()
    ? request.model
    : fallbackModelId;
}

/**
 * Build a provider-agnostic send-message client given a typed dependency
 * bundle. Hosts are responsible for translating their environment into
 * {@link SendMessageDeps} and wiring the resulting handlers into their
 * UI / agent loop.
 */
export function createSendMessageClient(
  deps: SendMessageDeps
): SendMessageClient {
  let currentAnthropicProvider: ApiProvider | undefined;
  let currentChatCompletionsProvider: ApiProvider | undefined;
  // Flag set when abortStreaming() is called before an AbortController exists.
  // Provider functions check this immediately after creating their controller.
  let pendingAbort = false;
  const promptCacheBreakMonitor = createPromptCacheBreakMonitor();

  const { llmClientsRef, abortControllerRef } = deps;

  const retryStrategy = deps.getRetryStrategy();

  const cliChunkProcessingOptions: ChunkProcessingOptions = {
    onTokenUsage: (usage, isStreaming) =>
      deps.session.addTokenUsage(usage, isStreaming),
  };

  const maybeRecordCustomModelUsage = ({
    customModel,
    model,
    state,
    sessionId,
    assistantMessageId,
  }: {
    customModel: CustomModel | null;
    model: string;
    state: ReturnType<typeof createInitialStreamingState>;
    sessionId: string;
    assistantMessageId: string;
  }): void => {
    if (!customModel) return;
    void deps.platform.recordCustomModelUsage({
      model,
      baseUrl: getCustomModelUsageBaseUrl(customModel),
      usage: state.usage,
      sessionId,
      messageId: assistantMessageId,
    });
  };

  const createLlmRetryHandlers = ({
    model,
    getApiProvider,
    getRawRequest,
    wireProvider,
    sessionId,
    assistantMessageId,
    allowContextLimitS3Logging,
    onRetryAfterLog,
  }: {
    model: string;
    getApiProvider: () => ApiProvider | undefined;
    getRawRequest: () => string;
    wireProvider: HandleLlmErrorRequest['provider'];
    sessionId: string;
    assistantMessageId: string;
    allowContextLimitS3Logging?: boolean;
    onRetryAfterLog?: (error: unknown, attempt: number) => void;
  }) => ({
    onAllError: async (error: unknown) => {
      if (isAbortError(error)) {
        return ABORTED_RESULT;
      }
      markDroolCoreLlmRequestError(error);
      throw error;
    },
    onRetry: (error: unknown, attempt: number) => {
      deps.platform.handleLlmError({
        error,
        attempt,
        model,
        apiProvider: getApiProvider(),
        rawRequest: getRawRequest(),
        provider: wireProvider,
        sessionId,
        assistantMessageId,
        isS3LoggingEnabled: deps.isS3LoggingEnabled(),
        allowContextLimitS3Logging,
      });
      onRetryAfterLog?.(error, attempt);
    },
  });

  /**
   * Return the Anthropic client, re-creating it if the ref was nulled
   * (e.g. by a React re-render between retry attempts).
   */
  let lastAnthropicBaseURL: string | null = null;

  const ensureAnthropicClient = (
    customModel?: CodingSubscriptionHttpCustomModel | { apiKey: string; baseUrl: string } | null
  ): Anthropic => {
    const targetBaseURL = customModel
      ? customModel.baseUrl
      : `${deps.platform.apiBaseUrl()}/api/llm/a`;

    const clients = llmClientsRef.current;
    if (!clients.anthropic || lastAnthropicBaseURL !== targetBaseURL) {
      const baseConfig = customModel
        ? 'codingSubscriptionProvider' in customModel &&
          customModel.codingSubscriptionProvider === 'claude'
          ? {
              apiKey: null,
              authToken: customModel.apiKey,
              baseURL: customModel.baseUrl,
              defaultHeaders: {
                'anthropic-beta': 'oauth-2025-04-20',
              },
            }
          : { apiKey: customModel.apiKey, baseURL: customModel.baseUrl }
        : {
            apiKey: PROXY_API_KEY_PLACEHOLDER,
            baseURL: targetBaseURL,
          };
      // Set an explicit timeout so the Anthropic SDK skips its
      // calculateNonstreamingTimeout check that throws "Streaming is required
      // for operations that may take longer than 10 minutes" when
      // max_tokens exceeds ~21 333 on non-streaming requests.
      clients.anthropic = new Anthropic({
        ...baseConfig,
        timeout: deps.settings.getLlmRequestTimeout(),
      });
      lastAnthropicBaseURL = targetBaseURL;
    }
    return clients.anthropic;
  };

  /**
   * Re-creates when the ref is nulled or the base URL changes.
   * First call adopts a host-pre-injected `openai` client as-is —
   * otherwise headless callers' real SDK gets replaced with a
   * placeholder-keyed proxy client.
   */
  let lastOpenAIBaseURL: string | null = null;

  const ensureOpenAIClient = (
    customModel?: CodingSubscriptionHttpCustomModel | { apiKey: string; baseUrl: string } | null
  ): OpenAI => {
    const targetBaseURL = customModel
      ? customModel.baseUrl
      : `${deps.platform.apiBaseUrl()}/api/llm/o/v1`;

    const clients = llmClientsRef.current;

    if (!customModel && clients.openai && lastOpenAIBaseURL === null) {
      lastOpenAIBaseURL = targetBaseURL;
      return clients.openai;
    }

    if (!clients.openai || lastOpenAIBaseURL !== targetBaseURL) {
      const codexHeaders =
        customModel &&
        'codingSubscriptionProvider' in customModel &&
        customModel.codingSubscriptionProvider === 'codex'
          ? {
              'User-Agent':
                'codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)',
              Originator: 'codex-tui',
              ...(customModel.codingSubscriptionAccountId
                ? {
                    'Chatgpt-Account-Id':
                      customModel.codingSubscriptionAccountId,
                  }
                : {}),
            }
          : undefined;
      clients.openai = new OpenAI(
        customModel
          ? {
              apiKey: customModel.apiKey,
              baseURL: customModel.baseUrl,
              ...(codexHeaders ? { defaultHeaders: codexHeaders } : {}),
              timeout: deps.settings.getLlmRequestTimeout(),
              organization: null,
              project: null,
            }
          : {
              apiKey: PROXY_API_KEY_PLACEHOLDER,
              baseURL: targetBaseURL,
              timeout: deps.settings.getLlmRequestTimeout(),
              organization: null,
              project: null,
            }
      );
      lastOpenAIBaseURL = targetBaseURL;
    }
    return clients.openai;
  };

  type BedrockResolverParams = Parameters<typeof resolveBedrockClientConfig>[0];
  type ResolvedBedrockClientConfig = Awaited<
    ReturnType<typeof resolveBedrockClientConfig>
  >;
  type EnsureBedrockClientResult<TClient> = {
    client: TClient;
    resolvedModelId: string;
    region: string;
  };

  const createEnsureBedrockClient = <TClient>({
    resolveConfig,
    getCachedClient,
    setCachedClient,
    constructClient,
  }: {
    resolveConfig: (
      params: BedrockResolverParams
    ) => Promise<ResolvedBedrockClientConfig>;
    getCachedClient: () => TClient | null;
    setCachedClient: (client: TClient) => void;
    constructClient: (config: ResolvedBedrockClientConfig) => TClient;
  }) => {
    let lastFingerprint: string | null = null;

    return async (
      modelId: string,
      bedrock: NonNullable<HttpCustomModel['bedrock']>,
      signal: AbortSignal
    ): Promise<EnsureBedrockClientResult<TClient>> => {
      const config = await resolveConfig({
        bedrock,
        modelId,
        environment: deps.platform.getProcessEnvironment(),
        signal,
        fetchImpl: deps.platform.customFetch,
      });
      let client = getCachedClient();
      if (!client || lastFingerprint !== config.cacheFingerprint) {
        client = constructClient(config);
        setCachedClient(client);
        lastFingerprint = config.cacheFingerprint;
      }
      return {
        client,
        resolvedModelId: config.resolvedModelId,
        region: config.region,
      };
    };
  };

  const ensureBedrockClient = createEnsureBedrockClient({
    resolveConfig: resolveBedrockClientConfig,
    getCachedClient: () => llmClientsRef.current.bedrock,
    setCachedClient: (client) => {
      llmClientsRef.current.bedrock = client;
    },
    constructClient: (config) =>
      constructBedrockClient(
        config,
        deps.platform.customFetch,
        deps.settings.getLlmRequestTimeout()
      ),
  });

  const ensureConverseClient = createEnsureBedrockClient({
    resolveConfig: resolveConverseClientConfig,
    getCachedClient: () => llmClientsRef.current.bedrockConverse,
    setCachedClient: (client) => {
      llmClientsRef.current.bedrockConverse = client;
    },
    constructClient: (config) =>
      constructConverseClient(
        config,
        deps.settings.getLlmRequestTimeout(),
        deps.platform.customFetch,
        deps.platform.userAgent()
      ),
  });

  const ensureBedrockOpenAIClient = createEnsureBedrockClient({
    resolveConfig: resolveBedrockOpenAIClientConfig,
    getCachedClient: () => llmClientsRef.current.bedrockOpenAI,
    setCachedClient: (client) => {
      llmClientsRef.current.bedrockOpenAI = client;
    },
    constructClient: (config) =>
      constructBedrockOpenAIClient({
        config,
        fetchImpl: deps.platform.customFetch,
        timeoutMs: deps.settings.getLlmRequestTimeout(),
        userAgent: deps.platform.userAgent(),
      }),
  });

  const abortStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    } else {
      // No active controller yet — the LLM request hasn't started.
      // Set a flag so the next provider call aborts immediately.
      pendingAbort = true;
    }
  };

  const applyPendingAbort = (controller: AbortController): void => {
    if (pendingAbort) {
      pendingAbort = false;
      controller.abort();
    }
  };

  function setupAbortAndNotify(callbacks: StreamingCallbacks): AbortController {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    applyPendingAbort(controller);
    callbacks.onRequestStream();
    return controller;
  }

  function prepareMessagesWithCaching<
    TOptions extends PrepareMessagesWithCachingOptions | undefined = undefined,
  >(conversationHistory: IndustryDroolMessage[], options?: TOptions) {
    // Resolve the current model provider for filtering cross-provider thinking blocks.
    // Each provider uses incompatible signature formats, so we drop thinking blocks
    // whose signatureProvider doesn't match the current provider.
    //
    // IMPORTANT: The streaming chunk processor stamps `signatureProvider` on
    // new thinking blocks using the interop-remapped provider returned by
    // `resolveChatCompletionsInteropProvider` (see `sendOpenAIChatMessage`).
    // For example, a BYOK custom model named `gemini-*` with
    // `provider: GENERIC_CHAT_COMPLETION_API` is remapped to `GOOGLE` before
    // chunks are processed, so persisted thinking blocks carry
    // `signatureProvider: "google"`. If this downgrade check used the raw
    // TUI config provider (`GENERIC_CHAT_COMPLETION_API`), those blocks
    // would wrongly be flagged as cross-provider on every subsequent turn
    // and rewritten into literal `<thinking>\n...\n</thinking>` text,
    // reproducing the FAC-19104 compounding pattern for BYOK Gemini. Compare
    // against the same interop-remapped provider the stamp was built from.
    const activeModel = resolveActiveModel(deps.session);
    const rawProvider =
      deps.platform.getTuiModelConfig(activeModel).modelProvider;
    const customModels = deps.settings.getCustomModels();
    const customModel = findCustomModel(activeModel, customModels) ?? null;
    const modelForInterop = customModel ? customModel.model : activeModel;
    const currentProvider = resolveChatCompletionsInteropProvider(
      modelForInterop,
      rawProvider,
      customModel
    );

    // For Industry models using Anthropic wire format (e.g., MiniMax via Fireworks),
    // accept ANTHROPIC-signed thinking blocks even though currentProvider is INDUSTRY.
    // Uses `rawProvider` because Fireworks-Anthropic-compat is defined on stock
    // INDUSTRY models (via registry lookup) and is not affected by the interop
    // remap above (remap only fires for GENERIC_CHAT_COMPLETION_API → GOOGLE).
    const acceptsAnthropicSignatures = isFireworksAnthropicCompatModel(
      activeModel,
      rawProvider
    );
    const acceptsUnsignedThinkingSignatures =
      currentProvider === ModelProvider.BEDROCK_CONVERSE &&
      !isConverseThinkingSignatureEnforcedModel(modelForInterop);

    return prepareMessagesWithCachingCore(
      conversationHistory,
      {
        currentProvider,
        acceptsAnthropicSignatures,
        acceptsUnsignedThinkingSignatures,
      },
      options
    );
  }

  const resolveModelContext = (overrides?: {
    modelId?: string;
    isSpecMode?: boolean;
    reasoningEffort?: ReasoningEffort;
    apiProvider?: ApiProvider;
    minimizeReasoning?: boolean;
  }): ModelContext => {
    const isSpecMode = overrides?.isSpecMode ?? deps.session.isSpecMode();
    const selectedModelId =
      overrides?.modelId ??
      resolveActiveModel(
        withOverrides(deps.session, { isSpecMode: () => isSpecMode })
      );
    const reasoningEffort =
      overrides?.reasoningEffort ??
      (isSpecMode && deps.session.hasSpecModeModel()
        ? deps.session.getSpecModeReasoningEffort()
        : deps.session.getReasoningEffort());

    // Check if this is a custom model
    const customModels = deps.settings.getCustomModels();
    let activeModelId = selectedModelId;
    let customModel = resolveCodingSubscriptionCustomModel(
      findCustomModel(activeModelId, customModels) ?? null
    );
    let deprecatedModelFallback: ModelContext['deprecatedModelFallback'];
    const deprecatedModelResolution = customModel
      ? null
      : resolveHardDeprecatedModelFallback(activeModelId, {
          translate: deps.platform.translate,
          ...(deps.platform.getAvailableModelIds
            ? { getCandidateModelIds: deps.platform.getAvailableModelIds }
            : {}),
        });
    if (deprecatedModelResolution) {
      if (!deprecatedModelResolution.fallbackModelId) {
        throw new MetaError(deprecatedModelResolution.message, {
          modelId: deprecatedModelResolution.deprecatedModelId,
        });
      }

      deprecatedModelFallback = deprecatedModelResolution;
      activeModelId = deprecatedModelResolution.fallbackModelId;
      customModel = resolveCodingSubscriptionCustomModel(
        findCustomModel(activeModelId, customModels) ?? null
      );
    }

    // Determine the actual model string to send to API
    const model = customModel ? customModel.model : activeModelId;

    // Get provider from TUI config (works for both built-in and custom models)
    const provider =
      deps.platform.getTuiModelConfig(activeModelId).modelProvider;

    // Get registry config — for custom models, try fuzzy match to find similar built-in
    let config: ReturnType<typeof getLLMConfig> | undefined;
    const registryModelId = customModel
      ? findClosestModelId(customModel.model)
      : (activeModelId as ModelID);
    if (registryModelId) {
      try {
        config = getLLMConfig({ modelId: registryModelId });
      } catch (error) {
        // No matching model in registry — expected for unknown BYOK
        // custom models, but surface as a warn so genuine resolver
        // failures stay observable.
        logWarn('[sendMessage] No registry config for model, skipping', {
          modelId: registryModelId,
          cause: error,
        });
      }
    }

    const resolvedReasoningEffort =
      deprecatedModelFallback &&
      config &&
      !config.reasoningEffort.supported.includes(reasoningEffort)
        ? config.reasoningEffort.default
        : reasoningEffort;

    // This is the single place where an explicit effort override beats
    // `minimizeReasoning`.
    const flooredReasoningEffort = resolveEffortFloor({
      minimizeReasoning: overrides?.minimizeReasoning,
      hasExplicitEffort: overrides?.reasoningEffort !== undefined,
      supportedEfforts: config?.reasoningEffort.supported,
      fallbackEffort: resolvedReasoningEffort,
    });

    return {
      model,
      provider,
      apiModelProvider: config?.apiModelProvider,
      config,
      customModel,
      isSpecMode,
      reasoningEffort: flooredReasoningEffort,
      deprecatedModelFallback,
    };
  };

  // -------------------------------------------------------------------------
  // Provider implementations
  // -------------------------------------------------------------------------

  /**
   * Native AWS Bedrock Converse BYOK send path. Parallel to
   * {@link sendAnthropicMessage} but speaks the independent Converse
   * schema: no `convertDroolMessagesToAnthropic`, no
   * `configureAnthropicRequest`, no proxy headers, no provider rotation.
   * Reuses the shared TTFT / abort / empty-turn / usage plumbing.
   */
  const sendBedrockConverseMessage = async ({
    conversationHistory,
    systemMessage,
    callbacks,
    sessionId,
    assistantMessageId,
    allowContextLimitS3Logging,
    maxTokensOverride,
    expectsText,
    model,
    provider,
    customModel,
    reasoningEffort,
    isSpecMode,
    outputFormat,
  }: ProviderMessageParams): Promise<SendApiProviderMessageResult> => {
    if (
      !customModel ||
      !isConverseBedrockCustomModel(customModel) ||
      !customModel.bedrock
    ) {
      throw new MetaError(
        'sendBedrockConverseMessage requires a bedrock-converse custom model',
        { modelId: model }
      );
    }
    const bedrock = customModel.bedrock;

    const localAbortController = setupAbortAndNotify(callbacks);

    const streamStartTime = Date.now();
    const recordTimeToFirstToken = createTimeToFirstTokenRecorder({
      model,
      provider,
      isSpecMode,
      streamStartTime,
      getApiProvider: () => ApiProvider.BEDROCK_CONVERSE,
      getBaseUrl: () =>
        customModel ? getCustomModelUsageBaseUrl(customModel) : undefined,
    });

    const { tools: resolvedTools } = await resolveTurnTools(
      deps,
      sessionId,
      outputFormat
    );
    const tools = convertAnthropicToConverseTools(
      sanitizeAnthropicTools(resolvedTools)
    );

    if (callbacks.onMessageStart) {
      callbacks.onMessageStart();
    }

    let cachedResolvedModelId: string | undefined;
    let cachedConverseInput:
      | ReturnType<typeof buildConverseRequest>
      | undefined;
    const emptyResponseRetryState = createEmptyResponseRetryState();

    const attemptStream = async (): Promise<SendApiProviderMessageResult> => {
      const state = createInitialStreamingState(provider);

      const { client, resolvedModelId } = await ensureConverseClient(
        customModel.model,
        bedrock,
        localAbortController.signal
      );

      if (!cachedConverseInput || cachedResolvedModelId !== resolvedModelId) {
        cachedResolvedModelId = resolvedModelId;
        cachedConverseInput = buildConverseRequest({
          modelId: resolvedModelId,
          messages: conversationHistory,
          systemMessage,
          tools,
          customModel,
          reasoningEffort,
          maxTokensOverride,
        });
      }
      if (cachedConverseInput.inferenceConfig) {
        cachedConverseInput.inferenceConfig.maxTokens =
          applyEmptyResponseBudgetEscalation({
            retryState: emptyResponseRetryState,
            currentMaxTokens: cachedConverseInput.inferenceConfig.maxTokens,
            ceiling: customModel.maxOutputTokens,
          }) ?? cachedConverseInput.inferenceConfig.maxTokens;
      }

      promptCacheBreakMonitor.recordOutgoingRequest({
        sessionId,
        assistantMessageId,
        providerPath: 'bedrock_converse',
        modelId: resolvedModelId,
        apiProvider: ApiProvider.BEDROCK_CONVERSE,
        request: cachedConverseInput,
      });

      const response = await client.send(
        new ConverseStreamCommand(cachedConverseInput),
        { abortSignal: localAbortController.signal }
      );

      try {
        if (response.stream) {
          for await (const event of response.stream) {
            if (localAbortController.signal.aborted) break;
            if (event.contentBlockStart || event.contentBlockDelta) {
              recordTimeToFirstToken();
            }
            processConverseChunk(
              event,
              state,
              callbacks,
              cliChunkProcessingOptions
            );
          }
        }
      } catch (streamError) {
        if (isAbortError(streamError) || localAbortController.signal.aborted) {
          throw streamError;
        }
        throw mapConverseReaderError(streamError);
      }

      if (localAbortController.signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }

      maybeRecordCustomModelUsage({
        customModel,
        model,
        state,
        sessionId,
        assistantMessageId,
      });

      logProviderResponseDiagnostics({
        state,
        model,
        providerName: provider,
        wasAborted: localAbortController.signal.aborted,
      });

      assertNonEmptyLLMResponse({
        state,
        wasAborted: localAbortController.signal.aborted,
        expectsText,
        modelId: model,
        providerName: provider,
        retryState: emptyResponseRetryState,
      });

      return buildProviderResultFromState({
        state,
        wasAborted: localAbortController.signal.aborted,
        usedApiProvider: ApiProvider.BEDROCK_CONVERSE,
      });
    };

    return retry(attemptStream, {
      ...deps.platform.getRetryConfig({ strategy: retryStrategy }),
      signal: localAbortController.signal,
      ...createLlmRetryHandlers({
        model,
        getApiProvider: () => ApiProvider.BEDROCK_CONVERSE,
        getRawRequest: () => safeStringify({ model: customModel.model }),
        wireProvider: 'anthropic',
        sessionId,
        assistantMessageId,
        allowContextLimitS3Logging,
      }),
    })();
  };

  async function withSendMessageRetry(
    attemptStream: () => Promise<SendApiProviderMessageResult>,
    abortSignal: AbortSignal,
    retryHandlers: ReturnType<typeof createLlmRetryHandlers>,
    retryOverrides: {
      isRetryableError?: (error: unknown) => boolean;
    } = {}
  ): Promise<SendApiProviderMessageResult> {
    try {
      return await retry(attemptStream, {
        ...deps.platform.getRetryConfig({ strategy: retryStrategy }),
        ...retryOverrides,
        signal: abortSignal,
        ...retryHandlers,
      })();
    } catch (error) {
      if (isAbortError(error)) return ABORTED_RESULT;
      throw error;
    }
  }

  const sendAnthropicMessage = async ({
    conversationHistory,
    systemMessage,
    callbacks,
    sessionId,
    assistantMessageId,
    allowContextLimitS3Logging,
    maxTokensOverride,
    expectsText,
    model,
    provider,
    config,
    customModel,
    reasoningEffort,
    isSpecMode,
    outputFormat,
  }: ProviderMessageParams): Promise<SendApiProviderMessageResult> => {
    const bedrockEnabled = isBedrockCustomModel(customModel);
    const httpCustomModel = getRequiredHttpCustomModel(customModel);
    if (!bedrockEnabled) {
      ensureAnthropicClient(httpCustomModel);
    }

    const localAbortController = setupAbortAndNotify(callbacks);
    const streamStartTime = Date.now();
    const recordTimeToFirstToken = createTimeToFirstTokenRecorder({
      model,
      provider,
      isSpecMode,
      streamStartTime,
      getApiProvider: () => currentAnthropicProvider,
      getBaseUrl: () =>
        customModel ? getCustomModelUsageBaseUrl(customModel) : undefined,
    });

    const { tools: resolvedTools } = await resolveTurnTools(
      deps,
      sessionId,
      outputFormat
    );
    const tools = sanitizeAnthropicTools(resolvedTools);
    const anthropicMessages =
      deps.platform.convertDroolMessagesToAnthropic(conversationHistory);
    // Build base params
    const baseModelParams: Anthropic.MessageCreateParams = {
      model,
      max_tokens:
        maxTokensOverride ??
        customModel?.maxOutputTokens ??
        config?.contextLimits(reasoningEffort).maxOutputTokens ??
        CLAUDE_MAX_OUTPUT_TOKENS,
      messages: anthropicMessages,
      tools,
      system: systemMessage,
      ...(customModel?.extraArgs ?? {}),
    };

    const lockedApiProvider = customModel
      ? null
      : (deps.session.getLockedApiProvider() ?? null);
    let didRotateAnthropicProvider = false;

    // Custom models bypass the Industry proxy. Do not resolve a proxy
    // ApiProvider for them, because unknown custom model names can fall back
    // to the registry default and inherit stale locks (FAC-18429).
    // Bedrock-routed custom models pin to ApiProvider.BEDROCK_ANTHROPIC so
    // the metric pipeline can distinguish Bedrock turns from generic BYOK.
    currentAnthropicProvider = bedrockEnabled
      ? ApiProvider.BEDROCK_ANTHROPIC
      : customModel
        ? undefined
        : deps.platform.getNextProvider({
            model,
            currentProvider: currentAnthropicProvider,
            lockedProvider: lockedApiProvider,
            rotateIfValid: false, // validate/resolve only — rotation happens in onRetry
          });

    // Notify streaming state manager (only once across retries)
    if (callbacks.onMessageStart) {
      callbacks.onMessageStart();
    }

    const emptyResponseRetryState = createEmptyResponseRetryState();

    // Single-attempt streaming helper
    const attemptStream = async (): Promise<SendApiProviderMessageResult> => {
      baseModelParams.max_tokens =
        applyEmptyResponseBudgetEscalation({
          retryState: emptyResponseRetryState,
          currentMaxTokens: baseModelParams.max_tokens,
          ceiling:
            customModel?.maxOutputTokens ??
            config?.contextLimits(reasoningEffort).maxOutputTokens,
        }) ?? baseModelParams.max_tokens;
      const state = createInitialStreamingState(provider);
      const baseHeaders = customModel
        ? undefined
        : await deps.platform.createProxyHeaders({
            sessionId,
            assistantMessageId,
            proxyApiProvider: currentAnthropicProvider!,
          });
      const isReasoningEnabledEffort =
        reasoningEffort !== ReasoningEffort.None &&
        reasoningEffort !== ReasoningEffort.Off;
      const customModelSupportedEfforts = customModel
        ? getCustomModelSupportedEfforts(
            customModel.reasoningEffort,
            customModel.model
          )
        : [];
      const shouldApplyCustomThinking = Boolean(
        customModel &&
          (customModel.enableThinking === true ||
            (isReasoningEnabledEffort &&
              customModelSupportedEfforts.includes(reasoningEffort)))
      );

      // Configure Anthropic request with thinking/effort and guards.
      // This also strips thinking blocks from messages when guards disable thinking.
      const { headers: requestHeaders } = configureAnthropicRequest({
        model: config,
        reasoningEffort,
        apiProvider: currentAnthropicProvider,
        customThinkingConfig:
          customModel && shouldApplyCustomThinking
            ? {
                enableThinking: true,
                thinkingMaxTokens: customModel.thinkingMaxTokens,
                maxOutputTokens: customModel.maxOutputTokens,
              }
            : undefined,
        conversationHistory,
        baseParams: baseModelParams as unknown as Record<string, unknown>,
        baseHeaders: {
          ...(baseHeaders ?? {}),
          ...(customModel?.extraHeaders ?? {}),
          ...(customModel ? { 'User-Agent': deps.platform.userAgent() } : {}),
        },
      });

      let stream: AsyncIterable<Anthropic.MessageStreamEvent>;
      let usingBedrockClient = false;
      if (bedrockEnabled) {
        // `bedrockEnabled` is true iff `customModel?.bedrock` is set, so the
        // `!` here is safe — we just can't express that narrowing through a
        // boolean.
        const { client: bedrockClient, resolvedModelId } =
          await ensureBedrockClient(
            customModel!.model,
            customModel!.bedrock!,
            localAbortController.signal
          );
        usingBedrockClient = true;
        // The SDK strips `model`/`stream` and rewrites the URL to
        // /model/{id}/invoke-with-response-stream automatically.
        // It also injects `anthropic_version: bedrock-2023-05-31` and
        // hoists the `anthropic-beta` header into the body for us.
        const anthropicRequestParams = {
          ...baseModelParams,
          model: resolvedModelId,
          stream: true,
        };
        promptCacheBreakMonitor.recordOutgoingRequest({
          sessionId,
          assistantMessageId,
          providerPath: 'anthropic',
          modelId: getPromptCacheRequestModelId(
            anthropicRequestParams,
            resolvedModelId
          ),
          apiProvider: currentAnthropicProvider,
          request: anthropicRequestParams,
        });
        stream = await bedrockClient.messages.create(
          anthropicRequestParams as Anthropic.MessageCreateParamsStreaming,
          {
            signal: localAbortController.signal,
            headers: requestHeaders,
          }
        );
      } else {
        const anthropicClient = ensureAnthropicClient(httpCustomModel);

        // Use raw streaming (messages.create with stream:true) instead of
        // messages.stream() to avoid the SDK's MessageStream event order
        // validation. Third-party BYOK proxies can send malformed SSE streams
        // (e.g. duplicate message_start without message_stop) which crash the
        // SDK's accumulator. Our processAnthropicChunk handles each event
        // independently and is resilient to protocol violations.
        const anthropicRequestParams = { ...baseModelParams, stream: true };
        promptCacheBreakMonitor.recordOutgoingRequest({
          sessionId,
          assistantMessageId,
          providerPath: 'anthropic',
          modelId: getPromptCacheRequestModelId(anthropicRequestParams, model),
          apiProvider: currentAnthropicProvider,
          request: anthropicRequestParams,
        });
        stream = await anthropicClient.messages.create(
          anthropicRequestParams as Anthropic.MessageCreateParamsStreaming,
          {
            signal: localAbortController.signal,
            headers: requestHeaders,
          }
        );
      }

      try {
        for await (const event of stream) {
          if (localAbortController.signal.aborted) {
            break;
          }
          // Record TTFT on first content block (any type: text, tool_use, thinking)
          if (
            event.type === 'content_block_start' ||
            event.type === 'content_block_delta'
          ) {
            recordTimeToFirstToken();
          }
          processAnthropicChunk(
            event,
            state,
            callbacks,
            cliChunkProcessingOptions
          );
        }
      } catch (streamError) {
        // Let abort errors propagate cleanly without Anthropic error
        // mapping — otherwise undici errors like TypeError("terminated")
        // get classified as LLMNetworkError, which prevents the
        // onAllError isAbortError() short-circuit and can turn a
        // user-cancel into retries or a misleading network-error message.
        if (isAbortError(streamError) || localAbortController.signal.aborted) {
          throw streamError;
        }
        if (usingBedrockClient) {
          throw mapBedrockReaderError(streamError);
        }
        throw mapAnthropicReaderError(streamError);
      }

      // The raw create({stream:true}) iterator exits cleanly on abort
      // instead of throwing like the SDK's MessageStream. Throw an
      // AbortError so the retry wrapper returns ABORTED_RESULT and
      // the agent loop treats this as a cancellation, not a successful
      // empty completion.
      if (localAbortController.signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }

      maybeRecordCustomModelUsage({
        customModel,
        model,
        state,
        sessionId,
        assistantMessageId,
      });

      logProviderResponseDiagnostics({
        state,
        model,
        providerName: provider,
        wasAborted: localAbortController.signal.aborted,
      });

      assertNonEmptyLLMResponse({
        state,
        wasAborted: localAbortController.signal.aborted,
        expectsText,
        modelId: model,
        providerName: provider,
        retryState: emptyResponseRetryState,
      });

      return buildProviderResultFromState({
        state,
        wasAborted: localAbortController.signal.aborted,
        usedApiProvider: currentAnthropicProvider,
      });
    };

    const result = await retry(attemptStream, {
      ...deps.platform.getRetryConfig({ strategy: retryStrategy }),
      // 404 is non-retryable on the same endpoint but recoverable via
      // provider rotation. Extend retryability when rotation is available.
      ...(!customModel && {
        isRetryableError: (error: unknown) =>
          isRetryableLLMError(error) || isRetryableOnAnotherProvider(error),
      }),
      signal: localAbortController.signal,
      ...createLlmRetryHandlers({
        model,
        getApiProvider: () => currentAnthropicProvider,
        getRawRequest: () => safeStringify(baseModelParams),
        wireProvider: 'anthropic',
        sessionId,
        assistantMessageId,
        allowContextLimitS3Logging,
        onRetryAfterLog: (error) => {
          // Rotation is only meaningful for proxy-routed requests. Custom
          // models (including Bedrock-routed ones) talk directly to the
          // user's endpoint, so there is nothing to rotate to.
          if (!customModel) {
            const previousProvider = currentAnthropicProvider;
            const shouldBypassLockedProvider =
              isProviderCapacityError(error) || isOverloadedError(error);
            // The provider lock is sticky, not hard: capacity/overload signals
            // mean the locked proxy is unhealthy, so retry through the next provider.
            currentAnthropicProvider = deps.platform.getNextProvider({
              model,
              currentProvider: currentAnthropicProvider,
              onRotate: callbacks.onProviderRotate,
              lockedProvider: shouldBypassLockedProvider
                ? null
                : lockedApiProvider,
            });
            didRotateAnthropicProvider =
              didRotateAnthropicProvider ||
              currentAnthropicProvider !== previousProvider;
          }
        },
      }),
    })();

    const successfulProvider = result.usedApiProvider;
    if (
      !customModel &&
      !result.wasAborted &&
      successfulProvider &&
      (didRotateAnthropicProvider || lockedApiProvider !== null)
    ) {
      deps.session.updateLockedApiProvider?.(successfulProvider);
    }

    return result;
  };

  const sendOpenAIMessage = async ({
    conversationHistory,
    systemMessage,
    callbacks,
    sessionId,
    assistantMessageId,
    allowContextLimitS3Logging,
    maxTokensOverride,
    expectsText,
    model,
    provider,
    config,
    customModel,
    reasoningEffort,
    isSpecMode,
    outputFormat,
  }: ProviderMessageParams): Promise<SendApiProviderMessageResult> => {
    const bedrockOpenAIEnabled = isOpenAIBedrockCustomModel(customModel);
    const httpCustomModel = getRequiredHttpCustomModel(customModel);
    if (!bedrockOpenAIEnabled) {
      ensureOpenAIClient(httpCustomModel);
    }

    let currentResponsesProvider: ApiProvider | undefined = bedrockOpenAIEnabled
      ? ApiProvider.BEDROCK_OPENAI
      : undefined;
    // The session API-provider lock is sticky, not hard: capacity/server-error
    // signals (e.g. a Bedrock `server_error`) mean the locked proxy provider is
    // unhealthy, so retries bypass the lock and rotate (mirrors the Anthropic
    // path). Custom models route directly and never rotate.
    const lockedResponsesProvider = customModel
      ? null
      : (deps.session.getLockedApiProvider() ?? null);
    let didRotateResponsesProvider = false;
    if (!customModel) {
      currentResponsesProvider = resolveProxyApiProvider(
        model,
        provider,
        deps.platform.region(),
        lockedResponsesProvider ?? undefined
      );
      if (
        lockedResponsesProvider !== null &&
        currentResponsesProvider !== lockedResponsesProvider
      ) {
        logWarn(
          '[useLLMStreaming] Corrected API provider lock for send (responses path)',
          {
            sessionId,
            assistantMessageId,
            modelId: model,
            apiProvider: lockedResponsesProvider,
            reason: 'incompatible with model family',
            modelProvider: provider,
            correctedApiProvider: currentResponsesProvider,
            path: 'responses',
          }
        );
      }
    }
    const localAbortController = setupAbortAndNotify(callbacks);
    const streamStartTime = Date.now();
    const recordTimeToFirstToken = createTimeToFirstTokenRecorder({
      model,
      provider,
      isSpecMode,
      streamStartTime,
      getApiProvider: () => currentResponsesProvider,
      getBaseUrl: () =>
        customModel ? getCustomModelUsageBaseUrl(customModel) : undefined,
    });

    const { tools: allTools } = await resolveTurnTools(
      deps,
      sessionId,
      outputFormat
    );

    // Notify streaming state manager (only once across retries)
    if (callbacks.onMessageStart) {
      callbacks.onMessageStart();
    }

    const emptyResponseRetryState = createEmptyResponseRetryState();
    // Empty-response budget escalation persists across retries even though the
    // provider-dependent request shaping below is rebuilt per attempt so a
    // mid-flight provider rotation actually takes effect.
    let escalatedMaxOutputTokens: number | undefined;
    // Snapshot of the last attempt's request, captured for retry diagnostics
    // (`getRawRequest`) since the request is now built inside `attemptStream`.
    let lastResponsesRawRequest: Record<string, unknown> | undefined;
    // Single-attempt streaming helper
    const attemptStream = async (): Promise<SendApiProviderMessageResult> => {
      const openAIResponsesConversionOptions =
        currentResponsesProvider === ApiProvider.BEDROCK_OPENAI
          ? ({ applyPatchToolMode: 'function' } as const)
          : undefined;

      // Convert Anthropic messages to OpenAI Responses format
      const input: OpenAI.Responses.ResponseInputItem[] =
        await convertDroolToOpenAIMessages(
          conversationHistory,
          openAIResponsesConversionOptions
        );

      // Proxy requests use the session API-provider lock. Custom models route
      // directly and only use currentResponsesProvider for telemetry/request
      // shaping.
      const headers = customModel
        ? {
            ...(customModel.extraHeaders ?? {}),
            ...(bedrockOpenAIEnabled
              ? {}
              : getOpenAIPlatformHeadersForCustomModel(customModel)),
            'User-Agent': deps.platform.userAgent(),
          }
        : await deps.platform.createProxyHeaders({
            sessionId,
            assistantMessageId,
            proxyApiProvider: currentResponsesProvider,
          });

      // Get OpenAI request config from centralized provider utility
      const openaiRequestConfig = configureOpenAIRequest({
        modelId: model,
        reasoningEffort,
        effectiveModelId: config?.id,
        sessionId: sessionId ?? '',
        apiProvider: currentResponsesProvider ?? ApiProvider.OPENAI,
        maxOutputTokens:
          maxTokensOverride ??
          customModel?.maxOutputTokens ??
          config?.contextLimits(reasoningEffort).maxOutputTokens ??
          CLAUDE_MAX_OUTPUT_TOKENS,
        // Pass model provider for custom models not in registry
        modelProvider: provider,
        // BYOK custom endpoints (often Azure OpenAI) must not receive
        // OpenAI-direct-only request params like extended cache retention.
        isCustomModel: !!customModel,
      });
      escalatedMaxOutputTokens =
        applyEmptyResponseBudgetEscalation({
          retryState: emptyResponseRetryState,
          currentMaxTokens:
            escalatedMaxOutputTokens ??
            openaiRequestConfig.requestParams.max_output_tokens,
          ceiling:
            customModel?.maxOutputTokens ??
            config?.contextLimits(reasoningEffort).maxOutputTokens,
        }) ??
        escalatedMaxOutputTokens ??
        openaiRequestConfig.requestParams.max_output_tokens;
      openaiRequestConfig.requestParams.max_output_tokens =
        escalatedMaxOutputTokens;
      const responsesTools = convertAnthropicToOpenAITools(
        allTools,
        openAIResponsesConversionOptions
      );
      lastResponsesRawRequest = {
        model,
        input,
        store: false,
        tools: responsesTools,
        instructions: systemMessage.map((block) => block.text).join('\n\n'),
        stream: true,
        ...openaiRequestConfig.requestParams,
      };
      let requestModel = model;
      let openaiClient: OpenAI;
      if (bedrockOpenAIEnabled) {
        const resolved = await ensureBedrockOpenAIClient(
          customModel!.model,
          customModel!.bedrock!,
          localAbortController.signal
        );
        openaiClient = resolved.client;
        requestModel = resolved.resolvedModelId;
      } else {
        openaiClient = ensureOpenAIClient(httpCustomModel);
      }
      const responsesRequestParams = {
        ...lastResponsesRawRequest,
        model: requestModel,
        ...(customModel?.extraArgs ?? {}),
      } as OpenAI.Responses.ResponseCreateParamsStreaming;
      if (
        httpCustomModel &&
        'codingSubscriptionProvider' in httpCustomModel &&
        httpCustomModel.codingSubscriptionProvider === 'codex'
      ) {
        delete (responsesRequestParams as Record<string, unknown>)
          .prompt_cache_retention;
        delete (responsesRequestParams as Record<string, unknown>)
          .safety_identifier;
        delete (responsesRequestParams as Record<string, unknown>)
          .stream_options;
      }

      promptCacheBreakMonitor.recordOutgoingRequest({
        sessionId,
        assistantMessageId,
        providerPath: 'openai_responses',
        modelId: getPromptCacheRequestModelId(
          responsesRequestParams,
          requestModel
        ),
        apiProvider: currentResponsesProvider,
        request: responsesRequestParams,
      });

      const state = createInitialStreamingState();
      const toolCalls: Record<number, ToolCallInfo | undefined> = {};
      const stream = await openaiClient.responses.create(
        responsesRequestParams,
        {
          signal: localAbortController.signal,
          headers,
        }
      );

      try {
        for await (const chunk of stream) {
          if (localAbortController.signal.aborted) {
            break;
          }
          // Record TTFT on first meaningful content (text, tool call, or reasoning)
          if (
            chunk.type === 'response.output_item.added' ||
            chunk.type === 'response.output_text.delta' ||
            chunk.type === 'response.reasoning_summary_text.delta' ||
            chunk.type === 'response.reasoning_text.delta' ||
            chunk.type === 'response.function_call_arguments.delta'
          ) {
            recordTimeToFirstToken();
          }

          processOpenAIChunk(
            chunk,
            state,
            toolCalls,
            callbacks,
            cliChunkProcessingOptions
          );
        }
      } catch (streamError) {
        if (isAbortError(streamError) || localAbortController.signal.aborted) {
          throw streamError;
        }
        if (bedrockOpenAIEnabled) {
          throw mapBedrockOpenAIReaderError(streamError);
        }
        throw mapStreamReaderError(streamError);
      }

      if (customModel) {
        void deps.platform.recordCustomModelUsage({
          model,
          baseUrl: getCustomModelUsageBaseUrl(customModel),
          usage: state.usage,
          sessionId,
          messageId: assistantMessageId,
        });
      }

      logProviderResponseDiagnostics({
        state,
        model,
        providerName: provider,
        wasAborted: localAbortController.signal.aborted,
      });

      assertNonEmptyLLMResponse({
        state,
        wasAborted: localAbortController.signal.aborted,
        expectsText,
        modelId: model,
        providerName: provider,
        retryState: emptyResponseRetryState,
      });

      return {
        ...buildProviderResultFromState({
          state,
          wasAborted: localAbortController.signal.aborted,
          usedApiProvider: currentResponsesProvider,
        }),
        openaiMessageId: state.openaiMessageId,
        openaiPhase: state.openaiPhase,
        openaiEncryptedContent: state.openaiEncryptedContent,
        openaiReasoningId: state.openaiReasoningId,
        openaiReasoningSummary: state.openaiReasoningSummary,
      };
    };
    const result = await withSendMessageRetry(
      attemptStream,
      localAbortController.signal,
      createLlmRetryHandlers({
        model,
        getApiProvider: () => currentResponsesProvider,
        getRawRequest: () => safeStringify(lastResponsesRawRequest ?? {}),
        wireProvider: 'openai',
        sessionId,
        assistantMessageId,
        allowContextLimitS3Logging,
        onRetryAfterLog: (error) => {
          // Rotation is only meaningful for proxy-routed requests. Custom
          // models (including Bedrock-routed ones) talk directly to the user's
          // endpoint, so there is nothing to rotate to.
          if (!customModel) {
            const previousProvider = currentResponsesProvider;
            const shouldBypassLockedProvider =
              isProviderCapacityError(error) || isOverloadedError(error);
            // Honor the sticky lock only while we are still on it and have not
            // already rotated. Once a capacity/server error has rotated us off
            // the locked provider, a later non-capacity retry must not snap
            // back to it via `getNextProvider`'s lock short-circuit.
            const honorLockedProvider =
              !shouldBypassLockedProvider &&
              !didRotateResponsesProvider &&
              currentResponsesProvider === lockedResponsesProvider;
            currentResponsesProvider = deps.platform.getNextProvider({
              model,
              currentProvider: currentResponsesProvider,
              onRotate: callbacks.onProviderRotate,
              lockedProvider: honorLockedProvider
                ? lockedResponsesProvider
                : null,
            });
            didRotateResponsesProvider =
              didRotateResponsesProvider ||
              currentResponsesProvider !== previousProvider;
          }
        },
      })
    );

    const successfulProvider = result.usedApiProvider;
    if (
      !customModel &&
      !result.wasAborted &&
      successfulProvider &&
      (didRotateResponsesProvider || lockedResponsesProvider !== null)
    ) {
      deps.session.updateLockedApiProvider?.(successfulProvider);
    }

    return result;
  };

  const sendOpenAIChatMessage = async ({
    conversationHistory,
    systemMessage,
    callbacks,
    sessionId,
    assistantMessageId,
    allowContextLimitS3Logging,
    maxTokensOverride,
    expectsText,
    model,
    provider,
    config,
    customModel,
    reasoningEffort,
    isSpecMode,
    outputFormat,
  }: ProviderMessageParams): Promise<SendApiProviderMessageResult> => {
    const existingChatLock = deps.session.getLockedApiProvider() ?? undefined;
    let didRotateChatCompletionsProvider = false;
    let chatCompletionsApiProvider = customModel
      ? undefined
      : deps.platform.getNextProvider({
          model,
          currentProvider: currentChatCompletionsProvider,
          lockedProvider: existingChatLock,
          rotateIfValid: false,
        });

    if (!customModel) {
      currentChatCompletionsProvider = chatCompletionsApiProvider;
    }

    const httpCustomModel = getRequiredHttpCustomModel(customModel);
    ensureOpenAIClient(httpCustomModel);

    const localAbortController = setupAbortAndNotify(callbacks);
    const streamStartTime = Date.now();
    const recordTimeToFirstToken = createTimeToFirstTokenRecorder({
      model,
      provider,
      isSpecMode,
      streamStartTime,
      getApiProvider: () =>
        customModel ? undefined : chatCompletionsApiProvider,
      getBaseUrl: () =>
        customModel ? getCustomModelUsageBaseUrl(customModel) : undefined,
    });

    // Convert Anthropic messages to OpenAI Chat Completions format.
    // The converter internally resolves whether reasoning fields should be
    // included based on the model registry + custom-model enableThinking flag.
    const chatCompletionsInteropProvider =
      resolveChatCompletionsInteropProvider(model, provider, customModel);

    const { tools: allToolsForChat } = await resolveTurnTools(
      deps,
      sessionId,
      outputFormat
    );

    const messages = convertDroolToOpenAiChatMessages(
      conversationHistory,
      model,
      chatCompletionsInteropProvider,
      {
        enableThinking: customModel?.enableThinking,
        modelCapabilities: deps.platform.modelCapabilities,
      }
    );

    // Add system message at the beginning
    const systemContent = systemMessage.map((block) => block.text).join('\n\n');
    messages.unshift({
      role: 'system',
      content: systemContent,
    });

    // `createProxyHeaders` auto-attaches `OpenAI-Platform` for OpenAI-backed
    // routes; for BYOK we attach it here via `getOpenAIPlatformHeadersForCustomModel`.
    const customModelHeaders = customModel
      ? {
          ...(customModel.extraHeaders ?? {}),
          ...getOpenAIPlatformHeadersForCustomModel(customModel),
          'User-Agent': deps.platform.userAgent(),
        }
      : undefined;

    const includeStreamUsage = getFlag(
      IndustryFeatureFlags.ByokIncludeStreamUsage
    );
    const chatTools = convertAnthropicToOpenAIChatTools(allToolsForChat);

    const baseCreateParams: Record<string, unknown> = {
      model,
      messages,
      tools: chatTools,
      stream: true,
      ...(includeStreamUsage
        ? { stream_options: { include_usage: true } }
        : {}),
      max_tokens:
        maxTokensOverride ??
        customModel?.maxOutputTokens ??
        config?.contextLimits(reasoningEffort).maxOutputTokens ??
        CLAUDE_MAX_OUTPUT_TOKENS,
      temperature: 1.0,
    };

    let activeReasoningEffort = reasoningEffort;
    let lastCreateParams: Record<string, unknown> | undefined;
    const buildCreateParams = (): Record<string, unknown> => {
      const requestReasoningEffort =
        resolveChatCompletionsProviderReasoningEffort({
          apiProvider: chatCompletionsApiProvider,
          config,
          reasoningEffort,
        });

      if (requestReasoningEffort !== activeReasoningEffort) {
        callbacks.onReasoningEffortChange?.(
          activeReasoningEffort,
          requestReasoningEffort
        );
        activeReasoningEffort = requestReasoningEffort;
      }

      const reasoningRequestConfig =
        resolveChatCompletionsReasoningRequestConfig({
          apiProvider: chatCompletionsApiProvider,
          customModel,
          customModelSupportedEfforts: customModel
            ? getCustomModelSupportedEfforts(
                customModel.reasoningEffort,
                customModel.model
              )
            : undefined,
          config,
          reasoningEffort: requestReasoningEffort,
          model,
        });

      const params: Record<string, unknown> = {
        ...baseCreateParams,
        ...reasoningRequestConfig,
        ...(chatCompletionsProviderParams({
          apiProvider: chatCompletionsApiProvider,
          hasCustomModel: !!customModel,
          customModelThinkingEnabled: customModel?.enableThinking,
          supportsThinkingToggle:
            config?.reasoningEffort.supported.some(hasReasoningEnabled),
          reasoningEffort: requestReasoningEffort,
          modelConfig: config,
        }) ?? {}),
        ...(customModel?.extraArgs ?? {}),
      };

      // Allow extraArgs to remove stream_options for strict BYOK proxies
      // (e.g. "extraArgs": { "stream_options": null })
      if (params.stream_options == null) {
        delete params.stream_options;
      }

      // Strict OpenAI-compatible providers (e.g. NVIDIA vLLM) reject an empty
      // `tools: []` with `400 'tools' must not be an empty array`. Tools-less
      // calls (e.g. the compaction summarization sub-request) must omit the
      // field entirely; also drop an orphaned `tool_choice`, which is invalid
      // without `tools`.
      if (Array.isArray(params.tools) && params.tools.length === 0) {
        delete params.tools;
        delete params.tool_choice;
      }

      return params;
    };

    // Notify streaming state manager (only once across retries)
    if (callbacks.onMessageStart) {
      callbacks.onMessageStart();
    }

    const emptyResponseRetryState = createEmptyResponseRetryState();

    // Single-attempt streaming helper
    const attemptStream = async (): Promise<SendApiProviderMessageResult> => {
      baseCreateParams.max_tokens =
        applyEmptyResponseBudgetEscalation({
          retryState: emptyResponseRetryState,
          currentMaxTokens: baseCreateParams.max_tokens,
          ceiling:
            customModel?.maxOutputTokens ??
            config?.contextLimits(reasoningEffort).maxOutputTokens,
        }) ?? baseCreateParams.max_tokens;
      const openaiClient = ensureOpenAIClient(httpCustomModel);

      const state = createInitialStreamingState(chatCompletionsInteropProvider);
      const toolCalls: Record<number, ToolCallInfo | undefined> = {};
      const headers =
        customModelHeaders ??
        (await deps.platform.createProxyHeaders({
          sessionId,
          assistantMessageId,
          proxyApiProvider: chatCompletionsApiProvider,
        }));
      const createParams = buildCreateParams();
      lastCreateParams = createParams;
      promptCacheBreakMonitor.recordOutgoingRequest({
        sessionId,
        assistantMessageId,
        providerPath: 'openai_chat',
        modelId: getPromptCacheRequestModelId(createParams, model),
        apiProvider: customModel ? undefined : chatCompletionsApiProvider,
        request: createParams,
      });
      const { data: stream, response } = await openaiClient.chat.completions
        .create(
          createParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
          {
            signal: localAbortController.signal,
            headers,
          }
        )
        .withResponse();

      try {
        for await (const chunk of stream) {
          if (localAbortController.signal.aborted) {
            break;
          }
          // Record TTFT on first content (text, tool calls, or reasoning)
          if (chunk.choices) {
            for (const choice of chunk.choices) {
              if (hasOpenAIChatTimeToFirstTokenDelta(choice)) {
                recordTimeToFirstToken();
                break;
              }
            }
          }

          processOpenAIChatChunk(
            chunk,
            state,
            toolCalls,
            callbacks,
            response.headers,
            cliChunkProcessingOptions
          );
        }
      } catch (streamError) {
        if (isAbortError(streamError) || localAbortController.signal.aborted) {
          throw streamError;
        }
        throw mapStreamReaderError(streamError);
      }

      if (localAbortController.signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }

      if (customModel) {
        void deps.platform.recordCustomModelUsage({
          model,
          baseUrl: getCustomModelUsageBaseUrl(customModel),
          usage: state.usage,
          sessionId,
          messageId: assistantMessageId,
        });
      }

      logProviderResponseDiagnostics({
        state,
        model,
        providerName: provider,
        wasAborted: localAbortController.signal.aborted,
      });

      assertNonEmptyLLMResponse({
        state,
        wasAborted: localAbortController.signal.aborted,
        expectsText,
        modelId: model,
        providerName: provider,
        retryState: emptyResponseRetryState,
      });

      return {
        ...buildProviderResultFromState({
          state,
          wasAborted: localAbortController.signal.aborted,
          usedApiProvider: customModel ? undefined : chatCompletionsApiProvider,
        }),
        openaiMessageId: state.openaiMessageId,
        openaiPhase: state.openaiPhase,
        openaiEncryptedContent: undefined,
        openaiReasoningId: undefined,
        toolCallSignatures: state.toolCallSignatures,
        chatCompletionReasoningField: state.chatCompletionReasoningField,
        chatCompletionReasoningContent: state.chatCompletionReasoningContent,
      };
    };

    const result = await withSendMessageRetry(
      attemptStream,
      localAbortController.signal,
      createLlmRetryHandlers({
        model,
        getApiProvider: () =>
          customModel ? undefined : chatCompletionsApiProvider,
        getRawRequest: () =>
          safeStringify(lastCreateParams ?? baseCreateParams),
        wireProvider: 'generic_chat_completion',
        sessionId,
        assistantMessageId,
        allowContextLimitS3Logging,
        onRetryAfterLog: () => {
          if (!customModel) {
            const previousProvider = currentChatCompletionsProvider;
            currentChatCompletionsProvider = deps.platform.getNextProvider({
              model,
              currentProvider: currentChatCompletionsProvider,
              onRotate: callbacks.onProviderRotate,
              lockedProvider: existingChatLock,
            });
            didRotateChatCompletionsProvider =
              didRotateChatCompletionsProvider ||
              currentChatCompletionsProvider !== previousProvider;
            chatCompletionsApiProvider = currentChatCompletionsProvider;
          }
        },
      })
    );

    const successfulProvider = result.usedApiProvider;
    if (
      !customModel &&
      !result.wasAborted &&
      successfulProvider &&
      (didRotateChatCompletionsProvider || existingChatLock !== undefined)
    ) {
      deps.session.updateLockedApiProvider?.(successfulProvider);
    }

    return result;
  };

  // Gemini Native message sender
  const sendGeminiNativeMessage = async ({
    conversationHistory,
    systemMessage,
    callbacks,
    sessionId,
    assistantMessageId,
    allowContextLimitS3Logging,
    expectsText,
    model,
    provider,
    reasoningEffort,
    isSpecMode,
    outputFormat,
  }: ProviderMessageParams): Promise<SendApiProviderMessageResult> => {
    const localAbortController = setupAbortAndNotify(callbacks);
    const streamStartTime = Date.now();
    const recordTimeToFirstToken = createTimeToFirstTokenRecorder({
      model,
      provider,
      isSpecMode,
      streamStartTime,
      getApiProvider: () => ApiProvider.GOOGLE,
    });

    // Convert messages and tools using shared converters
    const { tools: allTools } = await resolveTurnTools(
      deps,
      sessionId,
      outputFormat
    );
    const geminiTools = convertAnthropicToolsToGemini(allTools);

    // Convert and curate conversation history
    const rawContents = convertDroolToGeminiContents(conversationHistory);
    const curatedContents = extractCuratedGeminiHistory(rawContents);
    const contents = ensureGeminiThoughtSignatures(curatedContents);

    // Build request body
    const systemContent = systemMessage.map((block) => block.text).join('\n\n');

    // Get Gemini thinking config from registry
    const geminiConfig = configureGeminiRequest({
      modelId: model,
      reasoningEffort,
    });
    const requestBody = {
      model,
      contents,
      systemInstruction: systemContent
        ? { parts: [{ text: systemContent }] }
        : undefined,
      tools:
        geminiTools.length > 0
          ? [{ functionDeclarations: geminiTools }]
          : undefined,
      generationConfig: geminiConfig.generationConfig,
    };

    callbacks.onMessageStart?.();

    const emptyResponseRetryState = createEmptyResponseRetryState();

    const attemptStream = async (): Promise<SendApiProviderMessageResult> => {
      // The native Gemini request has no adjustable output cap, so an empty
      // retry cannot grow its budget the way the other providers do. Drop any
      // escalation the empty-response guard armed rather than carry it unused.
      emptyResponseRetryState.outputBudgetEscalationFactor = undefined;

      const state = createInitialStreamingState();

      const headers = await deps.platform.createProxyHeaders({
        sessionId,
        assistantMessageId,
        proxyApiProvider: ApiProvider.GOOGLE,
      });

      let response: Response;
      try {
        promptCacheBreakMonitor.recordOutgoingRequest({
          sessionId,
          assistantMessageId,
          providerPath: 'gemini',
          modelId: getPromptCacheRequestModelId(requestBody, model),
          apiProvider: ApiProvider.GOOGLE,
          request: requestBody,
        });
        response = await deps.platform.customFetch(
          getGeminiEndpoint(deps.platform.apiBaseUrl(), model),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(requestBody),
            signal: localAbortController.signal,
          }
        );
      } catch (fetchError) {
        // customFetch throws FetchError for non-OK responses — classify
        // into the LLM error hierarchy via the Google error mapper.
        if (fetchError instanceof FetchError) {
          const status = fetchError.response.status;
          // FetchError.message format: "${status} ${errorBody}" or "${status} Fetch failed"
          const bodyText = fetchError.message.replace(/^\d+\s*/, '');
          // Try to parse the error body as Google API error JSON
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(bodyText);
          } catch (parseError) {
            // Body wasn't JSON — fall back to passing a synthesized
            // shape into the Google error mapper below.
            logWarn(
              '[sendGeminiNativeMessage] Non-JSON Gemini error body, using raw text',
              { cause: parseError }
            );
            parsedBody = undefined;
          }
          // Use existing Google error mapper to produce LLMThrottlingError, LLMInternalError, etc.
          const mappedError = mapGoogleError(
            parsedBody ?? { status, message: bodyText || fetchError.message }
          );
          markDroolCoreLlmRequestError(mappedError);
          throw mappedError;
        }
        throw fetchError;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new MetaError('No response body from Gemini proxy');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done || localAbortController.signal.aborted) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let chunk: GenerateContentResponse;
          try {
            chunk = JSON.parse(data) as GenerateContentResponse;
          } catch (parseError) {
            // Skip malformed SSE events — providers occasionally emit
            // partial JSON during reconnects. Log once at warn so the
            // pattern is visible without flooding.
            logWarn('[sendGeminiNativeMessage] Skipping malformed SSE chunk', {
              cause: parseError,
            });
            continue;
          }
          if (chunk.candidates?.[0]?.content) {
            recordTimeToFirstToken();
          }
          processGeminiSSEChunk(
            chunk,
            state,
            callbacks,
            cliChunkProcessingOptions
          );
        }
      }

      callbacks.onMessageComplete?.();

      logProviderResponseDiagnostics({
        state,
        model,
        providerName: provider,
        wasAborted: localAbortController.signal.aborted,
      });

      assertNonEmptyLLMResponse({
        state,
        wasAborted: localAbortController.signal.aborted,
        expectsText,
        modelId: model,
        providerName: provider,
        retryState: emptyResponseRetryState,
      });

      return {
        ...buildProviderResultFromState({
          state,
          wasAborted: localAbortController.signal.aborted,
          usedApiProvider: ApiProvider.GOOGLE,
        }),
        openaiMessageId: undefined,
        openaiEncryptedContent: undefined,
        openaiReasoningId: undefined,
        toolCallSignatures: state.toolCallSignatures,
        chatCompletionReasoningField: state.thinkingContent
          ? ChatCompletionReasoningField.Reasoning
          : undefined,
        chatCompletionReasoningContent: state.thinkingContent,
      };
    };

    return withSendMessageRetry(
      attemptStream,
      localAbortController.signal,
      createLlmRetryHandlers({
        model,
        getApiProvider: () => ApiProvider.GOOGLE,
        getRawRequest: () => safeStringify(requestBody),
        wireProvider: 'gemini',
        sessionId,
        assistantMessageId,
        allowContextLimitS3Logging,
      })
    );
  };

  const getProxyRouteForProvider = (
    modelProvider: ModelProvider,
    apiModelProvider?: ModelProvider
  ) => {
    // E2E mock provider — intercepts all LLM calls when enabled
    if (deps.platform.isE2EMockEnabled() && deps.platform.sendE2EMockMessage) {
      const sendE2EMockMessage = deps.platform.sendE2EMockMessage;
      return async (
        params: ProviderMessageParams
      ): Promise<SendApiProviderMessageResult> => {
        const localAbortController = setupAbortAndNotify(params.callbacks);

        try {
          return await sendE2EMockMessage({
            ...params,
            signal: localAbortController.signal,
          });
        } catch (error) {
          if (isAbortError(error) || localAbortController.signal.aborted) {
            return ABORTED_RESULT;
          }
          throw error;
        }
      };
    }

    // Native Bedrock Converse BYOK — checked before the Anthropic /
    // first-party branches. Anthropic-on-Bedrock is unaffected (it routes
    // via ModelProvider.ANTHROPIC + the `bedrock` block, not this provider).
    if (modelProvider === ModelProvider.BEDROCK_CONVERSE) {
      return sendBedrockConverseMessage;
    }

    if (isGoogleProvider(modelProvider)) {
      return sendGeminiNativeMessage;
    }

    if (modelProvider === ModelProvider.INDUSTRY) {
      // Fireworks Anthropic-compat models (e.g., MiniMax) use the Anthropic SDK path
      if (apiModelProvider === ModelProvider.ANTHROPIC) {
        return sendAnthropicMessage;
      }
      return sendOpenAIChatMessage;
    }

    if (modelProvider === ModelProvider.GENERIC_CHAT_COMPLETION_API) {
      return sendOpenAIChatMessage;
    }

    if (shouldUseResponsesAPI(modelProvider)) {
      return sendOpenAIMessage;
    }

    if (modelProvider === ModelProvider.ANTHROPIC) {
      return sendAnthropicMessage;
    }

    // Default fallback to chat completions for unknown providers
    return sendOpenAIChatMessage;
  };

  const sendMessage = async ({
    conversationHistory,
    systemMessage,
    callbacks,
    sessionId,
    assistantMessageId,
    allowContextLimitS3Logging,
    maxTokensOverride,
    expectsText,
    modelId,
    isSpecMode: isSpecModeOverride,
    reasoningEffort: reasoningEffortOverride,
    minimizeReasoning,
    outputFormat,
  }: SendMessageParams): Promise<StreamingResult> => {
    const outcomeRecorder = new ChatOutcomeRecorder({
      successMetric: Metric.DROOL_CHAT_CLIENT_SUCCESS_COUNT,
      failureMetric: Metric.DROOL_CHAT_CLIENT_FAILURE_COUNT,
    });

    outcomeRecorder.setRequestMetadata({
      sessionId,
      assistantMessageId,
    });

    try {
      // SessionService.getModel translates Router → an engine-dispatchable
      // built-in or BYOK custom id at the storage boundary.
      const modelCtx = resolveModelContext({
        modelId,
        isSpecMode: isSpecModeOverride,
        reasoningEffort: reasoningEffortOverride,
        minimizeReasoning,
      });
      if (modelCtx.deprecatedModelFallback) {
        logInfo('[sendMessage] Hard-deprecated model fallback applied', {
          modelId: modelCtx.deprecatedModelFallback.deprecatedModelId,
          fallbackModelId: modelCtx.deprecatedModelFallback.fallbackModelId,
        });
        applyDeprecatedModelFallback(
          deps.session,
          modelCtx.deprecatedModelFallback,
          {
            isSpecMode: modelCtx.isSpecMode,
            persistNotice:
              deps.getRetryStrategy() === RetryStrategy.Interactive,
          }
        );
      }

      outcomeRecorder.setModelId(
        (modelCtx.config?.id ?? modelCtx.model) as ModelID
      );

      const toolsForLogging = await resolveTurnTools(
        deps,
        sessionId,
        outputFormat
      );
      const effectiveMaxTokensOverride = resolveMaxTokensWithReasoningHeadroom({
        maxTokensOverride,
        expectsText,
        reasoningEffort: modelCtx.reasoningEffort,
        modelMaxOutputTokens: modelCtx.config?.contextLimits(
          modelCtx.reasoningEffort
        ).maxOutputTokens,
        customMaxOutputTokens: modelCtx.customModel?.maxOutputTokens,
      });

      logInfo('[LLM] sendMessage', {
        messageThreadLength: conversationHistory.length,
        toolCount: toolsForLogging.tools.length,
        modelId: modelCtx.model,
        isSpecMode: modelCtx.isSpecMode,
        reasoningEffort: modelCtx.reasoningEffort,
        ...(effectiveMaxTokensOverride !== undefined
          ? { maxTokensOverride: effectiveMaxTokensOverride }
          : {}),
      });

      // Strip images for models that don't support them (e.g., GLM-5, MiniMax M2.5)
      const modelImagesDisabled =
        modelCtx.config?.images === false ||
        modelCtx.customModel?.noImageSupport === true;
      const preparedHistory = modelImagesDisabled
        ? stripImagesFromConversation(conversationHistory)
        : conversationHistory;

      // Sanitize broken Unicode surrogate pairs before sending to providers.
      // Tool outputs (file reads, command output) can contain lone surrogates
      // that produce invalid JSON when serialized, causing 400s from Anthropic/Vertex.
      const sanitizedHistory =
        deps.platform.sanitizeDeepToWellFormed(preparedHistory);
      const sanitizedSystemMessage =
        deps.platform.sanitizeDeepToWellFormed(systemMessage);

      // Pass all resolved values to provider functions
      const request: ProviderMessageParams = {
        conversationHistory: sanitizedHistory,
        systemMessage: sanitizedSystemMessage,
        callbacks,
        sessionId,
        assistantMessageId,
        allowContextLimitS3Logging,
        maxTokensOverride: effectiveMaxTokensOverride,
        expectsText,
        outputFormat,
        ...modelCtx,
      };
      const {
        toolUses,
        finalStreamingContent,
        usage,
        toolInputBuffers,
        openaiMessageId,
        openaiPhase,
        openaiEncryptedContent,
        openaiReasoningId,
        openaiReasoningSummary,
        toolCallSignatures,
        chatCompletionReasoningField,
        chatCompletionReasoningContent,
        contentBlocks,
        wasAborted,
        thinkingContent,
        thinkingSignature,
        usedApiProvider,
        stopReason,
        stopDetails,
      } = await runWithLimiter(deps.requestLimiter, () =>
        getProxyRouteForProvider(
          modelCtx.provider,
          modelCtx.apiModelProvider
        )(request)
      );

      if (usedApiProvider) {
        outcomeRecorder.setApiProvider(usedApiProvider);
      }

      recordToolSearchMetrics({
        metadata: toolsForLogging.toolSearchMetrics,
        usage,
        modelCtx,
        usedApiProvider,
        sessionId,
        assistantMessageId,
      });

      // Providers can deliver content moderation as a finish reason on an
      // otherwise-successful stream (e.g. Anthropic `refusal`) rather than
      // an error payload; surface it as the same typed error so consumers
      // don't treat the turn as a successful (typically empty) response.
      if (
        !wasAborted &&
        stopReason === LanguageModelFinishReason.ContentFilter
      ) {
        const refusalCategory = stopDetails?.category;
        const refusalExplanation = stopDetails?.explanation;
        // Tag the failure metric/Sentry tag so refusal dashboards group by
        // classifier (anti-distillation vs cyber vs bio).
        outcomeRecorder.setRefusalCategory(refusalCategory);
        logWarn('[LLM] Stream completed with content-filter stop reason', {
          modelId: modelCtx.config?.id ?? modelCtx.model,
          apiProvider: usedApiProvider,
          sessionId,
          refusalCategory,
          refusalExplanation,
        });
        throw new LLMContentModerationError({
          refusalCategory,
          refusalExplanation,
        });
      }

      // Parse accumulated tool inputs after streaming is complete
      toolUses.forEach((toolUse, index) => {
        if (!toolUse) {
          return;
        }

        const rawToolInput = toolInputBuffers[index];
        if (rawToolInput) {
          const isApplyPatchFreeformTool = isApplyPatchToolNameForFallback(
            toolUse.name
          );

          try {
            toolUse.input = parseBufferedToolInput({
              rawToolInput,
              toolName: toolUse.name,
            });

            if (isApplyPatchFreeformTool) {
              logInfo('[LLM] Preserved raw ApplyPatch tool input', {
                toolName: toolUse.name,
                length: rawToolInput.length,
              });
            }
          } catch (e) {
            // If parsing fails, default to empty object.
            // This can happen if the JSON was truncated or malformed.
            logWarn('Failed to parse tool input JSON', {
              toolName: toolUse.name,
              error: e,
            });
            toolUse.input = {};
          }
        }
      });

      // Filter out null entries and entries with invalid IDs.
      // Note: Allow colons and periods for models like Kimi that use IDs like "functions.Read:0".
      // Also sanitize IDs as a fallback in case chunk processing didn't catch malformed IDs.
      const validToolUses = toolUses
        .map((tool, index) => {
          if (!tool || !tool.id || typeof tool.id !== 'string') {
            return null;
          }

          // Sanitize the ID (trim whitespace, replace invalid chars)
          const sanitizedId = deps.platform.sanitizeToolCallId(tool.id);
          if (!sanitizedId || !sanitizedId.match(/^[a-zA-Z0-9_-]+$/)) {
            return null;
          }

          // Use sanitized ID
          const sanitizedTool = { ...tool, id: sanitizedId };

          // Attach signature if available
          const signature = toolCallSignatures?.[index];
          return signature
            ? { ...sanitizedTool, thoughtSignature: signature }
            : sanitizedTool;
        })
        .filter((tool): tool is ToolUse => tool !== null);

      if (toolUses.length !== validToolUses.length) {
        const invalidTools = toolUses.filter((tool) => {
          if (!tool || !tool.id || typeof tool.id !== 'string') {
            return true;
          }
          const sanitizedId = deps.platform.sanitizeToolCallId(tool.id);
          return !sanitizedId || !sanitizedId.match(/^[a-zA-Z0-9_-]+$/);
        });
        logInfo('[LLM] Filtered out invalid tool uses', {
          totalCount: toolUses.length,
          count: validToolUses.length,
          toolIds: invalidTools.flatMap((t) => (t?.id ? [t.id] : [])),
        });
      }

      const result: StreamingResult = {
        content: finalStreamingContent,
        toolUses: validToolUses,
        usage,
        wasAborted,
        openaiMessageId,
        openaiPhase,
        openaiEncryptedContent,
        openaiReasoningId,
        openaiReasoningSummary,
        thinkingContent,
        thinkingSignature,
        chatCompletionReasoningField,
        chatCompletionReasoningContent,
        contentBlocks,
        stopReason,
        stopDetails,
      };

      outcomeRecorder.recordSuccess();
      callbacks.onStreamingComplete(result, wasAborted);
      return result;
    } catch (error) {
      // Abort errors are user-initiated cancellations, not true provider failures.
      // Skip recording a failure metric to avoid misleading "notYetSet" provider
      // entries (the provider may not have been resolved before the abort fired).
      if (!isAbortError(error)) {
        outcomeRecorder.recordFailure(error);
      }
      if (error instanceof Error) {
        callbacks.onStreamingError(error);
        throw error;
      }
      callbacks.onStreamingError(Error('Unknown streaming error'));
      throw new MetaError('Unknown streaming error');
    } finally {
      abortControllerRef.current = null;
      pendingAbort = false;
    }
  };

  const createSystemMessage = async (): Promise<(TextBlock & CacheLabel)[]> => {
    const { provider, config } = resolveModelContext();
    const selectedTools = await resolveToolDescriptors(deps);
    return deps.platform.buildSystemMessageBlocks({
      modelId: config?.id,
      modelProvider: provider,
      tools: selectedTools.map(
        (descriptor) => descriptor.spec as Anthropic.Tool
      ),
      systemPromptOverride: deps.getSystemPromptOverride(),
    });
  };

  const clearPendingAbort = () => {
    pendingAbort = false;
  };

  const resetPromptCacheSnapshot = (sessionId: string) => {
    promptCacheBreakMonitor.resetSession(sessionId);
  };

  return {
    sendMessage,
    abortStreaming,
    clearPendingAbort,
    resetPromptCacheSnapshot,
    prepareMessagesWithCaching,
    createSystemMessage,
    getAllTools: async (sessionId?: string | null) =>
      (await resolveTurnTools(deps, sessionId)).tools,
    isInitialized:
      !!llmClientsRef.current.anthropic ||
      !!llmClientsRef.current.openai ||
      !!llmClientsRef.current.bedrock,
  };
}

// ---------------------------------------------------------------------------
// One-shot text completion helper
// ---------------------------------------------------------------------------

/**
 * Run a one-shot text completion against an existing {@link SendMessageClient}.
 *
 * Synthesizes a single-message conversation, accumulates `onTextDelta`
 * chunks, and resolves with the assistant text when the turn completes.
 * Errors and aborts are surfaced through the same callbacks the streaming
 * hook uses, so retry/rotation/error mapping behavior is identical to the
 * main chat flow.
 */
export async function sendCompletion(
  client: SendMessageClient,
  { systemPrompt, userContent, ...rest }: SendCompletionParams
): Promise<string> {
  // Build a complete `IndustryDroolMessage` for the synthesized one-shot
  // user turn. Skipping the `id`/`createdAt`/`updatedAt` fields would
  // technically work today (downstream code only inspects role + content),
  // but it leaves message-preparation log entries ambiguous and risks
  // breaking the sessionV2 schema's invariants if a future caller starts
  // relying on them.
  const now = Date.now();
  const userMessage: IndustryDroolMessage = {
    id: `${ONESHOT_USER_MESSAGE_ID_PREFIX}${now}`,
    role: MessageRole.User,
    content: [{ type: MessageContentBlockType.Text, text: userContent }],
    createdAt: now,
    updatedAt: now,
  };
  const conversationHistory = client.prepareMessagesWithCaching([userMessage]);
  const systemMessage: TextBlock[] = [
    { type: MessageContentBlockType.Text, text: systemPrompt },
  ];
  let accumulated = '';
  return new Promise<string>((resolve, reject) => {
    void client
      .sendMessage({
        ...rest,
        conversationHistory,
        systemMessage,
        // One-shot completions need assistant text: floor the reasoning
        // effort so thinking cannot starve the output cap (an explicit
        // caller effort wins inside `resolveModelContext`), and treat
        // text-less streams as retryable empty-response errors instead of
        // successful empty turns.
        minimizeReasoning: true,
        expectsText: true,
        assistantMessageId: `${ONESHOT_ASSISTANT_MESSAGE_ID_PREFIX}${now}`,
        callbacks: {
          onRequestStream: () => {},
          onTextDelta: (_blockIndex, chunk) => {
            accumulated += chunk;
          },
          onStreamingComplete: (result) => {
            resolve(result.content || accumulated);
          },
          onStreamingError: (err) => reject(err),
        },
      })
      .catch(reject);
  });
}
