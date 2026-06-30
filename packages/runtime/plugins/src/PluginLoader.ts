import * as fs from 'fs';
import * as path from 'path';

import {
  CustomCommand,
  CustomCommandSettings,
  CustomDrool,
  CustomDroolSettings,
  HookConfig,
  HookSettings,
  InstalledPluginEntry,
  InstalledPluginsRegistry,
  McpConfigSchema,
  McpSettings,
  Settings,
  Skill,
  SkillSettings,
} from '@industry/common/settings';
import { CommandSource } from '@industry/common/settings/enums';
import {
  DroolLocation,
  SettingsLevel,
  SkillLocation,
  DroolLocation as DroolLocationEnum,
  SettingsLevel as SettingsLevelEnum,
  SkillLocation as SkillLocationEnum,
} from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';
import {
  directoryExists,
  fileExists,
  findCommandFiles,
  findSkillDirectories,
  loadDroolFile,
  loadSkillFile,
} from '@industry/utils/frontmatter';

import { PluginLoadResult, PluginLoadWarning } from './types';

const DROOLS_DIR = 'drools';
const SKILLS_DIR = 'skills';
const COMMANDS_DIR = 'commands';
const HOOKS_DIR = 'hooks';
const HOOKS_FILE = 'hooks.json';
const MCP_FILE = 'mcp.json';
const SKILL_PROMPT_FILE = 'SKILL.md';

/**
 * Expand plugin root environment variables in hook commands.
 * Replaces ${CLAUDE_PLUGIN_ROOT}, $CLAUDE_PLUGIN_ROOT,
 * ${DROOL_PLUGIN_ROOT}, $DROOL_PLUGIN_ROOT with the actual plugin path.
 */
function expandPluginRootEnvVars(command: string, pluginPath: string): string {
  return command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginPath)
    .replace(/\$CLAUDE_PLUGIN_ROOT\b/g, pluginPath)
    .replace(/\$\{DROOL_PLUGIN_ROOT\}/g, pluginPath)
    .replace(/\$DROOL_PLUGIN_ROOT\b/g, pluginPath);
}

const HOOK_ARRAY_KEYS = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
] as const;

/**
 * Check if an item is in Claude Code flat format (has 'type' and 'command' at top level)
 * vs Drool format (has 'hooks' array).
 */
function isClaudeCodeHookFormat(
  item: unknown
): item is { type: string; command: string } {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    'command' in item &&
    !('hooks' in item)
  );
}

/**
 * Normalize hooks data to Drool format.
 * Claude Code uses flat format: { PreToolUse: [{ type: 'command', command: '...' }] }
 * Drool uses nested format: { PreToolUse: [{ hooks: [{ type: 'command', command: '...' }] }] }
 */
function normalizeHooksToIndustryFormat(data: unknown): HookSettings {
  if (!data || typeof data !== 'object') return {};

  const result: HookSettings = {};
  const record = data as Record<string, unknown>;

  for (const key of HOOK_ARRAY_KEYS) {
    const configs = record[key];
    if (!Array.isArray(configs) || configs.length === 0) continue;

    // Check if first item is Claude Code format
    if (isClaudeCodeHookFormat(configs[0])) {
      // Convert flat format to nested format
      result[key] = [
        {
          hooks: configs.map((item) => ({
            type: 'command' as const,
            command: (item as { command: string }).command,
            timeout: (item as { timeout?: number }).timeout,
          })),
        },
      ];
    } else {
      // Already in Drool format
      result[key] = configs as HookConfig[];
    }
  }

  // Copy scalar fields
  if ('hooksDisabled' in record && typeof record.hooksDisabled === 'boolean') {
    result.hooksDisabled = record.hooksDisabled;
  }
  if (
    'showHookOutput' in record &&
    typeof record.showHookOutput === 'boolean'
  ) {
    result.showHookOutput = record.showHookOutput;
  }

  return result;
}

/**
 * Expand plugin root env vars in all hook commands within HookSettings.
 * Replaces ${CLAUDE_PLUGIN_ROOT}, $CLAUDE_PLUGIN_ROOT,
 * ${DROOL_PLUGIN_ROOT}, $DROOL_PLUGIN_ROOT with the actual plugin path.
 */
function expandHookSettingsEnvVars(
  hooks: HookSettings,
  pluginPath: string
): HookSettings {
  const result: HookSettings = {};

  for (const key of HOOK_ARRAY_KEYS) {
    const configs = hooks[key];
    if (configs && Array.isArray(configs) && configs.length > 0) {
      const expandedConfigs: HookConfig[] = [];
      for (const config of configs) {
        if (!config || typeof config !== 'object') {
          logWarn('[PluginLoader] Skipping non-object HookConfig entry', {
            eventName: key,
            type: typeof config,
          });
          continue;
        }
        if (!Array.isArray(config.hooks)) {
          logWarn(
            '[PluginLoader] Skipping HookConfig with missing or invalid hooks array',
            {
              eventName: key,
              matcher: config.matcher,
            }
          );
          continue;
        }
        expandedConfigs.push({
          ...config,
          hooks: config.hooks.map((hook) => ({
            ...hook,
            command: hook.command
              ? expandPluginRootEnvVars(hook.command, pluginPath)
              : hook.command,
          })),
        });
      }
      if (expandedConfigs.length > 0) {
        result[key] = expandedConfigs;
      }
    }
  }

  // Copy scalar fields
  if (hooks.hooksDisabled !== undefined) {
    result.hooksDisabled = hooks.hooksDisabled;
  }
  if (hooks.showHookOutput !== undefined) {
    result.showHookOutput = hooks.showHookOutput;
  }

  return result;
}

function scopeToLocation(scope: SettingsLevel): DroolLocation {
  // Org and User scopes both map to Personal location
  return scope === SettingsLevelEnum.Project
    ? DroolLocationEnum.Project
    : DroolLocationEnum.Personal;
}

function scopeToSkillLocation(scope: SettingsLevel): SkillLocation {
  // Org and User scopes both map to Personal location
  return scope === SettingsLevelEnum.Project
    ? SkillLocationEnum.Project
    : SkillLocationEnum.Personal;
}

async function loadCommandFile(
  filePath: string
): Promise<CustomCommand | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    const fileName = path.basename(filePath);
    const name = fileName.replace(/\.[^.]+$/, '');

    const content = await fs.promises.readFile(filePath, 'utf-8');
    const firstLine = content.split('\n')[0] || '';
    const description = firstLine.startsWith('#')
      ? firstLine.replace(/^#\s*/, '')
      : `Custom command: ${name}`;

    // eslint-disable-next-line no-bitwise
    const isExecutable = (stats.mode & 0o111) !== 0;

    return {
      name,
      description,
      source: CommandSource.Workspace,
      filePath,
      isExecutable,
    };
  } catch (err) {
    logWarn('Failed to load plugin command file', { cause: err });
    return null;
  }
}

function mergeDrools(
  existing: CustomDroolSettings | undefined,
  incoming: CustomDroolSettings | undefined
): CustomDroolSettings | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged = [...(existing.customDrools || [])];
  const existingNames = new Set(merged.map((d) => d.metadata.name));

  for (const drool of incoming.customDrools || []) {
    if (!existingNames.has(drool.metadata.name)) {
      merged.push(drool);
    }
  }

  return { customDrools: merged };
}

function mergeSkills(
  existing: SkillSettings | undefined,
  incoming: SkillSettings | undefined
): SkillSettings | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged = [...existing];
  const existingNames = new Set(merged.map((s) => s.metadata.name));

  for (const skill of incoming) {
    if (!existingNames.has(skill.metadata.name)) {
      merged.push(skill);
    }
  }

  return merged;
}

function mergeCommands(
  existing: CustomCommandSettings | undefined,
  incoming: CustomCommandSettings | undefined
): CustomCommandSettings | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged = [...existing];
  const existingNames = new Set(merged.map((c) => c.name));

  for (const command of incoming) {
    if (!existingNames.has(command.name)) {
      merged.push(command);
    }
  }

  return merged;
}

function mergeHooks(
  existing: HookSettings | undefined,
  incoming: HookSettings | undefined
): HookSettings | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged: HookSettings = { ...existing };

  type HookArrayKey =
    | 'PreToolUse'
    | 'PostToolUse'
    | 'Notification'
    | 'UserPromptSubmit'
    | 'Stop'
    | 'SubagentStop'
    | 'PreCompact'
    | 'SessionStart'
    | 'SessionEnd';

  const hookKeys: HookArrayKey[] = [
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'UserPromptSubmit',
    'Stop',
    'SubagentStop',
    'PreCompact',
    'SessionStart',
    'SessionEnd',
  ];

  for (const key of hookKeys) {
    const existingHooks: HookConfig[] = merged[key] || [];
    const incomingHooks: HookConfig[] = incoming[key] || [];
    if (incomingHooks.length > 0) {
      merged[key] = [...existingHooks, ...incomingHooks];
    }
  }

  return merged;
}

function mergeMcp(
  existing: McpSettings | undefined,
  incoming: McpSettings | undefined
): McpSettings | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming;
  if (!incoming) return existing;

  return {
    mcpServers: {
      ...existing.mcpServers,
      ...incoming.mcpServers,
    },
  };
}

export class PluginLoader {
  async loadAllInstalledPlugins(
    installedPlugins: InstalledPluginsRegistry,
    scope: SettingsLevel
  ): Promise<PluginLoadResult> {
    // Flatten all plugin entries and filter by scope
    const pluginsToLoad: Array<{
      pluginId: string;
      entry: InstalledPluginEntry;
    }> = [];
    for (const [pluginId, entries] of Object.entries(
      installedPlugins.plugins
    )) {
      for (const entry of entries) {
        if (entry.scope === scope) {
          pluginsToLoad.push({ pluginId, entry });
        }
      }
    }

    // Load all plugins in parallel
    const loadedResults = await Promise.all(
      pluginsToLoad.map(({ pluginId, entry }) =>
        this.loadPluginComponentsWithWarnings(
          pluginId,
          entry.installPath,
          entry.scope
        )
      )
    );

    // Merge all loaded settings and collect warnings
    let mergedSettings: Settings = {};
    const allWarnings: PluginLoadWarning[] = [];

    for (const result of loadedResults) {
      mergedSettings = {
        drools: mergeDrools(mergedSettings.drools, result.settings.drools),
        skills: mergeSkills(mergedSettings.skills, result.settings.skills),
        commands: mergeCommands(
          mergedSettings.commands,
          result.settings.commands
        ),
        hooks: mergeHooks(mergedSettings.hooks, result.settings.hooks),
        mcp: mergeMcp(mergedSettings.mcp, result.settings.mcp),
      };
      allWarnings.push(...result.warnings);
    }

    return { settings: mergedSettings, warnings: allWarnings };
  }

  async loadPluginComponents(
    pluginCachePath: string,
    scope: SettingsLevel = SettingsLevelEnum.User
  ): Promise<Settings> {
    const result = await this.loadPluginComponentsWithWarnings(
      'unknown',
      pluginCachePath,
      scope
    );
    return result.settings;
  }

  async loadPluginComponentsWithWarnings(
    pluginId: string,
    pluginCachePath: string,
    scope: SettingsLevel = SettingsLevelEnum.User
  ): Promise<PluginLoadResult> {
    const warnings: PluginLoadWarning[] = [];

    const [droolsResult, skillsResult, commandsResult, hooksResult, mcpResult] =
      await Promise.all([
        this.loadDroolsWithWarnings(pluginId, pluginCachePath, scope),
        this.loadSkillsWithWarnings(pluginId, pluginCachePath, scope),
        this.loadCommandsWithWarnings(pluginId, pluginCachePath),
        this.loadHooksWithWarnings(pluginId, pluginCachePath),
        this.loadMcpWithWarnings(pluginId, pluginCachePath),
      ]);

    warnings.push(...droolsResult.warnings);
    warnings.push(...skillsResult.warnings);
    warnings.push(...commandsResult.warnings);
    warnings.push(...hooksResult.warnings);
    warnings.push(...mcpResult.warnings);

    return {
      settings: {
        drools: droolsResult.data,
        skills: skillsResult.data,
        commands: commandsResult.data,
        hooks: hooksResult.data,
        mcp: mcpResult.data,
      },
      warnings,
    };
  }

  private async loadDroolsWithWarnings(
    pluginId: string,
    pluginPath: string,
    scope: SettingsLevel
  ): Promise<{
    data: CustomDroolSettings | undefined;
    warnings: PluginLoadWarning[];
  }> {
    const warnings: PluginLoadWarning[] = [];
    const droolsDir = path.join(pluginPath, DROOLS_DIR);

    try {
      if (!(await directoryExists(droolsDir)))
        return { data: undefined, warnings };

      const files = await fs.promises.readdir(droolsDir);
      const mdFiles = files.filter((f) => f.endsWith('.md'));

      if (mdFiles.length === 0) return { data: undefined, warnings };

      const location = scopeToLocation(scope);

      const droolPromises = mdFiles.map(async (file) => {
        const filePath = path.join(droolsDir, file);
        const result = await loadDroolFile(filePath, location);
        if (result === null) {
          warnings.push({
            pluginId,
            component: 'drools',
            file,
            error: 'Failed to load drool file.',
          });
        } else {
          result.pluginId = pluginId;
          result.systemPrompt = expandPluginRootEnvVars(
            result.systemPrompt,
            pluginPath
          );
        }
        return result;
      });

      const results = await Promise.all(droolPromises);
      const drools = results.filter((d): d is CustomDrool => d !== null);

      return {
        data: drools.length > 0 ? { customDrools: drools } : undefined,
        warnings,
      };
    } catch (err) {
      logWarn('Failed to load drools from plugin', { cause: err });
      return { data: undefined, warnings };
    }
  }

  private async loadSkillsWithWarnings(
    pluginId: string,
    pluginPath: string,
    scope: SettingsLevel
  ): Promise<{
    data: SkillSettings | undefined;
    warnings: PluginLoadWarning[];
  }> {
    const warnings: PluginLoadWarning[] = [];
    const skillsDir = path.join(pluginPath, SKILLS_DIR);

    try {
      if (!(await directoryExists(skillsDir)))
        return { data: undefined, warnings };

      const skillDirPaths = await findSkillDirectories(skillsDir);
      if (skillDirPaths.length === 0) return { data: undefined, warnings };

      const location = scopeToSkillLocation(scope);

      const skillPromises = skillDirPaths.map(async (dirPath) => {
        const promptFile = path.join(dirPath, SKILL_PROMPT_FILE);
        const result = await loadSkillFile(promptFile, location);
        if (result === null) {
          warnings.push({
            pluginId,
            component: 'skills',
            file: path.basename(dirPath),
            error: 'Failed to load skill.',
          });
        } else {
          result.systemPrompt = expandPluginRootEnvVars(
            result.systemPrompt,
            pluginPath
          );
        }
        return result;
      });

      const results = await Promise.all(skillPromises);
      const skills = results.filter((s): s is Skill => s !== null);

      return {
        data: skills.length > 0 ? skills : undefined,
        warnings,
      };
    } catch (err) {
      logWarn('Failed to load skills from plugin', { cause: err });
      return { data: undefined, warnings };
    }
  }

  private async loadCommandsWithWarnings(
    pluginId: string,
    pluginPath: string
  ): Promise<{
    data: CustomCommandSettings | undefined;
    warnings: PluginLoadWarning[];
  }> {
    const warnings: PluginLoadWarning[] = [];
    const commandsDir = path.join(pluginPath, COMMANDS_DIR);

    try {
      if (!(await directoryExists(commandsDir)))
        return { data: undefined, warnings };

      const filePaths = await findCommandFiles(commandsDir);
      if (filePaths.length === 0) return { data: undefined, warnings };

      const commandPromises = filePaths.map(async (filePath) => {
        const result = await loadCommandFile(filePath);
        if (result === null) {
          warnings.push({
            pluginId,
            component: 'commands',
            file: path.relative(commandsDir, filePath),
            error: 'Failed to load command.',
          });
        }
        return result;
      });

      const results = await Promise.all(commandPromises);
      const commands = results.filter((c): c is CustomCommand => c !== null);

      return {
        data: commands.length > 0 ? commands : undefined,
        warnings,
      };
    } catch (err) {
      logWarn('Failed to load commands from plugin', { cause: err });
      return { data: undefined, warnings };
    }
  }

  private async loadHooksWithWarnings(
    pluginId: string,
    pluginPath: string
  ): Promise<{
    data: HookSettings | undefined;
    warnings: PluginLoadWarning[];
  }> {
    const warnings: PluginLoadWarning[] = [];
    // Try hooks/hooks.json first (new location), then fall back to root hooks.json
    const hooksFileInDir = path.join(pluginPath, HOOKS_DIR, HOOKS_FILE);
    const hooksFileRoot = path.join(pluginPath, HOOKS_FILE);

    let hooksFile: string | undefined;
    if (await fileExists(hooksFileInDir)) {
      hooksFile = hooksFileInDir;
    } else if (await fileExists(hooksFileRoot)) {
      hooksFile = hooksFileRoot;
    }

    if (!hooksFile) return { data: undefined, warnings };

    try {
      const content = await fs.promises.readFile(hooksFile, 'utf-8');
      const parsed = JSON.parse(content);

      // Support Claude Code wrapper format: { "description": "...", "hooks": {...} }
      const hooksData =
        parsed && typeof parsed === 'object' && 'hooks' in parsed
          ? parsed.hooks
          : parsed;

      // Normalize to Drool format (handles both Claude Code flat format and Drool nested format)
      const normalized = normalizeHooksToIndustryFormat(hooksData);

      // Expand plugin root env vars in hook commands
      const expanded = expandHookSettingsEnvVars(normalized, pluginPath);

      return { data: expanded, warnings };
    } catch (err) {
      logWarn('Failed to load hooks from plugin', { cause: err });
      return { data: undefined, warnings };
    }
  }

  private async loadMcpWithWarnings(
    pluginId: string,
    pluginPath: string
  ): Promise<{ data: McpSettings | undefined; warnings: PluginLoadWarning[] }> {
    const warnings: PluginLoadWarning[] = [];
    const mcpFile = path.join(pluginPath, MCP_FILE);

    try {
      if (!(await fileExists(mcpFile))) return { data: undefined, warnings };

      const content = await fs.promises.readFile(mcpFile, 'utf-8');
      const parsed = JSON.parse(content);
      const validated = McpConfigSchema.safeParse(parsed);

      if (!validated.success) {
        logWarn('Invalid mcp.json schema', {
          path: mcpFile,
          error: validated.error.message,
        });
        warnings.push({
          pluginId,
          component: 'mcp',
          file: MCP_FILE,
          error: 'Invalid MCP configuration.',
        });
        return { data: undefined, warnings };
      }

      if (!validated.data.mcpServers) {
        return { data: undefined, warnings };
      }

      return {
        data: {
          mcpServers: validated.data.mcpServers,
        } as unknown as McpSettings,
        warnings,
      };
    } catch (err) {
      logWarn('Failed to load MCP config from plugin', { cause: err });
      return { data: undefined, warnings };
    }
  }
}
