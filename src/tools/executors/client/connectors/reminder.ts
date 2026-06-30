import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { logWarn } from '@industry/logging';
import { getFlag } from '@industry/runtime/feature-flags';

import { fetchConnectorTools } from '@/tools/executors/client/connectors/client';
import { CONNECTOR_INSTRUCTIONS_REMINDER } from '@/tools/executors/client/connectors/constants';
import { formatConnectorConnectivityReminder } from '@/tools/executors/client/connectors/format';
import type { ConnectorToolsReminder } from '@/tools/executors/client/connectors/types';

import type { ConnectorTool } from '@industry/common/api/connectors';

const FETCH_TIMEOUT_MS = 2500;
const NO_SESSION_KEY = '__no_session__';
/**
 * Connected tools are refetched in the background at most once per window, so
 * apps connected mid-session surface in the reminder within {@link CACHE_TTL_MS}
 * rather than being pinned to the session's first fetch.
 */
const CACHE_TTL_MS = 60_000;
/**
 * Upper bound on cached sessions so a long-lived daemon serving many sessions
 * does not grow the cache without limit. The oldest entry is evicted first
 * (`Map` iteration is insertion-ordered).
 */
const MAX_CACHED_SESSIONS = 256;

interface ConnectorToolsCacheEntry {
  tools: ConnectorTool[];
  fetchedAt: number;
}

const toolsBySession = new Map<string, ConnectorToolsCacheEntry>();
const inFlightBySession = new Map<string, Promise<void>>();

function sessionKey(sessionId: string | null | undefined): string {
  return sessionId ?? NO_SESSION_KEY;
}

/** Test-only: clear the per-session connector tool cache. */
export function resetConnectorToolsReminderCache(): void {
  toolsBySession.clear();
  inFlightBySession.clear();
}

function storeConnectorTools(key: string, tools: ConnectorTool[]): void {
  if (!toolsBySession.has(key) && toolsBySession.size >= MAX_CACHED_SESSIONS) {
    const oldestKey = toolsBySession.keys().next().value;
    if (oldestKey !== undefined) {
      toolsBySession.delete(oldestKey);
    }
  }
  toolsBySession.set(key, { tools, fetchedAt: Date.now() });
}

/**
 * Kick off a background fetch of the session's connected tools, deduped per
 * session. Never blocks the caller and never rejects: a failure is logged and
 * leaves any previous cache entry in place so a later turn retries.
 */
function startConnectorToolsFetch(key: string): void {
  if (inFlightBySession.has(key)) {
    return;
  }
  const promise = fetchConnectorTools(true, {
    timeoutMs: FETCH_TIMEOUT_MS,
    discoveryOnly: true,
  })
    .then((tools) => {
      storeConnectorTools(key, tools);
    })
    .catch((error: unknown) => {
      logWarn('[Agent] Failed to fetch connector tools for reminder', {
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
    })
    .finally(() => {
      inFlightBySession.delete(key);
    });
  inFlightBySession.set(key, promise);
}

/**
 * Return the session's cached connector tools without blocking on the network.
 * Triggers a background refresh when the cache is empty or older than
 * {@link CACHE_TTL_MS}, and returns `null` until the first fetch resolves.
 */
function getCachedConnectorTools(
  sessionId: string | null | undefined
): ConnectorTool[] | null {
  const key = sessionKey(sessionId);
  const entry = toolsBySession.get(key);
  if (!entry || Date.now() - entry.fetchedAt >= CACHE_TTL_MS) {
    startConnectorToolsFetch(key);
  }
  return entry?.tools ?? null;
}

/**
 * Build the pre-turn connector-tools reminders for a session, or `null` when
 * the Connectors feature is disabled. Returns the stable instructions reminder
 * always, plus a separate connectivity reminder once connectivity is known.
 * The connected-tools fetch runs in the background, so while the first fetch is
 * still pending (cache is `null`) the connectivity reminder is omitted: this
 * avoids both a false "No apps are connected yet." on turn one and a duplicated
 * instructions block when the connectivity reminder appears later.
 */
export async function buildConnectorToolsReminderForSession(
  sessionId?: string | null
): Promise<ConnectorToolsReminder | null> {
  if (!getFlag(IndustryFeatureFlags.Connectors)) {
    return null;
  }

  const tools = getCachedConnectorTools(sessionId);
  return {
    instructions: CONNECTOR_INSTRUCTIONS_REMINDER,
    connectivity:
      tools !== null ? formatConnectorConnectivityReminder(tools) : null,
  };
}
