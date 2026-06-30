import { ModelID, ApiProvider } from '@industry/drool-sdk-ext/protocol/llm';
import {
  Metrics,
  getSentryAdapter,
  isSentryEnabled,
  logInfo,
  logWarn,
} from '@industry/logging';
import { MetaError, ResponseError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';

import {
  ChatOutcomeRecorderOptions,
  RecordOutcomeParams,
  RequestMetadata,
} from './types';
import { ChatFailureReason } from '../../core/enums';
import {
  LLMError,
  extractHttpStatus,
  isContentModerationError,
  isContextLimitError,
  isOverloadedError,
  isPaymentRequiredError,
  isProviderCapacityError,
  isThrottlingError,
} from '../../llms/errors';

/**
 * Records the outcome (success/failure) of a chat or LLM proxy interaction.
 *
 * USAGE PATTERN:
 * 1. Create recorder at start of handler
 * 2. Only call recordSuccess() when operation succeeds
 * 3. Call finalize() in finally block - auto-records failure if no success
 *
 * This ensures all code paths record an outcome without boilerplate.
 */
export class ChatOutcomeRecorder {
  private recorded = false;

  private modelId: string | undefined;

  private apiProvider: string | undefined;

  private metadata: RequestMetadata = {};

  private successMetric: Metric;

  private failureMetric: Metric;

  private countMetric?: Metric;

  private sentryTagName: string;

  private lastError?: unknown;

  private lastReason?: string;

  private refusalCategory?: string;

  constructor(options?: ChatOutcomeRecorderOptions) {
    this.successMetric = options?.successMetric ?? Metric.CHAT_SUCCESS_COUNT;
    this.failureMetric = options?.failureMetric ?? Metric.CHAT_FAILURE_COUNT;
    this.countMetric = options?.countMetric;
    this.sentryTagName = options?.sentryTagName ?? 'chatSuccess';
    this.metadata = options?.metadata ?? {};
  }

  public setModelId(model: ModelID | string) {
    this.modelId = model;
  }

  public setApiProvider(apiProvider: ApiProvider | string) {
    this.apiProvider = apiProvider;
  }

  public setRequestMetadata(metadata: RequestMetadata) {
    this.metadata = metadata;
  }

  /**
   * Attach the provider-generated request id from the upstream response.
   * Merges into existing metadata (unlike `setRequestMetadata`) because it
   * becomes available only after the upstream fetch, while the rest of the
   * request metadata is set during validation. The id is spread into every
   * failure log (`[Chat route failure]`, interrupted-stream warnings) so any
   * error path can be correlated with the provider's own request logs.
   */
  public setUpstreamRequestId(upstreamRequestId: string | undefined) {
    if (!upstreamRequestId) return;
    this.metadata = { ...this.metadata, upstreamRequestId };
  }

  /**
   * Attach the provider refusal category (e.g. Anthropic `stop_details.category`)
   * so the eventual failure metric and Sentry tag distinguish refusal classifiers.
   */
  public setRefusalCategory(category: string | undefined) {
    if (category) {
      this.refusalCategory = category;
    }
  }

  /**
   * Automatically derives a ChatFailureReason from an error object.
   * Uses a priority-based classification system that reuses the shared
   * classifiers in `llms/errors/utils.ts` so SDK errors (Anthropic /
   * OpenAI APIError with `.status`) are classified on equal footing with
   * `ResponseError`/`FetchError`.
   */
  private static deriveReasonFromError(error: unknown): ChatFailureReason {
    // 1. LLMError subclasses are self-classifying.
    if (error instanceof LLMError) {
      return error.getReason();
    }

    // 2. Semantic classifiers (order matters: most specific first).
    if (isContentModerationError(error)) {
      return ChatFailureReason.ContentModerationError;
    }
    if (isContextLimitError(error)) {
      return ChatFailureReason.LLMContextExceeded;
    }
    if (isPaymentRequiredError(error)) {
      // Industry pre-request billing rejections (`canUseChatModel` -> 402) and
      // upstream-provider 402s share the same wire shape. Surfacing them under
      // their own reason keeps the LLM Traffic dashboard's `invalidRequest`
      // bucket actionable: Industry billing enforcement is working-as-designed
      // and was previously ~67% of the 4xx-class noise.
      return ChatFailureReason.PaymentRequired;
    }
    if (isThrottlingError(error)) {
      return ChatFailureReason.Throttling;
    }
    if (isProviderCapacityError(error)) {
      return ChatFailureReason.Overloaded;
    }
    if (isOverloadedError(error)) {
      return ChatFailureReason.Overloaded;
    }

    // 3. Network / connection errors. Case-insensitive because Bun emits
    //    "Fetch failed" (capital F) while Node emits "fetch failed".
    if (error instanceof Error) {
      const message = (error.message || '').toLowerCase();
      if (
        message.includes('fetch failed') ||
        message.includes('connection terminated') ||
        message.includes('terminated') ||
        message.includes('connection error') ||
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('etimedout') ||
        message.includes('enotfound') ||
        message.includes('socket hang up') ||
        message.includes('network request failed')
      ) {
        return ChatFailureReason.NetworkError;
      }
    }

    // 4. Generic HTTP status fallback. Covers SDK APIError (`.status`),
    //    ResponseError (`.statusCode`) and FetchError (`.response.status`).
    const status = extractHttpStatus(error);
    if (status !== undefined) {
      if (status >= 400 && status < 500) {
        return ChatFailureReason.InvalidRequest;
      }
      if (status >= 500) {
        return ChatFailureReason.LLMInternalError;
      }
    }

    // 5. Fallback.
    return ChatFailureReason.Unknown;
  }

  /**
   * Track an error without recording metrics yet.
   * The first tracked error will be used if finalize() records a failure.
   */
  public trackError(reason: string, error?: unknown) {
    if (!this.lastReason) {
      this.lastReason = reason;
      this.lastError = error;
    }
  }

  /**
   * Record a successful outcome. Can only be called once.
   */
  public recordSuccess() {
    this.recordOutcome({ success: true });
  }

  /**
   * Record an explicit failure. Can only be called once.
   * Automatically derives the failure reason from the error if not provided.
   *
   * @param error - The error object (optional)
   * @param reason - Override reason (optional, auto-derived if not provided)
   */
  public recordFailure(error?: unknown, reason?: ChatFailureReason) {
    const finalReason =
      reason ?? ChatOutcomeRecorder.deriveReasonFromError(error);
    this.recordOutcome({ success: false, reason: finalReason, error });
  }

  /**
   * Record the outcome of a stream that ended without delivering a usage
   * payload AND without emitting a terminal marker.
   *
   * - If the client aborted the request, the stream is treated as a
   *   success: this is an intentional cancellation, not a proxy failure.
   *   A `logInfo` is emitted to note that no usage was tracked.
   * - Otherwise, the upstream terminated the stream mid-generation. This
   *   is recorded as a `StreamError` failure with a `logWarn` so we
   *   retain observability on mid-stream kills without conflating them
   *   with token-extraction bugs.
   *
   * Centralizing this branch on the recorder keeps the four LLM proxy
   * routes from re-implementing the same abort-vs-upstream-kill logic.
   */
  public recordInterruptedStream(
    signal: { aborted: boolean },
    logContext?: Record<string, unknown>
  ) {
    if (this.recorded) return;

    const baseContext = {
      modelId: this.modelId,
      apiProvider: this.apiProvider,
      ...this.metadata,
      ...logContext,
    };

    if (signal.aborted) {
      logInfo(
        '[LLM proxy] Stream aborted by client; not tracking usage',
        baseContext
      );
      this.recordSuccess();
    } else {
      logWarn(
        '[LLM proxy] Upstream terminated stream mid-generation without a terminal marker',
        baseContext
      );
      this.recordFailure(undefined, ChatFailureReason.StreamError);
    }
  }

  /**
   * Finalize the recording. If no outcome was recorded yet, records a failure
   * using the last tracked error or a default reason.
   *
   * Call this in a finally block to ensure outcomes are always recorded.
   */
  public finalize() {
    if (!this.recorded) {
      this.recordOutcome({
        success: false,
        reason: this.lastReason ?? 'unhandled_error',
        error: this.lastError,
      });
    }
  }

  public recordOutcome = ({ success, reason, error }: RecordOutcomeParams) => {
    if (this.recorded) return;

    // Auto-derive reason for failures if not provided
    const finalReason = success
      ? reason
      : (reason ?? ChatOutcomeRecorder.deriveReasonFromError(error));

    const metric = success ? this.successMetric : this.failureMetric;
    const labels = {
      modelId: this.modelId ?? 'notYetSet',
      modelProvider: this.apiProvider ?? 'notYetSet',
      reason: finalReason,
      orgId: this.metadata.orgId,
      sessionId: this.metadata.sessionId,
      baseUrl: this.metadata.baseUrl,
      assistantMessageId: this.metadata.assistantMessageId,
      ...(this.refusalCategory
        ? { refusalCategory: this.refusalCategory }
        : {}),
    };
    Metrics.addToCounter(metric, 1, labels);

    // Also record optional count metric with isError label
    if (this.countMetric) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : error
            ? String(error)
            : undefined;
      Metrics.addToCounter(this.countMetric, 1, {
        ...labels,
        isError: !success,
        ...(errorMessage ? { errorMessage } : {}),
      });
    }

    if (isSentryEnabled()) {
      const adapter = getSentryAdapter();
      adapter?.setTag(this.sentryTagName, success);
      if (this.refusalCategory) {
        adapter?.setTag('refusalCategory', this.refusalCategory);
      }
    }

    if (!success) {
      // Surface metadata attached to MetaError/ResponseError instances so
      // diagnostic context (e.g. truncated upstream body, statusCode) makes
      // it into the failure log. JSON serialization strips own properties
      // from Error objects -- without this hoist, fields set on
      // `error.metadata` would never reach Axiom. Mirrors the extraction
      // pattern used by `logException` in `@industry/logging`.
      const errorMetadata =
        error instanceof MetaError || error instanceof ResponseError
          ? error.metadata
          : undefined;
      logWarn('[Chat route failure]', {
        ...errorMetadata,
        ...this.metadata,
        reason: finalReason,
        error,
        modelId: this.modelId ?? 'notYetSet',
        apiProvider: this.apiProvider ?? 'notYetSet',
        ...(this.refusalCategory
          ? { refusalCategory: this.refusalCategory }
          : {}),
      });
    }

    this.recorded = true;
  };
}

/**
 * Creates a ChatOutcomeRecorder configured for LLM proxy routes.
 */
export function createOutcomeRecorderForProxy(): ChatOutcomeRecorder {
  return new ChatOutcomeRecorder({
    successMetric: Metric.LLM_PROXY_SUCCESS_COUNT,
    failureMetric: Metric.LLM_PROXY_FAILURE_COUNT,
    countMetric: Metric.LLM_PROXY_COUNT,
  });
}
