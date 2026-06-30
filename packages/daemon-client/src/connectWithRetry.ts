import { OtelTracing, SpanAttribute, SpanName } from '@industry/logging/tracing';
import { retry } from '@industry/utils/function';

import type { DaemonClient } from './DaemonClient';
import type { DaemonAuthenticateRequestParams } from '@industry/common/daemon';

const DEFAULT_MAX_RETRIES = 10;
const RETRY_POLL_INTERVAL_MS = 2_000;

interface ConnectWithRetryParams {
  client: DaemonClient;
  url: string;
  authParams: DaemonAuthenticateRequestParams;
  /** Called once before the first connection attempt to wake the machine. */
  ensureRunning?: () => Promise<void>;
  maxRetries?: number;
}

export async function connectAndAuthenticate({
  client,
  url,
  authParams,
}: Omit<
  ConnectWithRetryParams,
  'ensureRunning' | 'maxRetries'
>): Promise<void> {
  try {
    await client.connect(url);
    await client.authenticate(authParams);
  } catch (error) {
    client.disconnect();
    throw error;
  }
}

/**
 * Ensure a machine is running, then connect and authenticate a DaemonClient,
 * retrying the connect+authenticate cycle on failure.
 *
 * `ensureRunning` is called exactly once before the retry loop — subsequent
 * retries poll at a fixed interval while the machine finishes booting.
 *
 * Designed for headless callers (backend delegation, CLI) that don't have
 * a higher-level reconnection layer like DaemonSessionController.
 */
export async function connectWithRetry({
  client,
  url,
  authParams,
  ensureRunning,
  maxRetries = DEFAULT_MAX_RETRIES,
}: ConnectWithRetryParams): Promise<void> {
  if (ensureRunning) {
    await OtelTracing.trace(SpanName.COMPUTER_ENSURE_RUNNING, ensureRunning);
  }

  // Include client app + machine context in the authenticate handshake
  // so daemon spans carry it even when the caller's OTLP export is
  // blocked (e.g. ad blockers on web clients).
  const tracingMetadata = {
    ...client.getTracingMetadata(),
    ...(client.getClientSurface() ? { app: client.getClientSurface() } : {}),
  };

  let attempts = 0;
  const attempt = retry(
    async () => {
      attempts += 1;
      const attemptIndex = attempts;
      await OtelTracing.trace(
        SpanName.WEB_DAEMON_CONNECT_ATTEMPT,
        async () => {
          try {
            await client.connect(url);
            await client.authenticate({
              ...authParams,
              metadata: {
                tracing: tracingMetadata,
              },
            });
          } catch (error) {
            client.disconnect();
            throw error;
          }
        },
        {
          attributes: {
            [SpanAttribute.INDUSTRY_DAEMON_CONNECT_ATTEMPT_INDEX]: attemptIndex,
          },
        }
      );
    },
    {
      retries: maxRetries + 1,
      delay: RETRY_POLL_INTERVAL_MS,
    }
  );

  try {
    await attempt();
  } finally {
    OtelTracing.setActiveSpanAttributes({
      [SpanAttribute.INDUSTRY_DAEMON_CONNECT_ATTEMPTS]: attempts,
    });
  }
}
