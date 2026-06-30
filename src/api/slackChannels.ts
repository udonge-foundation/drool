import {
  SlackChannel,
  SlackChannelSettings,
} from '@industry/common/integrations';
import { fetch } from '@industry/drool-core/api/fetch';
import { MetaError } from '@industry/logging/errors';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * Telemetry-safe shape describing an unexpected response without leaking
 * Slack channel names, settings, or other user-generated content. Logs only
 * the top-level keys (no values), so we can debug parser drift without
 * shipping API payloads to telemetry.
 */
function describeInvalidResponse(data: unknown): string[] {
  if (data === null || typeof data !== 'object') {
    return [];
  }
  return Object.keys(data as Record<string, unknown>);
}

/**
 * Fetch a `{ listeningChannels: SlackChannel[] }` response and validate the
 * shape. Used by every listening-channel endpoint (list / enable / settings).
 */
async function fetchListeningChannels(
  url: string,
  init?: RequestInit
): Promise<SlackChannel[]> {
  const response = await fetch(url, init);
  const data = (await response.json()) as
    | { listeningChannels?: SlackChannel[] }
    | undefined;
  if (!data || !Array.isArray(data.listeningChannels)) {
    throw new MetaError(`Invalid response from ${url}`, {
      keys: describeInvalidResponse(data),
    });
  }
  return data.listeningChannels;
}

/** List Slack channels the bot has access to. */
export async function listSlackChannels(): Promise<SlackChannel[]> {
  const url = '/api/integrations/slack/channels';
  const response = await fetch(url);
  const data = (await response.json()) as
    | { channels?: SlackChannel[] }
    | undefined;
  if (!data || !Array.isArray(data.channels)) {
    throw new MetaError(`Invalid response from ${url}`, {
      keys: describeInvalidResponse(data),
    });
  }
  return data.channels;
}

/** List Slack channels currently enabled for auto-backlinking. */
export async function listListeningChannels(): Promise<SlackChannel[]> {
  return fetchListeningChannels('/api/integrations/slack/listening-channels');
}

/** Enable a Slack channel for auto-backlinking. Returns the up-to-date list. */
export async function enableSlackListeningChannel(
  channelId: string
): Promise<SlackChannel[]> {
  return fetchListeningChannels(
    '/api/integrations/slack/listening-channels/enable',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ channelId }),
    }
  );
}

/** Update per-channel auto-run / auto-backlinking settings. */
export async function updateSlackChannelSettings(
  channelId: string,
  settings: Partial<SlackChannelSettings>
): Promise<SlackChannel[]> {
  return fetchListeningChannels(
    '/api/integrations/slack/listening-channels/settings',
    {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ channelId, settings }),
    }
  );
}
