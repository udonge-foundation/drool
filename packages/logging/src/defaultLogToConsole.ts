import { trace } from '@opentelemetry/api';
import pino, { Logger as PinoLogger } from 'pino';

import { LogLevel } from './enums';
import {
  isProductionDeployment,
  shouldDisableConsoleLogsInTests,
  shouldLogTimestamps,
} from './loggerConfig';
import { LogMetadata, LogOptions } from './metadata/types';
import { getCurrentOrgRegion } from './regionResolver';
import { getRequestStore } from './requestLocal';
import { getSentryAdapter, isSentryEnabled } from './sentry';
import { TelemetryClient } from './telemetryClient';
import { normalizedMetadata } from './utils';

let pinoLogger: PinoLogger | null = null;

function getPinoLogger(): PinoLogger {
  if (!pinoLogger) {
    pinoLogger = pino({
      base: undefined,
      timestamp: shouldLogTimestamps(),
      formatters: {
        level(label, _number) {
          return { level: label };
        },
      },
    });
  }
  return pinoLogger;
}

/**
 * Default implementation of logToConsole. Reads configuration directly from
 * `loggerConfig`; apps must have called `setLoggerConfig(...)` at their
 * composition root (or accept the process.env fallback).
 */
export function defaultLogToConsole(
  level: LogLevel,
  message: string,
  metadata: LogMetadata,
  logOptions: LogOptions
): void {
  if (shouldDisableConsoleLogsInTests()) {
    return;
  }

  const isWebWorker =
    // @ts-expect-error
    typeof WorkerGlobalScope !== 'undefined' &&
    // @ts-expect-error
    // eslint-disable-next-line no-restricted-globals, no-undef
    self instanceof WorkerGlobalScope;

  if (isWebWorker) {
    return;
  }

  const cleanedMetadata = normalizedMetadata(metadata);

  if (typeof window !== 'undefined') {
    if (!isProductionDeployment()) {
      switch (level) {
        case 'warn':
          // eslint-disable-next-line no-console
          console.warn(message, metadata);
          break;
        case 'error':
          // eslint-disable-next-line no-console
          console.error(message, metadata);
          break;
        default:
          // eslint-disable-next-line no-console
          console.info(message, metadata);
      }
    }

    if (!logOptions.skipWebTelemetry) {
      return TelemetryClient.addLog_INTERNAL_USE_ONLY(
        level,
        message,
        cleanedMetadata
      );
    }
  }

  const store = getRequestStore() || {};
  const orgRegion = store.orgRegion ?? getCurrentOrgRegion();
  const loggingTags = {
    ...store,
    ...(cleanedMetadata?.tags || {}),
    // Tag every log with the authoritative region for post-hoc Axiom auditing
    // of residency boundaries. Write it last so caller tags cannot override it.
    ...(orgRegion === undefined ? {} : { orgRegion }),
  };

  const otelSpanContext = trace.getActiveSpan()?.spanContext();

  let sentrySpan;
  if (isSentryEnabled()) {
    const adapter = getSentryAdapter();
    sentrySpan = adapter?.getActiveSpan()?.spanContext();
  }

  const tags: Record<string, unknown> = { ...loggingTags };
  if (otelSpanContext?.traceId) tags.traceId = otelSpanContext.traceId;
  if (otelSpanContext?.spanId) tags.spanId = otelSpanContext.spanId;
  if (sentrySpan?.traceId) tags.sentryTraceId = sentrySpan.traceId;
  if (sentrySpan?.spanId) tags.sentrySpanId = sentrySpan.spanId;
  const combinedMetadata = { ...cleanedMetadata, tags };

  switch (level) {
    case 'warn':
      getPinoLogger().warn(combinedMetadata, message);
      break;
    case 'error':
      getPinoLogger().error(combinedMetadata, message);
      break;
    default:
      getPinoLogger().info(combinedMetadata, message);
  }
}
