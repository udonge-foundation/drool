/**
 * Shared utilities for Sentry integration
 * and utilities for checking if Sentry is enabled.
 */

import { isSentryEnabledFromConfig } from '../loggerConfig';
import { SentryAdapter } from './types';

let sentryAdapter: SentryAdapter | null = null;

/**
 * Checks if Sentry is enabled. Reads directly from the seeded logger config.
 * Callers should ensure `setLoggerConfig(...)` was called at the composition
 * root; otherwise the process.env fallback is used.
 */
export function isSentryEnabled(): boolean {
  // When no adapter is registered, Sentry is effectively disabled even if
  // config says otherwise — preserves prior behavior.
  if (!sentryAdapter) return false;
  return isSentryEnabledFromConfig();
}

export function setSentryAdapter(adapter: SentryAdapter): void {
  sentryAdapter = adapter;
}

export function getSentryAdapter(): SentryAdapter | undefined {
  if (!sentryAdapter) {
    return undefined;
  }
  return sentryAdapter;
}
