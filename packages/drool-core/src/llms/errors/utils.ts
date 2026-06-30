/**
 * Utility functions for detecting and handling LLM errors
 */

import { AuthenticationError } from '@industry/logging/errors';
import { isAbortError } from '@industry/utils/function';

import { LLMEmptyResponseError } from './errors';

import type {
  EmptyResponseTelemetry,
  IndustryDisplayable402Body,
} from './types';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function extractErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message || undefined;
  const obj = asRecord(error);
  if (typeof obj?.message === 'string') return obj.message;

  const nested = asRecord(obj?.error);
  if (typeof nested?.message === 'string') return nested.message;

  const response = asRecord(obj?.response);
  const responseError = asRecord(response?.error);
  if (typeof responseError?.message === 'string') return responseError.message;

  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }

  const obj = asRecord(error);
  if (typeof obj?.code === 'string') return obj.code;

  const nested = asRecord(obj?.error);
  if (typeof nested?.code === 'string') return nested.code;

  const response = asRecord(obj?.response);
  const responseError = asRecord(response?.error);
  if (typeof responseError?.code === 'string') return responseError.code;

  return undefined;
}

function extractErrorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  const obj = asRecord(error);
  return typeof obj?.name === 'string' ? obj.name : undefined;
}

function extractErrorCause(error: unknown): unknown {
  if (error instanceof Error) {
    return (error as Error & { cause?: unknown }).cause;
  }
  const obj = asRecord(error);
  return obj?.cause;
}

/**
 * Extracts an HTTP status code from an error, covering:
 * - SDK errors (Anthropic/OpenAI APIError) on `.status`
 * - `@industry/logging`'s `ResponseError` on `.statusCode`
 * - `@industry/logging`'s `FetchError` on `.response.status`
 * - Node/http-client-style errors on `.response.statusCode`
 * - SDK-formatted messages with a leading "<status> " prefix
 *   (e.g. "401 status code (no body)", `400 {"detail":"…"}`) when no
 *   status property is present
 * - Any of the above wrapped in `error.cause`
 *
 * Returns `undefined` if no recognizable HTTP status is found.
 */
export function extractHttpStatus(error: unknown): number | undefined {
  const obj = asRecord(error);
  if (obj) {
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    const response = asRecord(obj.response);
    if (typeof response?.status === 'number') return response.status;
    if (typeof response?.statusCode === 'number') return response.statusCode;
  }

  // SDKs prefix the message with the status when the response body is
  // missing/unparseable, e.g. "400 status code (no body)", "404 Not Found",
  // or `400 {"detail":"…","status":400,...}` from the Industry proxy.
  const message = extractErrorMessage(error);
  if (message) {
    const match = message.match(/^([1-5]\d{2})\s/);
    if (match) return parseInt(match[1], 10);
  }

  const cause = extractErrorCause(error);
  if (cause) return extractHttpStatus(cause);

  return undefined;
}

// Response headers that carry the provider-side request id, in lookup
// order. The id is required when escalating misbehaving requests to the
// provider (e.g. Anthropic asks for `request-id` values in bug reports).
const UPSTREAM_REQUEST_ID_HEADERS = [
  'request-id', // Anthropic
  'x-request-id', // OpenAI, Fireworks, Baseten
  'x-amzn-requestid', // AWS Bedrock
  'apim-request-id', // Azure OpenAI
  'x-goog-request-id', // Google Vertex (when present)
];

/**
 * Extracts the provider-generated request id from upstream LLM response
 * headers. Checks known per-provider header names and returns the first
 * match, or `undefined` when the provider did not send one.
 *
 * The id is provider-generated (never user content), so it is safe to log
 * under the CMEK telemetry policy.
 */
export function extractUpstreamRequestId(headers: Headers): string | undefined {
  for (const name of UPSTREAM_REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

/**
 * Shared helper for detecting deterministic HTTP-status-based errors
 * (401, 402, 403, etc.) that should NOT be retried. Delegates to
 * `extractHttpStatus`, which already handles status fields, message
 * prefixes, and `error.cause` recursion.
 */
function isHttpStatusError(error: unknown, status: number): boolean {
  return extractHttpStatus(error) === status;
}

/**
 * Helper function to check if a message indicates an overloaded error
 */
function isOverloadedMessage(message: string): boolean {
  return /overloaded/i.test(message);
}

/**
 * Helper function to check if a message indicates a context limit error
 */
function isContextLimitMessage(message: string): boolean {
  // Check for common context limit error phrases (existing + OpenAI-specific)
  return (
    /context length/i.test(message) ||
    /context limit/i.test(message) ||
    /exceed\s.*context\s.*limit/i.test(message) ||
    /prompt is too long/i.test(message) ||
    /maximum context/i.test(message) ||
    /input is too long/i.test(message) ||
    /over the maximum length/i.test(message) ||
    /is too many tokens/i.test(message) ||
    // OpenAI-specific patterns
    /context_length_exceeded/i.test(message) ||
    /exceeds?\s+(the\s+)?.*context\s+window/i.test(message) ||
    // Anthropic: "Request size exceeds model context window"
    /request size exceed(s|ed)/i.test(message) ||
    /input exceeds? the.*context/i.test(message) ||
    // MiniMax
    /context window exceeds limit/i.test(message) ||
    // GLM/MiniMax: "Error from inference backend: Request too large for context window"
    /request too large for (the )?context window/i.test(message) ||
    // HTTP 413 from proxy or provider: '413 {"error":{"code":"413","message":"Request Entity Too Large"}}'
    /Request Entity Too Large/i.test(message) ||
    /context\s+window\s+is\s+full/i.test(message) ||
    /prompt\s+too\s+long/i.test(message) ||
    /context\s*window\s*exceeded/i.test(message)
  );
}

/**
 * Helper function to check if a message indicates a moderation/policy block
 */
function isContentModerationMessage(message: string): boolean {
  return (
    /content moderation/i.test(message) ||
    /content_filter/i.test(message) ||
    /cyber[_\s-]?policy/i.test(message) ||
    /violating our usage policy/i.test(message)
  );
}

/**
 * Checks if an error is related to context length limits being exceeded
 * Handles both Anthropic and OpenAI (including Responses API) error formats
 *
 * @param error - Any error object or value
 * @returns True if the error appears to be a context limit error
 */
export function isContextLimitError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (code === 'context_length_exceeded' || code === '413') return true;

  // Check for HTTP 413 status on the error object (SDK errors, proxy responses)
  if (extractHttpStatus(error) === 413) return true;

  if (error instanceof Error) {
    if (extractErrorName(error) === 'LLMContextLengthExceededError')
      return true;

    const message = extractErrorMessage(error);
    if (message && isContextLimitMessage(message)) return true;

    const cause = extractErrorCause(error);
    if (cause && isContextLimitError(cause)) return true;

    return false;
  }

  const obj = asRecord(error);
  if (obj) {
    const message = extractErrorMessage(error);
    if (message && isContextLimitMessage(message)) return true;
  }

  return false;
}

/**
 * Checks if an error is related to the upstream AI model provider being overloaded
 *
 * @param error - Any error object or value
 * @returns True if the error appears to be an overloaded error
 */
export function isOverloadedError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  if (!message) return false;
  return isOverloadedMessage(message);
}

/**
 * Checks if an error indicates provider capacity exhaustion (overloaded/unavailable).
 * Handles both LLM error classes and raw SDK errors (e.g. Anthropic APIError)
 * which carry a numeric `status` property.
 *
 * These errors warrant immediate provider rotation with minimal delay, since
 * retrying the same provider is unlikely to help.
 *
 * Covers:
 * - HTTP 529 (Anthropic "Overloaded")
 * - HTTP 503 (Bedrock "Too many connections", "Bedrock is unable to process")
 * - HTTP 502 (Bad Gateway — upstream load balancer / gateway failure)
 * - HTTP 500 with transient/capacity-related messages
 * - LLMOverloadedError (Anthropic `overloaded_error` delivered mid-stream on a
 *   200 OK response, so it carries no HTTP status)
 * - LLMInternalError (provider 500 / Bedrock `server_error` delivered mid-stream
 *   as a `response.failed` event, so it carries no HTTP status — see CL-668)
 */
export function isProviderCapacityError(error: unknown): boolean {
  const name = extractErrorName(error);
  if (name === 'LLMOverloadedError') return true;
  if (name === 'LLMInternalError') return true;

  const status = extractHttpStatus(error);

  // HTTP 529, 503, and 502 are always provider capacity errors
  if (status === 529 || status === 503 || status === 502) return true;

  // HTTP 500 can be transient provider issues. Check the message to avoid
  // misclassifying deterministic server bugs as capacity errors.
  if (status === 500) {
    const message = extractErrorMessage(error) ?? '';
    return (
      /internal server error/i.test(message) ||
      /overloaded/i.test(message) ||
      /service unavailable/i.test(message) ||
      // Anthropic SDK produces "500 {"error":...}" -- treat as transient
      /^500\s/.test(message)
    );
  }

  return false;
}

/**
 * Checks if an error is a rate-limit / throttling error.
 * Handles both LLMThrottlingError (from Gemini/mapped paths) and raw
 * SDK errors (e.g. Anthropic RateLimitError with status 429).
 */
export function isThrottlingError(error: unknown): boolean {
  if (extractHttpStatus(error) === 429) return true;
  if (extractErrorName(error) === 'LLMThrottlingError') return true;
  return false;
}

/**
 * Checks if an error is a NaN/overflow error from model inference.
 * Fireworks returns this when the model weights produce NaN during generation.
 * Not retryable: the same input will consistently trigger the overflow.
 *
 * @param error - Any error object or value
 * @returns True if the error is a NaN/overflow inference error
 */
/** @internal exported for unit tests */
export function isNaNOverflowError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  if (
    message &&
    (/NaN.*not-a-number.*generation/i.test(message) ||
      /floating point NaN/i.test(message))
  ) {
    return true;
  }

  const cause = extractErrorCause(error);
  if (cause && isNaNOverflowError(cause)) return true;

  return false;
}

/**
 * Checks if an error is related to content moderation or provider policy checks
 *
 * @param error - Any error object or value
 * @returns True if the error appears to be a moderation/policy block
 */
export function isContentModerationError(error: unknown): boolean {
  if (extractErrorName(error) === 'LLMContentModerationError') return true;

  const code = extractErrorCode(error);
  if (code && /^(content_filter|cyber_policy)$/i.test(code)) return true;

  const message = extractErrorMessage(error);
  if (message && isContentModerationMessage(message)) return true;

  const cause = extractErrorCause(error);
  if (cause && isContentModerationError(cause)) return true;

  return false;
}

/**
 * Checks whether a provider rejected an LLM tool's JSON Schema.
 *
 * These errors are particularly common for MCP tools sent to custom
 * OpenAI-compatible endpoints that support only a JSON Schema subset.
 */
export function isToolSchemaCompatibilityError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  if (
    message &&
    (/json schema (?:is )?not supported/i.test(message) ||
      /tools?\[\d+\]\.(?:function\.)?parameters.*(?:schema|invalid|not supported|unsupported)/i.test(
        message
      ) ||
      /(?:function|tool).*(?:parameters|schema).*(?:invalid|not supported|unsupported)/i.test(
        message
      ))
  ) {
    return true;
  }

  const cause = extractErrorCause(error);
  if (cause && isToolSchemaCompatibilityError(cause)) return true;

  return false;
}

/**
 * Checks if an error is an HTTP 402 Payment Required response.
 * This covers both upstream provider billing errors (e.g. Fireworks returning
 * 402 with no body) and provider-specific billing messages (insufficient credits,
 * quota exceeded, etc.).
 */
export function isPaymentRequiredError(error: unknown): boolean {
  return isHttpStatusError(error, 402);
}

/**
 * Extracts the parsed Industry error body from a 402 response when the
 * backend has tagged it as user-displayable (`displayToUser: true`).
 *
 * SDK errors (e.g. Anthropic APIError) keep their HTTP status line as
 * `.message` and attach the parsed JSON body on `.error`. Other shapes
 * (raw `fetch` Response wrappers, `ResponseError`-style objects) put
 * the body on `.body` or in `.response.data`. We check the canonical
 * SDK shape and fall back to the message-as-JSON shape used by some
 * middleware/log flatteners.
 *
 * Returns the body object iff:
 *   1. The error is HTTP 402.
 *   2. The body contains `displayToUser === true`.
 *
 * Otherwise returns `null`. Callers MUST NOT regex-match on `detail`
 * to make rendering decisions — the `displayToUser` flag is the single
 * source of truth.
 */
function tryParseJsonObject(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return asRecord(parsed);
    // eslint-disable-next-line industry/require-catch-handling -- silent by design: invalid JSON in the message means there is no displayable body to extract; falling back to undefined is the intended behavior.
  } catch {
    return undefined;
  }
}

function extractIndustry402BodyShape(error: unknown): UnknownRecord | undefined {
  // Anthropic-SDK / OpenAI-SDK shape: parsed body on `.error`.
  const obj = asRecord(error);
  const sdkBody = asRecord(obj?.error);
  if (sdkBody) return sdkBody;

  // ResponseError-style shape: body fields on the error itself.
  if (obj && (obj.detail !== undefined || obj.displayToUser !== undefined)) {
    return obj;
  }

  // JSON flattened into the message string (some middlewares).
  const message = extractErrorMessage(error);
  const messageBody = tryParseJsonObject(message);
  if (messageBody) return messageBody;

  // Wrapped error: recurse into `.cause` (matches isHttpStatusError).
  const cause = extractErrorCause(error);
  if (cause) return extractIndustry402BodyShape(cause);

  return undefined;
}

export function getIndustryDisplayable402Body(
  error: unknown
): IndustryDisplayable402Body | null {
  if (!isPaymentRequiredError(error)) return null;
  const body = extractIndustry402BodyShape(error);
  if (!body) return null;
  if (body.displayToUser !== true) return null;
  if (typeof body.detail !== 'string' || body.detail.length === 0) return null;
  return body as IndustryDisplayable402Body;
}

/**
 * Convenience predicate for callers that only need a boolean. Equivalent
 * to `getIndustryDisplayable402Body(error) !== null`.
 *
 * "Industry-displayable 402" replaces the previous regex-based
 * `isIndustryUsageExhaustedError` — the backend now signals this
 * explicitly via the `displayToUser` field on the 402 body, so clients
 * never have to introspect copy.
 */
export function isIndustryDisplayable402(error: unknown): boolean {
  return getIndustryDisplayable402Body(error) !== null;
}

/**
 * Checks if an error is an HTTP 401 Unauthorized response from an LLM provider.
 *
 * This indicates an API key issue (expired, rotated, or invalid credentials).
 * These errors are non-retryable because retrying with the same credentials
 * will always fail — and retrying amplifies the error count in telemetry
 * (Axiom 2026-04: ~111 errors/5d from "401 status code (no body)", 4-5x of
 * which are retry duplicates).
 *
 * Covers:
 * - HTTP 401 status on error object (SDK errors with `.status`/`.statusCode`/`.response.status`/`.response.statusCode`)
 * - "401 ..." prefixed message patterns (e.g. "401 status code (no body)", "401 Unauthorized")
 * - `AuthenticationError` class (Industry internal auth errors)
 * - Any of the above wrapped in `error.cause`
 */
/** @internal exported for unit tests */
export function isAuthenticationError(error: unknown): boolean {
  if (error instanceof AuthenticationError) return true;
  return isHttpStatusError(error, 401);
}

/**
 * Checks if an error is an HTTP 403 Forbidden response from an LLM provider.
 *
 * This is emitted primarily when the Industry proxy's `enforceModelPolicy`
 * rejects a model for an org (Axiom 2026-04: ~3173 errors/5d from
 * "403 status code (no body)"). Retrying with the same credentials and
 * policy will always fail, and provider rotation does not help when the
 * block originates at the proxy layer rather than the upstream provider.
 *
 * Covers:
 * - HTTP 403 status on error object (SDK errors)
 * - "403 ..." prefixed message patterns (e.g. "403 status code (no body)", "403 Forbidden")
 * - Any of the above wrapped in `error.cause`
 */
/** @internal exported for unit tests */
export function isForbiddenError(error: unknown): boolean {
  return isHttpStatusError(error, 403);
}

/**
 * Checks if an error is a reasoning-block signature validation failure
 * from any provider. All three variants share the same recovery strategy:
 * strip the offending reasoning artifacts from history and retry once.
 *
 * Anthropic patterns:
 *   - "Invalid `signature` in `thinking` block"
 *
 * Gemini patterns:
 *   - "Thought signature is not valid"
 *   - "Function call is missing a thought_signature"
 *   - "Invalid value at 'contents[N].parts[M].thought_signature' (TYPE_BYTES), Base64 decoding failed"
 *   - "Invalid Argument with thought_signature on text parts"
 *   - "missing a `thought_signature`"
 *
 * OpenAI patterns (encrypted reasoning blob signed with the issuing org's
 * key; fails verification when the proxy rotates to a different org):
 *   - "Encrypted content organization_id did not match the target organization"
 *   - "The encrypted content could not be verified"
 *   - "The encrypted content could not be decrypted or parsed"
 */
export function isThinkingSignatureError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  if (!message) return false;
  return (
    // Anthropic: "Invalid `signature` in `thinking` block"
    /invalid.*signature.*thinking/i.test(message) ||
    // Gemini: "Thought signature is not valid", "thought_signature invalid", etc.
    /thought[-_ ]?signature.*(?:not |in)valid/i.test(message) ||
    // Gemini: "missing a thought_signature", "Invalid value at ... thought_signature"
    /(?:invalid|missing).*thought[-_ ]?signature/i.test(message) ||
    // OpenAI: encrypted reasoning blob org_id mismatch / verification failure
    /encrypted content.*(?:organization_id|could not be (?:verified|decrypted|parsed))/i.test(
      message
    )
  );
}

interface SignatureErrorLocation {
  messageIndex: number;
  blockIndex: number;
  provider: 'anthropic' | 'gemini' | 'openai';
}

/**
 * Parses the message/block indices from an API validation error.
 * The provider is determined structurally from the error format itself,
 * not from keyword matching.
 *
 * Anthropic format: "messages.3.content.1: Invalid `signature` in `thinking` block"
 * Gemini format:    "Invalid value at 'contents[3].parts[0].thought_signature' ..."
 *                   "function call `name` in the 4. content block"
 *
 * Returns the indices and provider if found, or undefined if unparseable.
 */
export function parseSignatureErrorLocation(
  error: unknown
): SignatureErrorLocation | undefined {
  const message = extractErrorMessage(error);
  if (!message) return undefined;

  // Anthropic: messages.N.content.M
  const anthropicMatch = message.match(/messages\.(\d+)\.content\.(\d+)/);
  if (anthropicMatch) {
    return {
      messageIndex: parseInt(anthropicMatch[1], 10),
      blockIndex: parseInt(anthropicMatch[2], 10),
      provider: 'anthropic',
    };
  }

  // Gemini: contents[N].parts[M].thought_signature
  const geminiMatch = message.match(/contents\[(\d+)]\.parts\[(\d+)]/);
  if (geminiMatch) {
    return {
      messageIndex: parseInt(geminiMatch[1], 10),
      blockIndex: parseInt(geminiMatch[2], 10),
      provider: 'gemini',
    };
  }

  // Gemini: "in the N. content block" (1-based ordinal)
  const ordinalMatch = message.match(
    /(?:in|at)\s+the\s+(\d+)\.\s*content\s+block/i
  );
  if (ordinalMatch) {
    return {
      messageIndex: parseInt(ordinalMatch[1], 10) - 1,
      blockIndex: -1, // unknown part index
      provider: 'gemini',
    };
  }

  // OpenAI: encrypted reasoning content errors don't include a parseable
  // location -- the entire stale reasoning blob has to be wiped from history.
  if (
    /encrypted content.*(?:organization_id|could not be (?:verified|decrypted|parsed))/i.test(
      message
    )
  ) {
    return {
      messageIndex: -1,
      blockIndex: -1,
      provider: 'openai',
    };
  }

  return undefined;
}

/**
 * Checks if an error is a timeout error (connection or operation timeout).
 * Covers SDK timeout errors (APITimeoutError, TimeoutError), ETIMEDOUT/ECONNRESET
 * network errors, and provider-side timeout messages.
 */
export function isTimeoutError(error: unknown): boolean {
  const name = extractErrorName(error);
  if (
    name === 'TimeoutError' ||
    name === 'APITimeoutError' ||
    name === 'BodyTimeoutError'
  )
    return true;

  const code = extractErrorCode(error);
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  )
    return true;

  const message = extractErrorMessage(error);
  if (message) {
    if (/timed?\s*out|ETIMEDOUT|ECONNRESET|connect\s+timeout/i.test(message))
      return true;
  }

  const cause = extractErrorCause(error);
  if (cause && isTimeoutError(cause)) return true;

  return false;
}

/**
 * Checks if an error is related to Anthropic's PDF page limit.
 * Anthropic returns a 400 error with "A maximum of 100 PDF pages may be provided"
 * when a PDF exceeds their page limit. This error is deterministic and should not
 * be retried.
 */
/** @internal exported for unit tests */
export function isPdfPageLimitError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  if (!message) return false;
  return /maximum of \d+ PDF pages/i.test(message);
}

/**
 * Checks if an error indicates a corporate firewall blocking access to the
 * model endpoint. Enterprise environments (RBC, Morgan Stanley, and various
 * corporate networks) often return HTTP 403 with HTML block pages instead of
 * valid API responses. Not retryable -- the user must allowlist the domain.
 */
export function isCorporateFirewallError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  if (
    message &&
    (/Access Denied/i.test(message) ||
      /This Website Has Been Blocked/i.test(message) ||
      /not allowed by.*security policy/i.test(message) ||
      /Account is locked out/i.test(message) ||
      (/<html/i.test(message) && /403/i.test(message)) ||
      (/<!DOCTYPE/i.test(message) && /Forbidden/i.test(message)))
  ) {
    return true;
  }

  const cause = extractErrorCause(error);
  if (cause && isCorporateFirewallError(cause)) return true;

  return false;
}

/**
 * Checks if an error indicates a DNS resolution failure or complete network
 * unreachability (the machine cannot reach the model endpoint at all).
 * Not retryable -- the user must fix DNS/network.
 */
export function isDnsOrConnectionError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;

  const message = extractErrorMessage(error);
  if (
    message &&
    (/Unable to connect/i.test(message) ||
      /ENOTFOUND/i.test(message) ||
      /EAI_AGAIN/i.test(message) ||
      /getaddrinfo/i.test(message))
  ) {
    return true;
  }

  const cause = extractErrorCause(error);
  if (cause && isDnsOrConnectionError(cause)) return true;

  return false;
}

/**
 * Checks if an error indicates a TLS certificate verification failure.
 * Common with corporate MITM/SSL inspection proxies that inject untrusted root
 * CAs. Not retryable -- the user must configure NODE_EXTRA_CA_CERTS or trust
 * the corporate CA.
 */
export function isTlsCertificateError(error: unknown): boolean {
  const code = extractErrorCode(error);
  if (
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  ) {
    return true;
  }

  const message = extractErrorMessage(error);
  if (
    message &&
    (/certificate verification/i.test(message) ||
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(message) ||
      /self.signed certificate/i.test(message) ||
      /CERT_HAS_EXPIRED/i.test(message) ||
      /DEPTH_ZERO_SELF_SIGNED_CERT/i.test(message) ||
      /unable to get local issuer certificate/i.test(message))
  ) {
    return true;
  }

  const cause = extractErrorCause(error);
  if (cause && isTlsCertificateError(cause)) return true;

  return false;
}

// TODO: make this more precise
export function isRetryableLLMError(error: unknown): boolean {
  // Empty-response errors carry their own retry decision: the thrower caps
  // per-send empty retries and marks deterministic refusals non-retryable.
  if (error instanceof LLMEmptyResponseError) return error.shouldRetry();
  if (isContextLimitError(error)) return false;
  if (isContentModerationError(error)) return false;
  if (isNaNOverflowError(error)) return false;
  if (isPaymentRequiredError(error)) return false;
  if (isThinkingSignatureError(error)) return false;
  if (isPdfPageLimitError(error)) return false;
  if (isCorporateFirewallError(error)) return false;
  if (isDnsOrConnectionError(error)) return false;
  if (isTlsCertificateError(error)) return false;
  if (isAuthenticationError(error)) return false;
  if (isForbiddenError(error)) return false;
  if (isAbortError(error)) return false;

  // Catch-all: per HTTP semantics any 4xx other than 429 is deterministic
  // and not worth retrying. 429 (throttling) and 5xx (provider capacity /
  // transient server errors) remain retryable. The specific detectors
  // above still run first so callers can branch on semantic predicates
  // for telemetry and UX (e.g. FAC-16834 unknown-model 400, 404, 422
  // schema validation all hit this fall-through).
  const status = extractHttpStatus(error);
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return false;
  }
  return true;
}

/**
 * Whether an error is non-retryable on the same endpoint but may succeed
 * on a different provider via rotation.
 */
export function isRetryableOnAnotherProvider(error: unknown): boolean {
  if (extractHttpStatus(error) === 404) return true;
  if (isContentModerationError(error)) return true;
  if (isNaNOverflowError(error)) return true;
  return false;
}

/**
 * Pull empty-response telemetry from an error or its cause chain (the
 * compaction Summarizer wraps {@link LLMEmptyResponseError} in a MetaError),
 * so the compaction-end log/metric can record *why* the summary was empty —
 * burn (`length`/`max-tokens`), refusal (`content-filter`), or transient
 * empty (`none`) — turning post-deploy verification into a single query.
 */
export function extractEmptyResponseTelemetry(
  error: unknown
): EmptyResponseTelemetry | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof LLMEmptyResponseError) {
      return {
        failureReason: current.stopReason ?? 'none',
        outputTokens: current.outputTokens,
        length: current.thinkingContentLength,
        attempt: current.emptyAttempts,
      };
    }
    current = extractErrorCause(current);
  }
  return undefined;
}
