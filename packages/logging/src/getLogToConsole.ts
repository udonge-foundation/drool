import { defaultLogToConsole } from './defaultLogToConsole';
import { getSeededLogToConsole } from './loggerConfig';

import type { LogToConsoleFunction } from './types';

/**
 * INTERNAL: returns the seeded `logToConsole` if provided, otherwise the
 * package default (pino-backed). Consumers should NEVER call this; use
 * `logInfo`/`logWarn`/`logError`/`logException` instead.
 *
 * This lives in a separate file from `loggerConfig.ts` so that callers of
 * the seeded-config predicates (e.g. `sentry/index.ts`, which only needs
 * `isSentryEnabledFromConfig`) do not transitively pull in pino via
 * `defaultLogToConsole`. Pulling pino into unrelated link graphs breaks
 * Vitest ESM tests that globally mock `fs/promises` (sonic-boom fails to
 * resolve `require('util').inherits` under Vitest's CJS interop).
 */
export function getLogToConsole(): LogToConsoleFunction {
  return getSeededLogToConsole() ?? defaultLogToConsole;
}
