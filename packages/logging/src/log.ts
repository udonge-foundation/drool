import { scrubbed, scrubSecrets } from '@industry/utils/secretScrubber';

import { LogLevel } from './enums';
import {
  isIndustryBackendWarningError,
  isFetchError,
  MetaError,
  ResponseError,
} from './errors/index';
import { getLogToConsole } from './getLogToConsole';
import { ErrorMetadata, LogMetadata, LogOptions } from './metadata/types';
import { isEuResidencyRequest } from './regionResolver';
import { getSentryAdapter, isSentryEnabled } from './sentry';
import {
  getErrorStack,
  getCause,
  toSentryError,
  getNameAndMessage,
} from './utils';

// Sanitize tag value: max 200 chars, no newlines
const sanitizeTagValue = (val: unknown): string => {
  const strValue = String(val).replace(/\n/g, ' ');
  return strValue.length > 200 ? `${strValue.substring(0, 197)}...` : strValue;
};

/**
 * Helper function to execute a callback with Sentry scope containing metadata
 * @param metadata Optional metadata to attach as tags
 * @param callback Function to execute within the scope
 */
const withSentryScope = (metadata: LogMetadata, callback: () => void) => {
  if (metadata && Object.keys(metadata).length > 0 && isSentryEnabled()) {
    const adapter = getSentryAdapter();
    adapter?.withScope((scope) => {
      // Add metadata as tags
      Object.entries(metadata).forEach(([key, value]) => {
        const cleanValue = sanitizeTagValue(value);
        if (cleanValue) scope.setTag(key, cleanValue);
      });
      callback();
    });
  } else {
    callback();
  }
};

// Keys whose values are user-generated content. Secret scrubbing won't
// catch arbitrary user prose, so for EU-residency orgs we drop the value
// entirely; non-EU orgs keep these for analytics.
const EU_ONLY_KEYS_TO_FULLY_REDACT: ReadonlySet<string> = new Set([
  'textPreview',
  'summary',
  'command',
  'commands',
  'extractedCommands',
  'result',
  'query',
  'stderr',
  'stdout',
  'stderrTail',
  'line',
  'content',
  'contentSoFar',
  'prompt',
  'input',
  'output',
  'bodyPreview',
  'toolCallArgs',
  'payload',
  'args',
]);

export function redactMetadata(metadata: LogMetadata = {}): LogMetadata {
  const keysToScrub = new Set([
    'body',
    'error',
    'errorMessage',
    'messages',
    // Ensure HTTP headers are scrubbed as well (FAC-11165)
    'headers',
    // Ensure cause is scrubbed to prevent leaking API payloads (FAC-11621)
    'cause',
    // SSE payloads can contain LLM response content
    'payload',
  ]);

  // Keys that must be FULLY dropped (not merely secret-scrubbed) because their
  // values are user-generated content echoed back from the runtime — secret
  // scrubbing only removes known credential patterns, which is not enough to
  // protect CMEK expectations. Zod issue JSON built from a corrupted mission
  // artifact can contain arbitrary user text (descriptions, pasted snippets,
  // filenames), so we replace the value with a constant placeholder. See
  // #974 and `packages/logging/src/metadata/types.ts`.
  const keysToFullyRedact = new Set(['issuesJson']);
  if (isEuResidencyRequest()) {
    for (const key of EU_ONLY_KEYS_TO_FULLY_REDACT) {
      keysToFullyRedact.add(key);
    }
  }
  const FULL_REDACTION_PLACEHOLDER = '[redacted]';

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object.fromEntries returns Record<string, V>; TS cannot recover the original mapped type
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      if (value === undefined) return [key, value];

      if (keysToFullyRedact.has(key)) {
        return [key, FULL_REDACTION_PLACEHOLDER];
      }

      if (!keysToScrub.has(key)) return [key, value];

      if (value instanceof Error) {
        const err = value;
        const scrubbedMessage = scrubSecrets(err.message);
        const scrubbedStack = err.stack ? scrubSecrets(err.stack) : undefined;
        try {
          err.message = scrubbedMessage;
          if (scrubbedStack !== undefined) {
            err.stack = scrubbedStack;
          }
          return [key, err];
        } catch (_error) {
          // If properties are readonly (e.g. ZodError), fall back to a plain object
          return [
            key,
            {
              name: err.name,
              message: scrubbedMessage,
              stack: scrubbedStack,
              ...Object.fromEntries(
                Object.entries(err).map(([k, v]) => [k, scrubbed(v)])
              ),
            },
          ];
        }
      }

      return [key, scrubbed(value)];
    })
  ) as LogMetadata;
}

interface LogExceptionOptions extends LogOptions {
  ignore400s?: boolean; // Whether to ignore 400 errors
}
/**
 * Use instead of console.error to log error messages to Sentry.
 * @param message The error message
 * @param metadata Optional metadata to attach as tags
 * @param options Optional options including telemetry settings
 */
export function logError(
  message: string,
  metadata?: LogMetadata,
  options?: LogOptions
) {
  const scrubbedMessage = scrubSecrets(message);
  const scrubbedMetadata = redactMetadata(metadata);
  const logToConsole = getLogToConsole();
  logToConsole(
    LogLevel.ERROR,
    scrubbedMessage,
    scrubbedMetadata,
    options || {}
  );

  if (isSentryEnabled()) {
    withSentryScope(scrubbedMetadata, () => {
      const adapter = getSentryAdapter();
      adapter?.captureMessage(scrubbedMessage);
    });
  }
}

const shouldLogToSentry = (
  error: unknown,
  { ignore400s = false }: LogExceptionOptions
): boolean => {
  if (!(error instanceof Error)) return false;

  if (ignore400s) {
    let e: Error | null = error;
    let depth = 0;
    while (e && depth < 3) {
      // Check FetchError (has response.status)
      if (isFetchError(e)) {
        if (e.response && e.response.status < 500) return false;
        break;
      }
      // Check ResponseError (has statusCode property)
      if (e instanceof ResponseError) {
        if (e.statusCode < 500) return false;
        break;
      }
      // Check if the error has a cause and continue checking it
      const cause = getCause(e);
      e = cause instanceof Error ? cause : null;
      depth++;
    }
  }
  return true;
};

/**
 * Use instead of console.error inside a catch block to log errors to Sentry.
 * @param error The error object
 * @param message Additional message to log with the error. Avoid using dynamic messages to ensure uniqueness.
 * @param metadata Optional metadata to attach as tags
 * @param options Optional options including telemetry and error handling settings
 */
export function logException(
  error: unknown,
  message: string,
  metadata?: ErrorMetadata,
  options?: LogExceptionOptions
) {
  const scrubbedMessage = scrubSecrets(message);

  // Extract metadata from MetaError
  let combinedMetadata = metadata || {};
  if (
    (error instanceof MetaError || error instanceof ResponseError) &&
    error.metadata
  ) {
    combinedMetadata = { ...error.metadata, ...combinedMetadata };
  }

  let consoleMessage = `${scrubbedMessage}\n${scrubSecrets(getErrorStack(error))}`;

  let cause = getCause(error) || metadata?.cause;

  if (cause) {
    combinedMetadata.cause = cause;
  }

  let depth = 0;
  while (cause && depth < 3) {
    consoleMessage += `\nCaused by:\n${scrubSecrets(getErrorStack(cause))}`;
    if (
      (cause instanceof MetaError || cause instanceof ResponseError) &&
      cause.metadata
    ) {
      combinedMetadata = { ...cause.metadata, ...combinedMetadata };
    }
    cause = getCause(cause);
    depth++;
  }

  const scrubbedMetadata = redactMetadata(combinedMetadata);
  const level = isIndustryBackendWarningError(error)
    ? LogLevel.WARN
    : LogLevel.ERROR;

  if (
    level === LogLevel.ERROR &&
    isSentryEnabled() &&
    shouldLogToSentry(error, options ?? {})
  ) {
    const sentryError = toSentryError(error, scrubbedMessage, cause);

    withSentryScope(scrubbedMetadata, () => {
      const adapter = getSentryAdapter();
      adapter?.captureException(sentryError);
    });
  }

  const logToConsole = getLogToConsole();
  const scrubbedMetadataWithError = {
    ...scrubbedMetadata,
    error: getNameAndMessage(error),
  };

  if (level === LogLevel.WARN && isSentryEnabled()) {
    withSentryScope(scrubbedMetadataWithError, () => {
      const adapter = getSentryAdapter();
      adapter?.addBreadcrumb({
        type: 'warn',
        level: 'warning',
        category: 'warn',
        message: scrubbedMessage,
        data: scrubbedMetadataWithError,
      });
    });
  }

  logToConsole(level, consoleMessage, scrubbedMetadataWithError, options || {});
}

export function logInfo(
  message: string,
  metadata?: LogMetadata,
  options?: LogOptions
) {
  const scrubbedMessage = scrubSecrets(message);
  const scrubbedMetadata = redactMetadata(metadata);
  const logToConsole = getLogToConsole();
  logToConsole(LogLevel.INFO, scrubbedMessage, scrubbedMetadata, options || {});
  if (isSentryEnabled()) {
    const adapter = getSentryAdapter();
    adapter?.addBreadcrumb({
      type: 'debug',
      message: scrubbedMessage,
      data: scrubbedMetadata,
    });
  }
}

export function logWarn(
  message: string,
  metadata?: LogMetadata,
  options?: LogOptions
) {
  const scrubbedMessage = scrubSecrets(message);
  const scrubbedMetadata = redactMetadata(metadata);
  const logToConsole = getLogToConsole();
  logToConsole(LogLevel.WARN, scrubbedMessage, scrubbedMetadata, options || {});
  if (isSentryEnabled()) {
    const adapter = getSentryAdapter();
    adapter?.addBreadcrumb({
      type: 'warn',
      level: 'warning',
      category: 'warn',
      message: scrubbedMessage,
      data: scrubbedMetadata,
    });
  }
}

const warnOnceKeys = new Set<string>();

/**
 * Like logWarn, but only emits the warning once per unique key per process.
 * Subsequent calls with the same key are silently suppressed.
 */
export function logWarnOnce(
  key: string,
  message: string,
  metadata?: LogMetadata,
  options?: LogOptions
) {
  if (warnOnceKeys.has(key)) return;
  warnOnceKeys.add(key);
  logWarn(message, metadata, options);
}
