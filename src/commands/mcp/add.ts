import shellQuote from 'shell-quote';

import { McpServerConfig } from '@industry/common/settings';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logInfo } from '@industry/logging';
import { McpSettingsManager } from '@industry/runtime/settings';
import { normalizeServerName } from '@industry/utils/mcp';

import { AddCommandOptions, McpCommandResult } from '@/commands/mcp/types';
import { getI18n } from '@/i18n';

function looksLikeHttpUrl(str: string): boolean {
  const trimmed = str.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

export async function handleAddCommand(
  name: string,
  commandOrUrl: string,
  options: AddCommandOptions
): Promise<McpCommandResult> {
  try {
    const t = getI18n().t;
    // Default type to 'stdio', allow override via options
    const type = options.type || 'stdio';

    // Validate type
    if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
      return {
        success: false,
        error: t('commands:mcp.add.invalidServerType', { type }),
      };
    }

    // Validate that options are appropriate for the server type
    if (type !== 'stdio' && options.env && options.env.length > 0) {
      return {
        success: false,
        error: t('commands:mcp.add.envOnlyStdio'),
      };
    }

    if (type === 'stdio' && options.header && options.header.length > 0) {
      return {
        success: false,
        error: t('commands:mcp.add.headerOnlyHttp'),
      };
    }

    const settingsManager = McpSettingsManager.getInstance();
    const normalizedName = normalizeServerName(name);

    // Check if server already exists
    const existingServers = await settingsManager.getMcpServers();
    if (existingServers[normalizedName]) {
      const existingServer = existingServers[normalizedName];

      let configDetails = '';
      if (existingServer.type === 'http' || existingServer.type === 'sse') {
        configDetails = t(
          existingServer.type === 'sse'
            ? 'commands:mcp.add.configTypeSse'
            : 'commands:mcp.add.configTypeHttp',
          {
            url: existingServer.url,
            headers:
              Object.keys(existingServer.headers || {}).join(', ') || 'none',
            disabled: String(existingServer.disabled || false),
          }
        );
      } else {
        configDetails = t('commands:mcp.add.configTypeStdio', {
          command: existingServer.command,
          args: JSON.stringify(existingServer.args || []),
          env: Object.keys(existingServer.env || {}).join(', ') || 'none',
          disabled: String(existingServer.disabled || false),
        });
      }

      return {
        success: false,
        error: t('commands:mcp.add.serverAlreadyExists', {
          name,
          configDetails,
        }),
      };
    }

    let serverConfig: McpServerConfig;
    let successMessage: string;

    if (type !== 'stdio') {
      // Parse HTTP headers
      const headers: Record<string, string> = {};
      if (options.header) {
        for (const headerVar of options.header) {
          const colonIndex = headerVar.indexOf(':');
          if (colonIndex === -1) {
            return {
              success: false,
              error: t('commands:mcp.add.invalidHeaderFormat', {
                header: headerVar,
              }),
            };
          }
          const key = headerVar.slice(0, colonIndex).trim();
          const value = headerVar.slice(colonIndex + 1).trim();
          if (!key || !value) {
            return {
              success: false,
              error: t('commands:mcp.add.invalidHeaderFormat', {
                header: headerVar,
              }),
            };
          }
          headers[key] = value;
        }
      }

      // Validate URL format
      try {
        const _ = new URL(commandOrUrl);
      } catch (_error) {
        return {
          success: false,
          error: t('commands:mcp.add.invalidUrlFormat', { url: commandOrUrl }),
        };
      }

      const remoteConfig = {
        url: commandOrUrl,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        ...(options.oauth === false ? ({ oauth: false } as const) : {}),
        disabled: false,
      };
      serverConfig =
        type === 'http'
          ? { ...remoteConfig, type: 'http' }
          : { ...remoteConfig, type: 'sse' };

      successMessage = t(
        type === 'sse'
          ? 'commands:mcp.add.addedSse'
          : 'commands:mcp.add.addedHttp',
        {
          name,
          url: commandOrUrl,
        }
      );
    } else {
      // type === 'stdio'

      // Parse environment variables
      const env: Record<string, string> = {};
      if (options.env) {
        for (const envVar of options.env) {
          const [key, ...valueParts] = envVar.split('=');
          if (!key || valueParts.length === 0) {
            return {
              success: false,
              error: t('commands:mcp.add.invalidEnvFormat', { envVar }),
            };
          }
          env[key] = valueParts.join('=');
        }
      }

      // Parse command and args using shell-quote to handle quoted strings properly
      // First, remove outer quotes if present (for wrapping the entire command)
      let commandString = commandOrUrl.trim();
      if (
        (commandString.startsWith('"') && commandString.endsWith('"')) ||
        (commandString.startsWith("'") && commandString.endsWith("'"))
      ) {
        commandString = commandString.slice(1, -1);
      }

      // Check if user is trying to add a remote URL without specifying transport
      // This check happens after stripping quotes so it works with quoted URLs
      if (!options.type && looksLikeHttpUrl(commandString)) {
        return {
          success: false,
          error: t('commands:mcp.add.looksLikeUrl', {
            command: commandString,
            name,
            commandOrUrl,
          }),
        };
      }

      // Then use shell-quote to parse arguments that may contain quoted strings with spaces
      const commandParts = shellQuote
        .parse(commandString)
        .map((part) => part.toString());

      if (commandParts.length === 0) {
        return {
          success: false,
          error: t('commands:mcp.add.commandEmpty'),
        };
      }

      const executableCommand = commandParts[0];
      const commandArgs = commandParts.slice(1);

      serverConfig = {
        type: 'stdio',
        command: executableCommand,
        args: commandArgs,
        env: Object.keys(env).length > 0 ? env : undefined,
        disabled: false,
      };

      successMessage = t('commands:mcp.add.addedStdio', {
        name,
        command: commandString,
      });
    }

    // Check if the server is allowed by org MCP policy
    const isAllowed =
      await settingsManager.checkServerAgainstPolicy(serverConfig);

    // Add the server to the user config
    await settingsManager.addMcpServer(name, serverConfig, SettingsLevel.User);

    logInfo('Added MCP server via slash command', {
      name,
      type,
    });

    const policyWarning = isAllowed
      ? ''
      : ` (not enabled — does not match your organization's allowlist)`;

    return {
      success: true,
      message: successMessage + policyWarning,
    };
  } catch (error) {
    logException(error, 'Error adding MCP server');
    return {
      success: false,
      error: getI18n().t('commands:mcp.add.addError', {
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
}
