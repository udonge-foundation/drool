import { IntegrationType } from '@industry/common/integrations';
import { fetch } from '@industry/drool-core/api/fetch';
import { logException } from '@industry/logging';
import { sleep } from '@industry/utils/time';

import { ConnectionStatus } from '@/commands/enums';
import { getEnv } from '@/environment';
import { SlackConnectionMessageKey } from '@/services/slack/enums';
import type {
  EnsureSlackConnectedOptions,
  EnsureSlackConnectedResult,
  SlackCheckResult,
} from '@/services/slack/types';

const NOT_CONNECTED_STATUSES = new Set([401, 403, 404]);
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

/** Public OAuth start URL for the Slack integration. */
export function getSlackOAuthStartUrl(): string {
  return `${getEnv().appBaseUrl}/settings/integrations/slack/start`;
}

/**
 * Check whether the org has a connected Slack integration.
 *
 * Treats 401/403/404 as "not connected" (the integration check endpoint
 * returns 404 when no integration exists). Any other error is surfaced as
 * `Error` so callers can decide whether to retry vs. surface to the user.
 */
export async function checkSlackConnection(): Promise<SlackCheckResult> {
  try {
    const response = await fetch('/api/integrations/org/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ integration: IntegrationType.SLACK }),
    });
    const data = await response.json();
    return {
      status: ConnectionStatus.Connected,
      workspace: data?.details?.workspace,
    };
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    if (status && NOT_CONNECTED_STATUSES.has(status)) {
      return { status: ConnectionStatus.NotConnected };
    }
    return {
      status: ConnectionStatus.Error,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Poll for Slack connection completion. Returns as soon as the status is
 * `Connected` or `Error`; otherwise returns `NotConnected` after the budget.
 */
export async function pollForSlackConnection(): Promise<SlackCheckResult> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const result = await checkSlackConnection();
    if (result.status !== ConnectionStatus.NotConnected) return result;
  }
  return { status: ConnectionStatus.NotConnected };
}

/**
 * Ensure the org has a connected Slack integration:
 *   1. Returns immediately on `Connected`.
 *   2. On `NotConnected`, launches OAuth in the browser and polls for ≤60s.
 *   3. Surfaces `error` / `timeout` / `browser_failed` for callers to render.
 *
 * The caller renders status updates via `onMessage`. The browser launch is
 * delegated to `onOpenBrowser` so callers can swap implementations in tests.
 */
export async function ensureSlackConnected(
  options: EnsureSlackConnectedOptions
): Promise<EnsureSlackConnectedResult> {
  const { onMessage, onOpenBrowser } = options;

  const initial = await checkSlackConnection();

  if (initial.status === ConnectionStatus.Connected) {
    onMessage(
      SlackConnectionMessageKey.AlreadyConnected,
      initial.workspace ? { workspace: initial.workspace } : {}
    );
    return {
      ok: true,
      workspace: initial.workspace,
      alreadyConnected: true,
    };
  }

  if (initial.status === ConnectionStatus.Error) {
    onMessage(
      SlackConnectionMessageKey.Error,
      initial.errorMessage ? { message: initial.errorMessage } : {}
    );
    return {
      ok: false,
      reason: 'error',
      errorMessage: initial.errorMessage,
    };
  }

  // NotConnected — launch OAuth and poll.
  onMessage(SlackConnectionMessageKey.Opening, {});
  try {
    await onOpenBrowser();
  } catch (error) {
    logException(error, 'Failed to open Slack OAuth start URL');
    onMessage(SlackConnectionMessageKey.BrowserFailed, {});
    return { ok: false, reason: 'browser_failed' };
  }

  const polled = await pollForSlackConnection();
  if (polled.status === ConnectionStatus.Connected) {
    onMessage(
      SlackConnectionMessageKey.Connected,
      polled.workspace ? { workspace: polled.workspace } : {}
    );
    return {
      ok: true,
      workspace: polled.workspace,
      alreadyConnected: false,
    };
  }
  if (polled.status === ConnectionStatus.Error) {
    onMessage(
      SlackConnectionMessageKey.Error,
      polled.errorMessage ? { message: polled.errorMessage } : {}
    );
    return {
      ok: false,
      reason: 'error',
      errorMessage: polled.errorMessage,
    };
  }
  onMessage(SlackConnectionMessageKey.Timeout, {});
  return { ok: false, reason: 'timeout' };
}
