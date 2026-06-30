export { logError, logException, logInfo, logWarn, logWarnOnce } from './log';

export { setRegionResolver } from './regionResolver';

export { MetaError } from './errors/errors';
export { type LogMetadata, type LogOptions } from './metadata/types';
export { setLoggerConfig, setLogToConsole } from './loggerConfig';
export type {
  LoggerConfig,
  LoggerConfigInput,
  LogToConsoleFunction,
  RequestLocalContext,
  TelemetryEvent,
  TelemetryClientConfig,
} from './types';
export {
  getNameAndMessage,
  extractOrgIdFromPath,
  extractSessionIdFromPath,
} from './utils';
export { runRequestStore, getRequestStore } from './requestLocal';

export type { MetricLabels } from './metrics/types';
export {
  AuthCallbackMetricKind,
  AuthCallbackNavigationType,
  AuthCallbackReferrerHostKind,
  Metric,
} from './metrics/enums';
export { Metrics } from './metrics';
export { setSentryAdapter, getSentryAdapter, isSentryEnabled } from './sentry';

export { OutcomeRecorder } from './outcome-recorder';
export { TelemetryClient } from './telemetryClient';
export { getTelemetryIngestBaseUrl } from './telemetryEnvironment';

// Note: OTEL types and classes should be imported from '@industry/logging/otel'
// This prevents Node.js modules from being bundled in browser environments
