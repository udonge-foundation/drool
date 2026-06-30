import { LogMetadata } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import {
  DEFAULT_STREAMING_ERROR_MESSAGE,
  LLM_THROTTLING_ERROR_MESSAGE,
  LLM_TEXT_FIELDS_TOO_LARGE_ERROR_MESSAGE,
  LLM_PROVIDER_ERROR_MESSAGE,
  OVERLOADED_ERROR_MESSAGE,
  LLM_NETWORK_ERROR_MESSAGE,
  INVALID_REQUEST_MESSAGE,
  LLM_CONTENT_MODERATION_ERROR_MESSAGE,
  LLM_CONTEXT_LIMIT_ERROR_MESSAGE,
} from './constants';
import { ChatFailureReason } from '../../core/enums';

import type { LanguageModelFinishReason } from '../../streaming/enums';
import type { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';

/**
 * Error that occurs we encounter a known type of error in the language model.
 * Known errors are specified in the errors directory.
 */
export class LLMError extends MetaError {
  // TODO: move to drool-core package
  private isRetryable: boolean = false;

  private humanReadableMessage: string;

  private reason: ChatFailureReason;

  private isLevelWarning: boolean;

  constructor({
    reason,
    isRetryable,
    humanReadableMessage,
    internalMessage,
    cause,
    metadata,
    isLevelWarning,
  }: {
    reason: ChatFailureReason;
    isRetryable: boolean;
    humanReadableMessage?: string;
    internalMessage?: string;
    cause?: unknown;
    metadata?: LogMetadata;
    isLevelWarning?: boolean;
  }) {
    if (!reason) {
      throw new MetaError('reason is required');
    }

    const internalMessageWithDefault =
      internalMessage ||
      humanReadableMessage ||
      DEFAULT_STREAMING_ERROR_MESSAGE;
    super(internalMessageWithDefault, { cause, ...(metadata || {}) });
    this.name = this.constructor.name;
    this.reason = reason;
    this.isRetryable = isRetryable;
    this.isLevelWarning = isLevelWarning ?? false;
    this.humanReadableMessage =
      humanReadableMessage ?? DEFAULT_STREAMING_ERROR_MESSAGE;

    this.name = 'LLMError';
    Object.setPrototypeOf(this, LLMError.prototype);
  }

  public getReason(): ChatFailureReason {
    return this.reason;
  }

  public shouldRetry(): boolean {
    return this.isRetryable;
  }

  public isErrorSilenced(): boolean {
    return this.isLevelWarning;
  }

  static getHumanReadableMessage(
    error: unknown,
    defaultMessage: string = DEFAULT_STREAMING_ERROR_MESSAGE
  ): string {
    if (error instanceof LLMError) {
      return error.humanReadableMessage;
    }

    return defaultMessage;
  }

  public getHumanReadableMessage(): string {
    return this.humanReadableMessage;
  }

  public getInternalMessage(): string {
    return this.message;
  }
}
export class LLMUnknownError extends LLMError {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({
      reason: ChatFailureReason.Unknown,
      isRetryable: true,
      cause,
    });
    this.name = 'LLMUnknownError';
    Object.setPrototypeOf(this, LLMUnknownError.prototype);
  }
}
export class LLMThrottlingError extends LLMError {
  /** Server-suggested retry delay in milliseconds, parsed from Google's RetryInfo or error message. */
  retryAfterMs?: number;

  constructor({
    message,
    cause,
    retryAfterMs,
  }: {
    message: string;
    cause?: unknown;
    retryAfterMs?: number;
  }) {
    super({
      reason: ChatFailureReason.Throttling,
      isRetryable: true,
      humanReadableMessage: LLM_THROTTLING_ERROR_MESSAGE,
      internalMessage: message,
      cause,
    });
    this.name = 'LLMThrottlingError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, LLMThrottlingError.prototype);
  }
}
export class LLMTextFieldsTooLargeError extends LLMError {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({
      reason: ChatFailureReason.TextFieldsTooLarge,
      isRetryable: false,
      humanReadableMessage: LLM_TEXT_FIELDS_TOO_LARGE_ERROR_MESSAGE,
      cause,
    });
    this.name = 'LLMTextFieldsTooLargeError';
    Object.setPrototypeOf(this, LLMTextFieldsTooLargeError.prototype);
  }
}
export class LLMStreamError extends LLMError {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({
      reason: ChatFailureReason.StreamError,
      isRetryable: true,
      humanReadableMessage: LLM_PROVIDER_ERROR_MESSAGE,
      cause,
    });
    this.name = 'LLMStreamError';
    Object.setPrototypeOf(this, LLMStreamError.prototype);
  }
}
export class LLMRetryExhaustedError extends LLMError {
  constructor({
    humanReadableMessage,
    internalMessage,
    reason,
    cause,
  }: {
    internalMessage?: string;
    humanReadableMessage?: string;
    reason?: ChatFailureReason;
    cause?: unknown;
  } = {}) {
    super({
      reason: reason ?? ChatFailureReason.RetryExhausted,
      isRetryable: false,
      humanReadableMessage:
        humanReadableMessage ??
        (cause instanceof LLMError
          ? LLMError.getHumanReadableMessage(cause)
          : undefined),
      cause,
      internalMessage:
        internalMessage ?? (cause instanceof Error ? cause.message : undefined),
      isLevelWarning: true,
    });
    this.name = 'LLMRetryExhaustedError';
    Object.setPrototypeOf(this, LLMRetryExhaustedError.prototype);
  }
}
export class LLMOverloadedError extends LLMError {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({
      reason: ChatFailureReason.Overloaded,
      isRetryable: true,
      humanReadableMessage: OVERLOADED_ERROR_MESSAGE,
      cause,
    });
    this.name = 'LLMOverloadedError';
    Object.setPrototypeOf(this, LLMOverloadedError.prototype);
  }
}
export class LLMNetworkError extends LLMError {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({
      reason: ChatFailureReason.NetworkError,
      isRetryable: true,
      humanReadableMessage: LLM_NETWORK_ERROR_MESSAGE,
      cause,
      isLevelWarning: true,
    });
    this.name = 'LLMNetworkError';
    Object.setPrototypeOf(this, LLMNetworkError.prototype);
  }
}
export class LLMInternalError extends LLMError {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({
      reason: ChatFailureReason.LLMInternalError,
      isRetryable: true,
      humanReadableMessage: LLM_PROVIDER_ERROR_MESSAGE,
      cause,
    });
    this.name = 'LLMInternalError';
    Object.setPrototypeOf(this, LLMInternalError.prototype);
  }
}

export class LLMInvalidRequestError extends LLMError {
  constructor({ message, cause }: { message: string; cause?: unknown }) {
    super({
      reason: ChatFailureReason.InvalidRequest,
      isRetryable: false,
      internalMessage: message,
      humanReadableMessage: INVALID_REQUEST_MESSAGE,
      cause,
    });
    this.name = 'LLMInvalidRequestError';
    Object.setPrototypeOf(this, LLMInvalidRequestError.prototype);
  }
}

export class LLMContentModerationError extends LLMError {
  /**
   * Provider-supplied refusal category, when available (e.g. Anthropic's
   * `reasoning_extraction`, `cyber`, `bio`). Used by callers to branch
   * messaging and by logs/metrics to distinguish refusal types.
   */
  public readonly refusalCategory?: string;

  /**
   * Provider-supplied human-readable explanation, when available. Per
   * Anthropic's docs the wording is not stable; treat as opaque diagnostic
   * text and do not parse it programmatically.
   */
  public readonly refusalExplanation?: string;

  constructor({
    cause,
    refusalCategory,
    refusalExplanation,
  }: {
    cause?: unknown;
    refusalCategory?: string;
    refusalExplanation?: string;
  } = {}) {
    super({
      reason: ChatFailureReason.ContentModerationError,
      isRetryable: false,
      humanReadableMessage: LLM_CONTENT_MODERATION_ERROR_MESSAGE,
      cause,
      isLevelWarning: true,
      metadata: {
        ...(refusalCategory ? { refusalCategory } : {}),
        ...(refusalExplanation ? { refusalExplanation } : {}),
      },
    });
    this.refusalCategory = refusalCategory;
    this.refusalExplanation = refusalExplanation;
    this.name = 'LLMContentModerationError';
    Object.setPrototypeOf(this, LLMContentModerationError.prototype);
  }
}
export class LLMContextLengthExceededError extends LLMError {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({
      reason: ChatFailureReason.LLMContextExceeded,
      isRetryable: false,
      humanReadableMessage: LLM_CONTEXT_LIMIT_ERROR_MESSAGE,
      cause,
    });
    this.name = 'LLMContextLengthExceededError';
    Object.setPrototypeOf(this, LLMContextLengthExceededError.prototype);
  }
}

/**
 * A 200 stream that produced no usable assistant output. Retryability is
 * decided by the thrower (`assertNonEmptyLLMResponse`): per-send empty
 * retries are capped. Refusals (`content-filter` stop reason) are not
 * raised as this error; they surface as `LLMContentModerationError` via
 * the post-stream mapping in `sendMessage`.
 */
export class LLMEmptyResponseError extends LLMError {
  constructor({
    retryable,
    stopReason,
    outputTokens,
    thinkingContentLength,
    modelId,
    providerName,
    emptyAttempts,
  }: {
    retryable: boolean;
    stopReason?: LanguageModelFinishReason;
    outputTokens?: number;
    thinkingContentLength?: number;
    modelId: string;
    providerName: ModelProvider;
    emptyAttempts: number;
  }) {
    super({
      reason: ChatFailureReason.EmptyResponse,
      isRetryable: retryable,
      humanReadableMessage: DEFAULT_STREAMING_ERROR_MESSAGE,
      internalMessage: 'LLM response contained no usable output',
      isLevelWarning: true,
      metadata: {
        // LogMetadata schema: `reason` = mapped finish reason of the empty
        // stream, `length` = thinking/reasoning character length.
        reason: stopReason ?? 'none',
        outputTokens: outputTokens ?? 0,
        length: thinkingContentLength ?? 0,
        modelId,
        modelProvider: providerName,
        attempt: emptyAttempts,
      },
    });
    this.name = 'LLMEmptyResponseError';
    this.stopReason = stopReason;
    this.outputTokens = outputTokens;
    this.thinkingContentLength = thinkingContentLength;
    this.emptyAttempts = emptyAttempts;
    this.modelId = modelId;
    Object.setPrototypeOf(this, LLMEmptyResponseError.prototype);
  }

  /** Mapped finish reason of the empty stream, when the provider sent one. */
  public readonly stopReason?: LanguageModelFinishReason;

  /** The model that actually produced the empty stream (post-rotation). */
  public readonly modelId: string;

  /** Output tokens reported for the empty stream. */
  public readonly outputTokens?: number;

  /** Thinking/reasoning content length captured before the empty result. */
  public readonly thinkingContentLength?: number;

  /** How many empty streams this send produced (including this one). */
  public readonly emptyAttempts: number;
}

export class LLMInvalidResponseDataError extends LLMError {
  constructor({
    cause,
    internalMessage,
    metadata,
  }: {
    cause?: unknown;
    internalMessage?: string;
    metadata?: LogMetadata;
  } = {}) {
    super({
      reason: ChatFailureReason.InvalidResponseData,
      isRetryable: true,
      cause,
      internalMessage,
      metadata,
    });
    this.name = 'LLMInvalidResponseDataError';
    Object.setPrototypeOf(this, LLMInvalidResponseDataError.prototype);
  }
}
