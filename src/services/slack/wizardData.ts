import { MetaError } from '@industry/logging/errors';
import { getAuthedUser } from '@industry/runtime/auth';

import { listComputers } from '@/api/computer';
import { listListeningChannels, listSlackChannels } from '@/api/slackChannels';
import { getRuntimeAuthConfig } from '@/environment';
import type { IncidentResponseSetupData } from '@/services/slack/types';

/**
 * Default auto-run prompt for Slack incident-response channels.
 *
 * Mirrors `SLACK_AUTO_RUN_INCIDENT_PROMPT` from the backend
 * (`apps/backend/src/services/integrations/slack/constants.ts`). Kept inline
 * here so the CLI can pre-fill the wizard's prompt step without an extra
 * round-trip; the user can edit it before applying.
 */
const DEFAULT_INCIDENT_PROMPT = [
  'Use the `/incident` skill for Slack incidents and run an RCA if applicable.',
  'If the thread message is an incident or asking for RCA/root-cause analysis, invoke the `incident` skill before investigating.',
  'AskUser is not supported in Slack auto-run sessions; if clarification is needed, post the question back to Slack in your final assistant message.',
].join('\n');

/**
 * Load every piece of data the `/setup-incident-response` wizard needs in
 * parallel. Returns a flat shape so any future caller (agent tool, headless
 * `drool` subcommand, alternative UI) can consume it identically.
 */
export async function loadIncidentResponseSetupData(): Promise<IncidentResponseSetupData> {
  const [channels, listeningChannels, computerList, viewer] = await Promise.all(
    [
      listSlackChannels(),
      listListeningChannels(),
      listComputers(),
      getAuthedUser(getRuntimeAuthConfig()),
    ]
  );

  if (!viewer || !viewer.userId) {
    throw new MetaError(
      'Cannot set up incident response without an authenticated user',
      { hasUser: Boolean(viewer) }
    );
  }

  return {
    channels,
    listeningChannels,
    computers: computerList.computers,
    defaultPrompt: DEFAULT_INCIDENT_PROMPT,
    viewer: { userId: viewer.userId },
  };
}
