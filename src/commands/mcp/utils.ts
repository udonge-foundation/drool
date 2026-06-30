import {
  McpServerStatus,
  type McpServerStatusInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logWarn } from '@industry/logging';
import { McpSettingsManager } from '@industry/runtime/settings';
import { getMcpServerUiState, normalizeServerName } from '@industry/utils/mcp';

import type { McpCommandResult } from '@/commands/mcp/types';
import { getSessionController } from '@/controllers/SessionController';
import { buildMcpStatusNotification } from '@/exec/mcpStatusHandler';
import { getI18n } from '@/i18n';
import { getMcpService } from '@/services/mcp/McpService';
import { sanitizeInlineText } from '@/utils/sanitizeInlineText';

import type { McpPolicy, McpServerConfig } from '@industry/common/settings';

const MAX_DISPLAYED_SERVER_NAME_LENGTH = 64;

type ToggleAction = 'enable' | 'disable';

const quoteServers = (names: string[]): string =>
  names.map((s) => `"${s}"`).join(', ');

const MCP_LIST_START_TIMEOUT_MS = 30_000;
const MCP_LIST_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Wait for an MCP lifecycle operation, but never longer than `timeoutMs`.
 *
 * `drool mcp list` must stay responsive even when a configured server hangs
 * during startup or teardown, so slow or failing operations are abandoned
 * (logged as warnings) and the command reports whatever state is known.
 */
async function awaitWithTimeout(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const guarded = operation.catch((error) => {
    logWarn('[mcp list] MCP lifecycle operation failed', { cause: error });
  });
  try {
    await Promise.race([
      guarded,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function formatServerState(params: {
  config: McpServerConfig;
  policy: McpPolicy | undefined;
  info: McpServerStatusInfo | undefined;
}): { state: string; needsAuth: boolean } {
  const t = getI18n().t;
  const { config, policy, info } = params;

  if (config.disabled) {
    return { state: t('commands:mcp.list.disabled'), needsAuth: false };
  }
  if (!McpSettingsManager.isServerAllowedByPolicy(config, policy)) {
    return { state: t('commands:mcp.list.blockedByPolicy'), needsAuth: false };
  }
  if (!info) {
    return { state: t('commands:mcp.list.connecting'), needsAuth: false };
  }

  const uiState = getMcpServerUiState(info);
  if (uiState.needsAuth) {
    return { state: t('commands:mcp.list.needsAuth'), needsAuth: true };
  }
  if (info.status === McpServerStatus.Connected) {
    return {
      state: uiState.isAuthenticated
        ? t('commands:mcp.list.connectedAuthenticated')
        : t('commands:mcp.list.connected'),
      needsAuth: false,
    };
  }
  if (info.status === McpServerStatus.Failed) {
    return {
      state: t('commands:mcp.list.failed', {
        // Transport/server error strings are untrusted display input.
        message: sanitizeInlineText(
          info.error ?? t('commands:mcp.unexpectedError')
        ),
      }),
      needsAuth: false,
    };
  }
  return { state: t('commands:mcp.list.connecting'), needsAuth: false };
}

/**
 * Connects to configured MCP servers and reports connection and
 * authentication status for the standalone `drool mcp list` command.
 */
export async function handleListCommand(): Promise<McpCommandResult> {
  try {
    const t = getI18n().t;
    const settingsManager = McpSettingsManager.getInstance();
    const [servers, attribution, policy] = await Promise.all([
      settingsManager.getMcpServers(),
      settingsManager.getMcpServerAttribution(),
      settingsManager.getMcpPolicy(),
    ]);
    const entries = Object.entries(servers).sort(([left], [right]) =>
      left.localeCompare(right)
    );

    if (entries.length === 0) {
      return {
        success: true,
        message: t('commands:mcp.list.noServers'),
      };
    }

    // Listing connects to configured servers (including project-level stdio
    // commands); disclose the side effect on stderr so stdout stays a clean
    // status table.
    process.stderr.write(`${t('commands:mcp.list.connectingNotice')}\n`);

    const mcpService = getMcpService();
    let statusInfoByName: Map<string, McpServerStatusInfo>;
    try {
      await awaitWithTimeout(mcpService.start(), MCP_LIST_START_TIMEOUT_MS);
      const notification = await buildMcpStatusNotification(mcpService);
      statusInfoByName = new Map(
        notification.servers.map((server) => [
          normalizeServerName(server.name),
          server,
        ])
      );
    } finally {
      await awaitWithTimeout(mcpService.cleanup(), MCP_LIST_CLEANUP_TIMEOUT_MS);
    }

    let anyNeedsAuth = false;
    const lines = [t('commands:mcp.list.heading')];
    for (const [name, config] of entries) {
      const normalizedName = normalizeServerName(name);
      const source = attribution[normalizedName]?.source;
      const { state, needsAuth } = formatServerState({
        config,
        policy,
        info: statusInfoByName.get(normalizedName),
      });
      anyNeedsAuth ||= needsAuth;
      lines.push(
        t('commands:mcp.list.entry', {
          // Config keys (including repo-provided project-level config) are
          // untrusted display input.
          name: sanitizeInlineText(name, MAX_DISPLAYED_SERVER_NAME_LENGTH),
          transport: config.type ?? 'stdio',
          state,
          source: source
            ? t(`commands:mcp.list.sources.${source}`)
            : t('commands:mcp.list.unknownSource'),
        })
      );
    }

    if (anyNeedsAuth) {
      lines.push('', t('commands:mcp.list.authHint'));
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  } catch (error) {
    return {
      success: false,
      error: getI18n().t('commands:mcp.list.listError', {
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export async function handleToggleServersCommand(
  action: ToggleAction,
  names: string[]
): Promise<McpCommandResult> {
  try {
    const t = getI18n().t;
    const enabled = action === 'enable';
    const controller = getSessionController();
    const settingsManager = McpSettingsManager.getInstance();
    const attribution = await settingsManager.getMcpServerAttribution();

    const succeeded: string[] = [];
    const notFound: string[] = [];
    const orgReadOnly: string[] = [];

    for (const name of names) {
      const normalizedName = normalizeServerName(name);

      const source = attribution[normalizedName]?.source;
      if (!source) {
        notFound.push(name);
        continue;
      }
      if (source === SettingsLevel.Org) {
        orgReadOnly.push(name);
        continue;
      }

      // Managed servers are enabled/disabled via user overrides.
      const settingsLevel = SettingsLevel.User;
      const result = await controller.toggleMcpServer(
        normalizedName,
        enabled,
        settingsLevel
      );
      if (result.success) {
        succeeded.push(name);
      } else {
        notFound.push(name);
      }
    }

    if (notFound.length === 0 && orgReadOnly.length === 0) {
      return { success: true };
    }

    if (succeeded.length === 0) {
      if (orgReadOnly.length > 0 && notFound.length === 0) {
        return {
          success: false,
          error: t('commands:mcp.toggle.orgReadOnly', {
            servers: quoteServers(orgReadOnly),
            count: orgReadOnly.length,
          }),
        };
      }

      if (notFound.length > 0 && orgReadOnly.length === 0) {
        return {
          success: false,
          error: t('commands:mcp.toggle.notFound', {
            servers: quoteServers(notFound),
            count: notFound.length,
          }),
        };
      }

      return {
        success: false,
        error: t('commands:mcp.toggle.unableToToggle', {
          action,
          notFound: quoteServers(notFound),
          orgManaged: quoteServers(orgReadOnly),
        }),
      };
    }

    return { success: true };
  } catch (error) {
    const errorKey =
      action === 'enable'
        ? 'commands:mcp.toggle.enableError'
        : 'commands:mcp.toggle.disableError';
    logException(
      error,
      action === 'enable'
        ? 'Error enabling MCP server(s)'
        : 'Error disabling MCP server(s)'
    );
    return {
      success: false,
      error: getI18n().t(errorKey, {
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}

export async function getServerInfoFromAttribution(name: string): Promise<
  | {
      ok: true;
      normalizedName: string;
      source: SettingsLevel;
      isManaged: boolean;
    }
  | { ok: false }
> {
  const settingsManager = McpSettingsManager.getInstance();
  const attribution = await settingsManager.getMcpServerAttribution();
  const normalizedName = normalizeServerName(name);
  const info = attribution[normalizedName];
  if (!info) return { ok: false };

  return {
    ok: true,
    normalizedName,
    source: info.source,
    isManaged: info.isManaged,
  };
}
