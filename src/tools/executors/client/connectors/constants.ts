import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';

export const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * Stable first line carried by every connectivity reminder regardless of the
 * connected/disconnected wording, so the agent loop can recognize and prune
 * stale connectivity reminders (keeping only the latest state visible to the
 * model) instead of leaving contradictory copies in the conversation.
 */
export const CONNECTOR_CONNECTIVITY_SENTINEL = 'Connector connectivity status:';

const CONNECTOR_REMINDER_INSTRUCTIONS = [
  "Connector tools let you act on the user's connected external apps (for example GitHub, Linear, Jira) on their behalf through the ConnectorSearch tool. Connected connector tools are listed in a separate reminder so you do not need a discovery call to use them.",
  '',
  'Connectors usage rules:',
  '- An enabled MCP server or a specialized skill that already covers an external app/service takes priority over connectors: you SHOULD use those for that service and should not route through ConnectorSearch for it. Connectors fill the gap only when no enabled MCP server and no owned skill cover the need.',
  '- Otherwise, when a connected connector tool matches what the user needs from an external app, you SHOULD use it through ConnectorSearch (action "call_tool") instead of the Execute/CLI shell or web search.',
  '- For an external app that is not listed as connected: you SHOULD first use any MCP server tools available for that service, and fall back to connectors only when none exist. To use connectors, call ConnectorSearch with action "list_tools" (without authenticatedOnly), then "call_tool". If the result asks for authentication, share the returned connect link with the user, ask them to connect, then retry. Only do this when the user clearly wants something from that specific app.',
  '- Do not proactively name or speculate about the third-party platform that brokers connectors; refer to it as "connectors" or by the specific connected app\'s name (for example GitHub). Connect links may include the provider\'s domain; share the link as-is without drawing extra attention to the underlying platform.',
].join('\n');

/**
 * Stable pre-turn reminder carrying only the connectors usage rules. Emitted
 * whenever the Connectors feature is enabled (even when nothing is connected)
 * so the on-demand connect-link flow stays available. Kept separate from the
 * volatile connectivity reminder so it dedups by exact string instead of being
 * re-injected when the connected-tools list resolves on a later turn.
 */
export const CONNECTOR_INSTRUCTIONS_REMINDER = `${SYSTEM_REMINDER_START}
${CONNECTOR_REMINDER_INSTRUCTIONS}
${SYSTEM_REMINDER_END}`;
