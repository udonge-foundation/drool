import { type McpPolicy, type McpServerConfig } from '@industry/common/settings';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  canonicalizeMcpServerNameMap,
  getMcpServerNameAliases,
  normalizeServerName,
} from '@industry/utils/mcp';

import { SettingsManager } from './SettingsManager';

import type { McpSettingsProvider } from './types';

export class McpSettingsManager {
  // eslint-disable-next-line no-use-before-define
  private static instance: McpSettingsManager | null = null;

  private settingsProvider: McpSettingsProvider;

  constructor(settingsProvider: McpSettingsProvider) {
    this.settingsProvider = settingsProvider;
  }

  static getInstance(): McpSettingsManager {
    if (!McpSettingsManager.instance) {
      McpSettingsManager.instance = new McpSettingsManager(
        SettingsManager.getInstance()
      );
    }
    return McpSettingsManager.instance;
  }

  static resetInstance(): void {
    McpSettingsManager.instance = null;
  }

  private static canonicalizeServers(
    servers: Record<string, McpServerConfig> | undefined
  ): Record<string, McpServerConfig> {
    return canonicalizeMcpServerNameMap(servers ?? {});
  }

  private static buildCanonicalServerUpdate(
    servers: Record<string, McpServerConfig>,
    name: string,
    config?: McpServerConfig
  ): Record<string, McpServerConfig | undefined> {
    const normalizedName = normalizeServerName(name);
    const updates = Object.create(null) as Record<
      string,
      McpServerConfig | undefined
    >;

    for (const alias of getMcpServerNameAliases(normalizedName, servers)) {
      updates[alias] = undefined;
    }

    if (config) {
      updates[normalizedName] = config;
    }

    return updates;
  }

  async getMcpServers(): Promise<Record<string, McpServerConfig>> {
    const resolved = await this.settingsProvider.getResolvedSettings();
    return McpSettingsManager.canonicalizeServers(resolved.mcp?.mcpServers);
  }

  async getEnabledMcpServers(): Promise<Record<string, McpServerConfig>> {
    const servers = await this.getMcpServers();
    const mcpPolicy = await this.getMcpPolicy();

    return Object.fromEntries(
      Object.entries(servers).filter(([_, config]) => {
        if (config.disabled) return false;
        return McpSettingsManager.isServerAllowedByPolicy(config, mcpPolicy);
      })
    );
  }

  static isServerAllowedByPolicy(
    config: McpServerConfig,
    policy: McpPolicy | undefined
  ): boolean {
    if (!policy?.enabled) return true;

    const allowlist = policy.allowlist ?? [];
    if (allowlist.length === 0) return false;

    const strip = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    return allowlist.some((entry) => {
      const pattern = strip(entry);

      if (config.type === 'http' || config.type === 'sse') {
        try {
          const { hostname } = new URL(config.url);
          return strip(hostname).includes(pattern);
        } catch (err) {
          logWarn('Failed to parse MCP server URL', { cause: err });
          return strip(config.url).includes(pattern);
        }
      }

      const cmd = strip(config.command);
      const args = (config.args ?? []).map((a) => strip(a));
      return cmd.includes(pattern) || args.some((a) => a.includes(pattern));
    });
  }

  async checkServerAgainstPolicy(config: McpServerConfig): Promise<boolean> {
    const resolved = await this.settingsProvider.getResolvedSettings();
    const mcpPolicy = resolved.general?.mcpPolicy;
    return McpSettingsManager.isServerAllowedByPolicy(config, mcpPolicy);
  }

  async getMcpPolicy(): Promise<McpPolicy | undefined> {
    const resolved = await this.settingsProvider.getResolvedSettings();
    return resolved.general?.mcpPolicy;
  }

  async getMcpServerAttribution(): Promise<
    Record<
      string,
      { source: SettingsLevel; isManaged: boolean; folderPath?: string }
    >
  > {
    const allLevels =
      await this.settingsProvider.getSettingsHierarchyWithAttribution();

    const sources = Object.create(null) as Record<string, SettingsLevel>;
    const folderPaths = Object.create(null) as Record<string, string>;
    const hasOrg = new Set<string>();
    const hasFolderOrProject = new Set<string>();

    for (const { level, settings, folderPath } of allLevels) {
      const servers = settings.mcp?.mcpServers ?? {};

      for (const name of Object.keys(servers)) {
        const normalizedName = normalizeServerName(name);

        if (!(normalizedName in sources)) {
          sources[normalizedName] = level;
          if (level === SettingsLevel.Folder && folderPath) {
            folderPaths[normalizedName] = folderPath;
          }
        }

        if (level === SettingsLevel.Org) {
          hasOrg.add(normalizedName);
        }

        if (level === SettingsLevel.Folder || level === SettingsLevel.Project) {
          hasFolderOrProject.add(normalizedName);
        }
      }
    }

    return Object.fromEntries(
      Object.entries(sources).map(([name, source]) => {
        const entry: {
          source: SettingsLevel;
          isManaged: boolean;
          folderPath?: string;
        } = {
          source,
          isManaged: !hasOrg.has(name) && hasFolderOrProject.has(name),
        };

        const folderPath = folderPaths[name];
        if (source === SettingsLevel.Folder && folderPath) {
          entry.folderPath = folderPath;
        }

        return [name, entry];
      })
    );
  }

  async getMcpConfigSources(): Promise<Record<string, SettingsLevel>> {
    const attribution = await this.getMcpServerAttribution();
    return Object.fromEntries(
      Object.entries(attribution).map(([name, { source }]) => [name, source])
    );
  }

  async getRemovableMcpServerNames(): Promise<string[]> {
    const [userSettings, attribution] = await Promise.all([
      this.settingsProvider.getLevelSettings(SettingsLevel.User),
      this.getMcpServerAttribution(),
    ]);
    const writableUserServers = new Set(
      Object.keys(userSettings.mcp?.mcpServers ?? {}).map(normalizeServerName)
    );

    return Object.entries(attribution)
      .filter(
        ([name, info]) =>
          writableUserServers.has(name) &&
          info.source === SettingsLevel.User &&
          !info.isManaged
      )
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
  }

  async addMcpServer(
    name: string,
    config: McpServerConfig,
    level: SettingsLevel
  ): Promise<void> {
    if (level !== SettingsLevel.User) {
      throw new MetaError('Cannot add MCP servers at non-user level');
    }

    const normalizedName = normalizeServerName(name);
    const currentSettings = await this.settingsProvider.getLevelSettings(level);
    const currentServers = currentSettings.mcp?.mcpServers ?? {};
    const nextConfig = {
      ...config,
      disabled: config.disabled ?? false,
    };

    await this.settingsProvider.updateLevelSettings(level, {
      mcp: {
        mcpServers: McpSettingsManager.buildCanonicalServerUpdate(
          currentServers,
          normalizedName,
          nextConfig
        ),
      },
    });
  }

  async removeMcpServer(name: string, level: SettingsLevel): Promise<boolean> {
    if (level !== SettingsLevel.User) {
      throw new MetaError('Cannot remove MCP servers at non-user level');
    }

    const normalizedName = normalizeServerName(name);
    const currentSettings = await this.settingsProvider.getLevelSettings(level);
    const currentServers = currentSettings.mcp?.mcpServers ?? {};
    const aliases = getMcpServerNameAliases(normalizedName, currentServers);

    if (aliases.length === 0) {
      return false;
    }

    await this.settingsProvider.updateLevelSettings(level, {
      mcp: {
        mcpServers: McpSettingsManager.buildCanonicalServerUpdate(
          currentServers,
          normalizedName
        ),
      },
    });
    return true;
  }

  async enableMcpServer(name: string, level: SettingsLevel): Promise<boolean> {
    return this.updateMcpServer(name, false, level);
  }

  async disableMcpServer(name: string, level: SettingsLevel): Promise<boolean> {
    return this.updateMcpServer(name, true, level);
  }

  private async updateMcpServer(
    name: string,
    disabled: boolean,
    level: SettingsLevel
  ): Promise<boolean> {
    if (level !== SettingsLevel.User) {
      throw new MetaError(
        'MCP server overrides can only be written at user level'
      );
    }

    const normalizedName = normalizeServerName(name);
    const sources = await this.getMcpConfigSources();

    if (!Object.hasOwn(sources, normalizedName)) {
      logWarn('[McpSettingsManager] MCP server update target not found', {
        name: normalizedName,
        state: level,
        isEnabled: !disabled,
        count: Object.keys(sources).length,
        reason: 'missing_config_source',
      });
      return false;
    }

    if (sources[normalizedName] === SettingsLevel.Org) {
      throw new MetaError('Cannot modify MCP servers at org level');
    }

    const resolvedServers = await this.getMcpServers();
    const resolvedConfig = resolvedServers[normalizedName];
    if (!resolvedConfig) {
      logWarn('[McpSettingsManager] MCP server update target not resolved', {
        name: normalizedName,
        state: level,
        isEnabled: !disabled,
        source: sources[normalizedName],
        count: Object.keys(resolvedServers).length,
        reason: 'missing_resolved_config',
      });
      return false;
    }

    const userSettings = await this.settingsProvider.getLevelSettings(
      SettingsLevel.User
    );
    const userServers = userSettings.mcp?.mcpServers ?? {};
    const canonicalUserServers =
      McpSettingsManager.canonicalizeServers(userServers);
    const currentConfig =
      canonicalUserServers[normalizedName] ?? resolvedConfig;
    const aliases = getMcpServerNameAliases(normalizedName, userServers);
    const hasOnlyCanonicalAlias =
      aliases.length === 1 && aliases[0] === normalizedName;

    if (!!currentConfig.disabled === disabled && hasOnlyCanonicalAlias) {
      return true;
    }

    await this.settingsProvider.updateLevelSettings(SettingsLevel.User, {
      mcp: {
        mcpServers: McpSettingsManager.buildCanonicalServerUpdate(
          userServers,
          normalizedName,
          { ...currentConfig, disabled }
        ),
      },
    });
    return true;
  }

  async enableMcpTools(
    serverName: string,
    toolNames: string[]
  ): Promise<Record<string, boolean>> {
    const normalizedServerName = normalizeServerName(serverName);
    const results: Record<string, boolean> = {};

    const prepared =
      await this.ensureMcpServerInUserLevel(normalizedServerName);
    if (!prepared) {
      for (const toolName of toolNames) {
        results[toolName] = false;
      }
      return results;
    }

    const userSettings = await this.settingsProvider.getLevelSettings(
      SettingsLevel.User
    );
    const userServers = userSettings.mcp?.mcpServers ?? {};
    const serverConfig =
      McpSettingsManager.canonicalizeServers(userServers)[normalizedServerName];

    if (!serverConfig) {
      for (const toolName of toolNames) {
        results[toolName] = false;
      }
      return results;
    }

    const currentDisabled = new Set(serverConfig.disabledTools ?? []);
    const aliases = getMcpServerNameAliases(normalizedServerName, userServers);
    const hasOnlyCanonicalAlias =
      aliases.length === 1 && aliases[0] === normalizedServerName;
    let hasChanges = false;

    for (const toolName of toolNames) {
      if (currentDisabled.has(toolName)) {
        currentDisabled.delete(toolName);
        hasChanges = true;
      }
      results[toolName] = true;
    }

    if (hasChanges || !hasOnlyCanonicalAlias) {
      await this.settingsProvider.updateLevelSettings(SettingsLevel.User, {
        mcp: {
          mcpServers: McpSettingsManager.buildCanonicalServerUpdate(
            userServers,
            normalizedServerName,
            {
              ...serverConfig,
              disabledTools:
                currentDisabled.size > 0
                  ? Array.from(currentDisabled)
                  : undefined,
            }
          ),
        },
      });
    }

    return results;
  }

  async disableMcpTools(
    serverName: string,
    toolNames: string[]
  ): Promise<Record<string, boolean>> {
    const normalizedServerName = normalizeServerName(serverName);
    const results: Record<string, boolean> = {};

    const prepared =
      await this.ensureMcpServerInUserLevel(normalizedServerName);
    if (!prepared) {
      for (const toolName of toolNames) {
        results[toolName] = false;
      }
      return results;
    }

    const userSettings = await this.settingsProvider.getLevelSettings(
      SettingsLevel.User
    );
    const userServers = userSettings.mcp?.mcpServers ?? {};
    const serverConfig =
      McpSettingsManager.canonicalizeServers(userServers)[normalizedServerName];

    if (!serverConfig) {
      for (const toolName of toolNames) {
        results[toolName] = false;
      }
      return results;
    }

    const currentDisabled = new Set(serverConfig.disabledTools ?? []);
    const aliases = getMcpServerNameAliases(normalizedServerName, userServers);
    const hasOnlyCanonicalAlias =
      aliases.length === 1 && aliases[0] === normalizedServerName;
    let hasChanges = false;

    for (const toolName of toolNames) {
      if (!currentDisabled.has(toolName)) {
        currentDisabled.add(toolName);
        hasChanges = true;
      }
      results[toolName] = true;
    }

    if (hasChanges || !hasOnlyCanonicalAlias) {
      await this.settingsProvider.updateLevelSettings(SettingsLevel.User, {
        mcp: {
          mcpServers: McpSettingsManager.buildCanonicalServerUpdate(
            userServers,
            normalizedServerName,
            {
              ...serverConfig,
              disabledTools: Array.from(currentDisabled),
            }
          ),
        },
      });
    }

    return results;
  }

  async setDisabledMcpTools(
    serverName: string,
    toolNames: string[]
  ): Promise<boolean> {
    const normalizedServerName = normalizeServerName(serverName);

    const prepared =
      await this.ensureMcpServerInUserLevel(normalizedServerName);
    if (!prepared) {
      return false;
    }

    const userSettings = await this.settingsProvider.getLevelSettings(
      SettingsLevel.User
    );
    const userServers = userSettings.mcp?.mcpServers ?? {};
    const serverConfig =
      McpSettingsManager.canonicalizeServers(userServers)[normalizedServerName];

    if (!serverConfig) {
      return false;
    }

    const currentDisabled = new Set(serverConfig.disabledTools ?? []);
    const newDisabled = new Set(toolNames);
    const aliases = getMcpServerNameAliases(normalizedServerName, userServers);
    const hasOnlyCanonicalAlias =
      aliases.length === 1 && aliases[0] === normalizedServerName;

    const setsEqual =
      currentDisabled.size === newDisabled.size &&
      [...currentDisabled].every((t) => newDisabled.has(t));

    if (setsEqual && hasOnlyCanonicalAlias) {
      return true;
    }

    await this.settingsProvider.updateLevelSettings(SettingsLevel.User, {
      mcp: {
        mcpServers: McpSettingsManager.buildCanonicalServerUpdate(
          userServers,
          normalizedServerName,
          {
            ...serverConfig,
            disabledTools: toolNames.length > 0 ? toolNames : undefined,
          }
        ),
      },
    });

    return true;
  }

  private async ensureMcpServerInUserLevel(
    normalizedServerName: string
  ): Promise<boolean> {
    const userSettings = await this.settingsProvider.getLevelSettings(
      SettingsLevel.User
    );
    const userServers = userSettings.mcp?.mcpServers ?? {};
    const canonicalUserServers =
      McpSettingsManager.canonicalizeServers(userServers);

    if (normalizedServerName in canonicalUserServers) {
      return true;
    }

    const sources = await this.getMcpConfigSources();
    const sourceLevel = sources[normalizedServerName];

    if (!sourceLevel) {
      return false;
    }

    const allServers = await this.getMcpServers();
    const serverConfig = allServers[normalizedServerName];

    if (!serverConfig) {
      return false;
    }

    await this.addMcpServer(
      normalizedServerName,
      { ...serverConfig },
      SettingsLevel.User
    );

    logInfo(
      '[McpSettingsManager] Copied MCP server to user level for modification',
      {
        name: normalizedServerName,
        state: sourceLevel,
      }
    );

    return true;
  }
}
