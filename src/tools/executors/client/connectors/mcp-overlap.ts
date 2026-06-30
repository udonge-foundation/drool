import { getMcpServiceIfCreated } from '@/services/mcp/McpService';
import { connectorOf } from '@/tools/executors/client/connectors/connector-name';

import type { McpServerConfig } from '@industry/common/settings';

const MAX_TOKEN_NGRAM_SIZE = 3;

/**
 * Aliases let a running MCP server cover a connector even when its name or
 * config does not literally equal the connector slug (e.g. a "jira-mcp" or
 * Atlassian-backed server covers the "jira" connector, a "gitlab-self-hosted"
 * server covers "gitlab"). A connector with no entry here still matches on its
 * own normalized key.
 */
const CONNECTOR_ALIASES: Record<string, string[]> = {
  bitbucket: ['bitbucket'],
  confluence: ['confluence', 'atlassian'],
  figma: ['figma'],
  github: ['github', 'gh', 'ghe', 'ghes', 'githubenterprise'],
  gitlab: ['gitlab', 'gitlabsh', 'gitlabselfhosted'],
  googledrive: ['googledrive', 'gdrive'],
  jira: ['jira', 'atlassian'],
  linear: ['linear'],
  notion: ['notion'],
  slack: ['slack'],
};

const CONNECTOR_DISPLAY_NAMES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  googledrive: 'Google Drive',
};

function normalizeConnectorKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function connectorAliases(connectorKey: string): Set<string> {
  const normalized = normalizeConnectorKey(connectorKey);
  return new Set([normalized, ...(CONNECTOR_ALIASES[normalized] ?? [])]);
}

function tokenizeSignal(value: string): string[] {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .map(normalizeConnectorKey)
    .filter(Boolean);
}

/**
 * Collect alias-comparable candidates from a single signal value: each token,
 * the whole normalized value, and 2..3-grams of consecutive tokens (so a
 * "gitlab-self-hosted" server yields "gitlabselfhosted"). N-grams are formed
 * within one value only, so candidates never bridge separate servers.
 */
function addSignalTokenCandidates(value: string, into: Set<string>): void {
  const tokens = tokenizeSignal(value);
  for (const token of tokens) {
    into.add(token);
  }
  into.add(normalizeConnectorKey(value));

  for (let start = 0; start < tokens.length; start += 1) {
    for (
      let size = 2;
      size <= MAX_TOKEN_NGRAM_SIZE && start + size <= tokens.length;
      size += 1
    ) {
      into.add(tokens.slice(start, start + size).join(''));
    }
  }
}

/**
 * Signal strings drawn from a server's transport config. Config *values* for
 * env/headers are intentionally excluded (only their keys) so matching never
 * keys off secret tokens.
 */
function mcpConfigSignalValues(
  serverName: string,
  config: McpServerConfig
): string[] {
  const values = [serverName];

  if ('command' in config) {
    values.push(
      config.command,
      ...(config.args ?? []),
      ...Object.keys(config.env ?? {})
    );
  }

  if ('url' in config) {
    values.push(config.url, ...Object.keys(config.headers ?? {}));
  }

  return values;
}

/**
 * Alias-comparable signal tokens drawn from every running MCP server's name and
 * transport config (command/args/env-keys or url/header-keys). A connector is
 * covered when any of its aliases appears in this set. Derived from the live MCP
 * service, which only holds servers that passed org policy and started, so
 * disabled/blocked servers never contribute and connector OAuth stays available
 * when policy blocks the overlapping MCP server. MCP servers (and owned skills)
 * take priority over connectors, so ConnectorSearch uses this to refuse
 * connector discovery/execution for an already-covered service rather than
 * surfacing a redundant connector OAuth flow.
 */
export function getMcpCoveredSignalTokens(): Set<string> {
  const service = getMcpServiceIfCreated();
  if (!service) {
    return new Set();
  }
  const tokens = new Set<string>();
  for (const [name, server] of Object.entries(service.listServers())) {
    if (server.config.disabled) {
      continue;
    }
    for (const value of mcpConfigSignalValues(name, server.config)) {
      addSignalTokenCandidates(value, tokens);
    }
  }
  return tokens;
}

/**
 * Whether the given connector tool name (or bare slug) targets a service that
 * an enabled MCP server already covers, matching the connector's aliases
 * against the running servers' signal tokens.
 */
export function isConnectorMcpCovered(
  toolNameOrSlug: string,
  signalTokens: Set<string> = getMcpCoveredSignalTokens()
): boolean {
  if (signalTokens.size === 0) {
    return false;
  }
  const connectorKey = normalizeConnectorKey(
    connectorOf(toolNameOrSlug, toolNameOrSlug)
  );
  if (!connectorKey) {
    return false;
  }
  return [...connectorAliases(connectorKey)].some((alias) =>
    signalTokens.has(alias)
  );
}

/**
 * Human-readable connector name for a slug (e.g. "googledrive" -> "Google
 * Drive"), used when surfacing MCP-suppressed connectors to the model.
 */
export function connectorDisplayName(slug: string): string {
  const normalized = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
  const override = CONNECTOR_DISPLAY_NAMES[normalized];
  if (override) {
    return override;
  }
  const words = slug
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  const source = words.length > 0 ? words : [normalized];
  return source
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}
