import { createHash } from 'node:crypto';

import { logWarn } from '@industry/logging';
import { normalizeServerName } from '@industry/utils/mcp';

import type { McpServerBase, McpServerConfig } from '@industry/common/settings';

function canonicalizeForIdentity(
  config: McpServerBase | McpServerConfig
): Record<string, unknown> {
  const c = config as {
    type?: string;
    command?: string;
    args?: string[];
    url?: string;
  };
  // The mcp.json schema permits a shorthand stdio config where `type` is
  // omitted and only `command` is given — Zod defaults `type` to `'stdio'`
  // on load. Mirror that here so the shorthand form hashes identically
  // to the explicit form, and so two distinct shorthand configs with
  // different commands/args still produce distinct fingerprints.
  const effectiveType =
    c.type ?? (typeof c.command === 'string' ? 'stdio' : undefined);
  switch (effectiveType) {
    case 'stdio':
      return {
        type: 'stdio',
        command: c.command ?? '',
        args: c.args ?? [],
      };
    case 'http':
      return { type: 'http', url: c.url ?? '' };
    case 'sse':
      return { type: 'sse', url: c.url ?? '' };
    default:
      return {};
  }
}

/**
 * Compute a stable identity fingerprint for an MCP server's transport
 * config. The fingerprint captures only the bits that define WHAT the
 * server actually executes (stdio command+args) or WHERE it points
 * (http/sse url), so that:
 *
 *  - Renaming an unrelated field (e.g. toggling `disabled`, editing
 *    `disabledTools`) does not invalidate a previously persisted approval.
 *  - Re-pointing a server name at a different command or URL DOES
 *    invalidate it.
 *
 * Sensitive transport details (env vars, headers, oauth tokens) are
 * intentionally NOT hashed — they may rotate independently of the trust
 * boundary, and including them would falsely invalidate approvals on
 * routine credential refreshes. Trust is bound to the *destination*,
 * not the credential used to reach it.
 *
 * Returns a hex-encoded SHA-256 prefix. The full digest is overkill for
 * a non-cryptographic identity check; a 16-byte prefix gives ~2^64
 * collision resistance which is far beyond any plausible attack surface
 * on a single-user config file.
 */
export function computeMcpServerIdentity(
  config: McpServerBase | McpServerConfig
): string {
  const canonical = canonicalizeForIdentity(config);
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

/**
 * Resolve the identity fingerprint for the currently-configured MCP
 * server by `serverName`. Returns `undefined` when no server with that
 * name is currently configured (or McpService is unavailable). Callers
 * pass the result to `McpPermissionService` so identity drift between
 * the approval and the current config invalidates auto-approval.
 */
export async function resolveCurrentMcpServerIdentity(
  serverName: string
): Promise<string | undefined> {
  try {
    const { getMcpService } = await import('@/services/mcp/McpService');
    const mcpService = getMcpService();
    const configs = mcpService.getUserMcpConfigs();
    const config = configs?.[normalizeServerName(serverName)];
    return config ? computeMcpServerIdentity(config) : undefined;
  } catch (error) {
    logWarn('[mcpServerIdentity] Failed to resolve current server identity', {
      cause: error instanceof Error ? error.message : String(error),
      // eslint-disable-next-line industry/no-nested-log-metadata -- MCP server identity resolution context consumed as a unit
      value: { serverName },
    });
    return undefined;
  }
}
