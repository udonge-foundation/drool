/**
 * Native AWS Bedrock **Converse** BYOK adapter.
 *
 * Owns the Converse SDK construction and the Converse event-union stream
 * processor. Transport-agnostic Bedrock plumbing lives in `./shared`;
 * provider-agnostic streaming state helpers live in `../chunk-processing`.
 */
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { approxTokensFromChars } from '@industry/utils/llm';

import { LanguageModelFinishReason } from '../../../streaming/enums';
import {
  completeContentBlock,
  emitToolInputDeltaIfChanged,
  startThinkingDuration,
} from '../chunk-processing';
import { StreamingContentBlockType } from '../enums';
import { parseOptimisticJson } from '../optimistic-json-parser';
import {
  createBedrockSdkFetch,
  headersToRecord,
  mapBedrockStreamError,
  resolveBedrockClientConfig,
} from './shared';

import type { BedrockClientConfig } from './types';
import type {
  ChunkProcessingOptions,
  FetchLike,
  StreamingCallbacks,
  StreamingContentBlock,
  StreamingState,
} from '../types';
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import type { CustomModelBedrockConfig } from '@industry/common/settings';

interface ResolveConverseClientConfigParams {
  bedrock: CustomModelBedrockConfig;
  modelId: string;
  environment: Record<string, string | undefined>;
  signal: AbortSignal;
  fetchImpl: FetchLike;
}

/**
 * Resolves everything needed to build a `BedrockRuntimeClient` without
 * allocating one, so callers can cache the SDK instance per-turn keyed on
 * {@link BedrockClientConfig.cacheFingerprint}. Delegates entirely to the
 * shared resolver — Converse and Anthropic-on-Bedrock share the same
 * credential/region pipeline; only the wire dialect differs.
 */
export function resolveConverseClientConfig(
  params: ResolveConverseClientConfigParams
): Promise<BedrockClientConfig> {
  return resolveBedrockClientConfig(params);
}

type SmithyHttpRequest = {
  protocol: string;
  hostname: string;
  port?: number;
  path: string;
  method: string;
  query?: Record<string, string | readonly string[] | null | undefined>;
  headers?: Record<string, string>;
  body?: BodyInit | null;
};

type SmithyHttpHandlerOptions = {
  abortSignal?: AbortSignal;
  requestTimeout?: number;
};

function buildFetchUrl(request: SmithyHttpRequest): string {
  const port = request.port ? `:${request.port}` : '';
  const url = new URL(
    `${request.protocol}//${request.hostname}${port}${request.path}`
  );
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value == null) continue;
    if (typeof value === 'string') {
      url.searchParams.append(key, value);
    } else {
      for (const item of value) url.searchParams.append(key, item);
    }
  }
  return url.toString();
}

function withConverseUserAgentHeader(
  headers: Record<string, string> | undefined,
  userAgent: string | undefined
): Record<string, string> | undefined {
  if (!userAgent) return headers;
  const next = { ...(headers ?? {}) };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'user-agent') {
      delete next[key];
    }
  }
  next['user-agent'] = userAgent;
  return next;
}

function createConverseFetchRequestHandler(
  fetchImpl: FetchLike,
  timeoutMs: number,
  userAgent?: string
) {
  const fetchForSdk = createBedrockSdkFetch(fetchImpl);
  return {
    destroy() {},
    async handle(
      request: SmithyHttpRequest,
      options: SmithyHttpHandlerOptions = {}
    ) {
      const abortController = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        abortController.abort(options.abortSignal?.reason);
      };

      if (options.abortSignal?.aborted) onAbort();
      else
        options.abortSignal?.addEventListener('abort', onAbort, {
          once: true,
        });

      const requestTimeout = options.requestTimeout ?? timeoutMs;
      if (requestTimeout > 0) {
        timeout = setTimeout(() => {
          abortController.abort(
            new DOMException('Request timed out', 'TimeoutError')
          );
        }, requestTimeout);
      }

      try {
        const init: RequestInit & { duplex?: 'half' } = {
          method: request.method,
          headers: withConverseUserAgentHeader(request.headers, userAgent),
          body: request.body ?? undefined,
          signal: abortController.signal,
        };
        if (request.body != null) init.duplex = 'half';

        const response = await fetchForSdk(buildFetchUrl(request), init);
        return {
          response: {
            statusCode: response.status,
            reason: response.statusText,
            headers: headersToRecord(response.headers),
            body: response.body ?? new Uint8Array(),
          },
        };
      } finally {
        if (timeout) clearTimeout(timeout);
        options.abortSignal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/**
 * Pure constructor: given a resolved {@link BedrockClientConfig},
 * allocates a configured `BedrockRuntimeClient`. No I/O.
 */
export function constructConverseClient(
  config: BedrockClientConfig,
  timeoutMs: number,
  fetchImpl?: FetchLike,
  userAgent?: string
): BedrockRuntimeClient {
  const base = {
    region: config.region,
    endpoint: config.baseURL,
    requestHandler: fetchImpl
      ? createConverseFetchRequestHandler(fetchImpl, timeoutMs, userAgent)
      : { requestTimeout: timeoutMs },
  } as NonNullable<ConstructorParameters<typeof BedrockRuntimeClient>[0]>;

  if (config.bearerToken) {
    return new BedrockRuntimeClient({
      ...base,
      token: { token: config.bearerToken },
    });
  }

  if (config.credentials) {
    return new BedrockRuntimeClient({
      ...base,
      credentials: {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
        sessionToken: config.credentials.sessionToken,
      },
    });
  }

  return new BedrockRuntimeClient(base);
}

// ---------------------------------------------------------------------------
// Stop-reason mapping
// ---------------------------------------------------------------------------

/**
 * Maps a Bedrock Converse `stopReason` to our universal
 * {@link LanguageModelFinishReason}.
 */
function mapConverseStopReason(
  stopReason: string | null | undefined
): LanguageModelFinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return LanguageModelFinishReason.Stop;
    case 'tool_use':
      return LanguageModelFinishReason.ToolCalls;
    case 'max_tokens':
      return LanguageModelFinishReason.Length;
    case 'guardrail_intervened':
    case 'content_filtered':
      return LanguageModelFinishReason.ContentFilter;
    default:
      return LanguageModelFinishReason.Unknown;
  }
}

// ---------------------------------------------------------------------------
// Reader-error mapping
// ---------------------------------------------------------------------------

/**
 * Maps a Converse stream exception (either an event-stream error member or
 * a thrown SDK error) into one of our typed `LLMError` subclasses so the
 * retry policy treats Bedrock failures consistently.
 */
export function mapConverseReaderError(error: unknown): Error {
  return mapBedrockStreamError(error);
}

function ensureTextBlock(
  state: StreamingState,
  index: number
): StreamingContentBlock {
  let block = state.contentBlocks[index];
  if (!block) {
    block = {
      type: StreamingContentBlockType.Text,
      index,
      content: '',
      isComplete: false,
    };
    state.contentBlocks[index] = block;
  }
  return block;
}

function ensureThinkingBlock(
  state: StreamingState,
  index: number,
  callbacks: StreamingCallbacks
): StreamingContentBlock {
  let block = state.contentBlocks[index];
  if (!block) {
    block = {
      type: StreamingContentBlockType.Thinking,
      index,
      content: '',
      signature: '',
      signatureProvider: state.modelProvider ?? ModelProvider.BEDROCK_CONVERSE,
      isComplete: false,
    };
    state.contentBlocks[index] = block;
    callbacks.onThinkingBlockStart?.(index);
    callbacks.onThinking?.();
  }
  return block;
}

// ---------------------------------------------------------------------------
// Converse event union accessors (property-presence based; robust to the
// smithy union shape without importing every member type)
// ---------------------------------------------------------------------------

type ConverseEvent = ConverseStreamOutput & Record<string, unknown>;

const ERROR_MEMBERS = [
  'internalServerException',
  'modelStreamErrorException',
  'validationException',
  'throttlingException',
  'serviceUnavailableException',
] as const;

/**
 * Processes a single Converse stream event and mutates {@link StreamingState}.
 *
 * Throws a mapped `LLMError` when the event is one of the Converse
 * event-stream error members so the caller's retry policy engages.
 */
export function processConverseChunk(
  event: ConverseStreamOutput,
  state: StreamingState,
  callbacks: StreamingCallbacks,
  options: ChunkProcessingOptions = {}
): void {
  const e = event as ConverseEvent;

  // Event-stream error members surface as a populated key on the union.
  for (const member of ERROR_MEMBERS) {
    const payload = e[member];
    if (payload) {
      const message =
        payload instanceof Error
          ? payload.message
          : typeof (payload as { message?: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : member;
      const err = new Error(
        message === member ? member : `${member}: ${message}`
      );
      throw mapConverseReaderError(err);
    }
  }

  if (e.messageStart) {
    // `onMessageStart` is fired once by the caller before streaming
    // begins (mirrors processAnthropicChunk, which does NOT re-fire it on
    // the wire `message_start`). Nothing to do here.
    return;
  }

  if (e.contentBlockStart) {
    const cbs = e.contentBlockStart as {
      contentBlockIndex?: number;
      start?: { toolUse?: { toolUseId?: string; name?: string } };
    };
    const index = cbs.contentBlockIndex ?? state.contentBlocks.length;
    const toolUse = cbs.start?.toolUse;
    if (toolUse?.toolUseId && toolUse.name) {
      while (state.toolUses.length <= index) state.toolUses.push(null);
      state.toolUses[index] = {
        id: toolUse.toolUseId,
        name: toolUse.name,
        input: {},
      };
      state.contentBlocks[index] = {
        type: StreamingContentBlockType.ToolUse,
        index,
        content: '',
        toolUseId: toolUse.toolUseId,
        toolName: toolUse.name,
        isComplete: false,
      };
      if (!state.toolInputBuffers[index]) state.toolInputBuffers[index] = '';
      callbacks.onToolUseDetected?.({
        id: toolUse.toolUseId,
        name: toolUse.name,
        input: {},
      });
    }
    return;
  }

  if (e.contentBlockDelta) {
    const cbd = e.contentBlockDelta as {
      contentBlockIndex?: number;
      delta?: {
        text?: string;
        toolUse?: { input?: string };
        reasoningContent?: {
          text?: string;
          signature?: string;
          redactedContent?: Uint8Array;
        };
      };
    };
    const index = cbd.contentBlockIndex ?? 0;
    const delta = cbd.delta;
    if (!delta) return;

    if (typeof delta.text === 'string' && delta.text.length > 0) {
      state.streamingContent += delta.text;
      const block = ensureTextBlock(state, index);
      if (block.type === StreamingContentBlockType.Text) {
        block.content += delta.text;
      }
      callbacks.onTextDelta?.(index, delta.text);
      return;
    }

    if (delta.toolUse && typeof delta.toolUse.input === 'string') {
      if (!state.toolInputBuffers[index]) state.toolInputBuffers[index] = '';
      state.toolInputBuffers[index] += delta.toolUse.input;
      const toolUse = state.toolUses[index];
      if (callbacks.onToolInputDelta && toolUse?.id) {
        const parsed = parseOptimisticJson(state.toolInputBuffers[index]);
        if (Object.keys(parsed.data).length > 0) {
          emitToolInputDeltaIfChanged({
            state,
            index,
            toolId: toolUse.id,
            data: parsed.data,
            callbacks,
          });
        }
      }
      return;
    }

    if (delta.reasoningContent) {
      const rc = delta.reasoningContent;
      if (typeof rc.text === 'string' && rc.text.length > 0) {
        const block = ensureThinkingBlock(state, index, callbacks);
        if (block.type === StreamingContentBlockType.Thinking) {
          startThinkingDuration(block);
          block.content += rc.text;
          callbacks.onThinkingDelta?.(index, rc.text);
        }
        state.thinkingContent = (state.thinkingContent ?? '') + rc.text;
        state.usage.thinkingTokens =
          (state.usage.thinkingTokens || 0) +
          approxTokensFromChars(rc.text.length);
        callbacks.onThinking?.();
      } else if (typeof rc.signature === 'string' && rc.signature.length > 0) {
        const block = ensureThinkingBlock(state, index, callbacks);
        if (block.type === StreamingContentBlockType.Thinking) {
          block.signature = (block.signature || '') + rc.signature;
          block.signatureProvider =
            state.modelProvider ?? ModelProvider.BEDROCK_CONVERSE;
        }
        state.thinkingSignature =
          (state.thinkingSignature ?? '') + rc.signature;
      } else if (rc.redactedContent) {
        const data = Buffer.from(rc.redactedContent).toString('base64');
        state.contentBlocks[index] = {
          type: StreamingContentBlockType.RedactedThinking,
          index,
          content: '',
          data,
          isComplete: false,
        };
        callbacks.onRedactedThinkingBlock?.(index, data);
      }
      return;
    }
    return;
  }

  if (e.contentBlockStop) {
    const cbs = e.contentBlockStop as { contentBlockIndex?: number };
    const block =
      cbs.contentBlockIndex !== undefined
        ? state.contentBlocks[cbs.contentBlockIndex]
        : undefined;
    if (block) completeContentBlock(block, callbacks);
    return;
  }

  if (e.messageStop) {
    const ms = e.messageStop as { stopReason?: string };
    state.stopReason = mapConverseStopReason(ms.stopReason);
    state.finalStreamingContent = state.streamingContent;
    callbacks.onMessageComplete?.();
    return;
  }

  if (e.metadata) {
    const meta = e.metadata as {
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      };
    };
    const usage = meta.usage;
    if (usage) {
      if (typeof usage.inputTokens === 'number') {
        state.usage.inputTokens = usage.inputTokens;
      }
      if (typeof usage.outputTokens === 'number') {
        state.usage.outputTokens = usage.outputTokens;
      }
      if (typeof usage.cacheReadInputTokens === 'number') {
        state.usage.cacheReadInputTokens = usage.cacheReadInputTokens;
      }
      if (typeof usage.cacheWriteInputTokens === 'number') {
        state.usage.cacheCreationInputTokens = usage.cacheWriteInputTokens;
      }
      options.onTokenUsage?.(
        {
          inputTokens: state.usage.inputTokens,
          outputTokens: state.usage.outputTokens,
          cacheCreationTokens: state.usage.cacheCreationInputTokens,
          cacheReadTokens: state.usage.cacheReadInputTokens,
          ...(state.usage.thinkingTokens !== undefined && {
            thinkingTokens: state.usage.thinkingTokens,
          }),
        },
        false
      );
    }
  }
}
