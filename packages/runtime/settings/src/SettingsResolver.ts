import {
  DEFAULT_GENERAL_SETTINGS,
  type GeneralSettings,
  type McpServerConfig,
  type ManagedSettings,
  type SessionDefaultSettings,
  type Settings,
  type SkillSettings,
  type SettingsResolutionEvent,
} from '@industry/common/settings';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import {
  createResolutionEvent,
  mergeSandboxLevelUpdate,
} from '@industry/utils/settings';

import { IndustrySettingsFolder } from './IndustrySettingsFolder';
import { mergeCommands } from './mergeCommands';
import { mergeDrools } from './mergeDrools';
import { mergeGeneral } from './mergeGeneral';
import { mergeHooks } from './mergeHooks';
import { mergeMcp } from './mergeMcp';

import type { MergeHierarchyWithChainResult, SettingsUpdate } from './types';

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/--+/g, '-');
}

function createNullPrototypeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function defaultSettings(): Settings {
  return {
    general: DEFAULT_GENERAL_SETTINGS,
  };
}

export function mergeSkills(
  higher: SkillSettings | undefined,
  lower: SkillSettings | undefined
): SkillSettings | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  const result = [...higher];
  const indexByName = new Map(
    higher.map((skill, index): [string, number] => [
      sanitizeName(skill.metadata.name),
      index,
    ])
  );

  for (const skill of lower) {
    const name = sanitizeName(skill.metadata.name);
    const existingIndex = indexByName.get(name);

    if (existingIndex === undefined) {
      result.push(skill);
      indexByName.set(name, result.length - 1);
      continue;
    }

    const existingSkill = result[existingIndex];
    if (!existingSkill.metadata.enabled && skill.metadata.enabled) {
      result[existingIndex] = skill;
    }
  }

  return result;
}

function mergeMcpServerUpdates(
  currentServers: Record<string, McpServerConfig> | undefined,
  serverUpdates: Record<string, McpServerConfig | undefined> | undefined
): Record<string, McpServerConfig> {
  const merged = createNullPrototypeRecord<McpServerConfig>();

  for (const [name, config] of Object.entries(currentServers ?? {})) {
    merged[name] = config;
  }

  for (const [name, config] of Object.entries(serverUpdates ?? {})) {
    if (config === undefined) {
      delete merged[name];
    } else {
      merged[name] = config;
    }
  }

  return merged;
}

export function mergeUpdates(
  current: Settings,
  updates: SettingsUpdate
): Settings {
  let mergedGeneral = current.general;

  if (updates.general !== undefined && updates.general !== null) {
    mergedGeneral = {
      ...current.general,
      ...updates.general,
      // Sandbox uses a deep patch merge so updating one branch (e.g. filesystem)
      // does not wipe out sibling branches (e.g. network).
      sandbox:
        updates.general.sandbox !== undefined
          ? mergeSandboxLevelUpdate(
              current.general?.sandbox,
              updates.general.sandbox
            )
          : current.general?.sandbox,
      sessionDefaultSettings:
        updates.general.sessionDefaultSettings !== undefined
          ? {
              ...current.general?.sessionDefaultSettings,
              ...updates.general.sessionDefaultSettings,
            }
          : current.general?.sessionDefaultSettings,
      subagentModelSettings:
        updates.general.subagentModelSettings !== undefined
          ? {
              ...current.general?.subagentModelSettings,
              ...updates.general.subagentModelSettings,
            }
          : current.general?.subagentModelSettings,
      missionModelSettings:
        updates.general.missionModelSettings !== undefined
          ? {
              ...current.general?.missionModelSettings,
              ...updates.general.missionModelSettings,
            }
          : current.general?.missionModelSettings,
      ideExtensionPromptedAt:
        updates.general.ideExtensionPromptedAt !== undefined
          ? {
              ...current.general?.ideExtensionPromptedAt,
              ...updates.general.ideExtensionPromptedAt,
            }
          : current.general?.ideExtensionPromptedAt,
      ideActivationNudgedForVersion:
        updates.general.ideActivationNudgedForVersion !== undefined
          ? {
              ...current.general?.ideActivationNudgedForVersion,
              ...updates.general.ideActivationNudgedForVersion,
            }
          : current.general?.ideActivationNudgedForVersion,
    };
  }

  const shouldIncludeGeneral =
    (updates.general !== undefined && updates.general !== null) ||
    updates.hooks !== undefined;

  const mergedMcp =
    updates.mcp === undefined
      ? undefined
      : {
          mcpServers: mergeMcpServerUpdates(
            current.mcp?.mcpServers,
            updates.mcp?.mcpServers
          ),
          persistentPermissions:
            updates.mcp.persistentPermissions !== undefined
              ? updates.mcp.persistentPermissions
              : current.mcp?.persistentPermissions,
        };

  return {
    general: shouldIncludeGeneral ? mergedGeneral : undefined,
    mcp: mergedMcp,
    drools: updates.drools !== undefined ? updates.drools : undefined,
    skills: updates.skills !== undefined ? updates.skills : undefined,
    hooks:
      updates.hooks !== undefined
        ? { ...current.hooks, ...updates.hooks }
        : undefined,
    commands: updates.commands !== undefined ? updates.commands : undefined,
  };
}

function mergeHierarchy(levels: Settings[]): Settings {
  const reversed = [...levels].reverse();

  let result: Settings = {};
  for (const level of reversed) {
    result = {
      general: mergeGeneral(level.general, result.general),
      mcp: mergeMcp(level.mcp, result.mcp),
      drools: mergeDrools(level.drools, result.drools),
      skills: mergeSkills(level.skills, result.skills),
      hooks: mergeHooks(level.hooks, result.hooks),
      commands: mergeCommands(level.commands, result.commands),
    };
  }

  return result;
}

type HierarchyLevelWithAttribution = {
  level: SettingsLevel;
  settings: Settings;
  folderPath?: string;
  label?: string;
};

// =============================================================================
// Session Default Settings keys tracked in the resolution chain
// =============================================================================

const SESSION_DEFAULT_KEYS: (keyof SessionDefaultSettings)[] = [
  'model',
  'reasoningEffort',
  'interactionMode',
  'autonomyLevel',
  'autonomyMode',
  'specModeModel',
  'specModeReasoningEffort',
  'runInWorktree',
];

type SessionDefaultWinner = {
  level: SettingsLevel;
  precedence: number;
  label: string;
  folderPath?: string;
};

function setResolvedSessionDefault<K extends keyof SessionDefaultSettings>(
  target: Partial<SessionDefaultSettings>,
  key: K,
  value: SessionDefaultSettings[K]
): void {
  target[key] = value;
}

function getSessionDefaultPrecedence(level: SettingsLevel): number {
  switch (level) {
    case SettingsLevel.Runtime:
      return 0;
    case SettingsLevel.Folder:
      return 1;
    case SettingsLevel.Project:
      return 2;
    case SettingsLevel.User:
      return 3;
    case SettingsLevel.Org:
      return 4;
    case SettingsLevel.Dynamic:
      return 5;
    case SettingsLevel.BuiltIn:
      return 6;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function settingsLevelToSourceType(
  level: SettingsLevel
): SettingsResolutionEvent['source']['type'] {
  switch (level) {
    case SettingsLevel.Org:
      return 'org';
    case SettingsLevel.User:
      return 'user';
    case SettingsLevel.Project:
      return 'project';
    case SettingsLevel.Folder:
      return 'folder';
    case SettingsLevel.Dynamic:
      return 'dynamic-config';
    case SettingsLevel.BuiltIn:
      return 'builtin-default';
    default:
      return 'builtin-default';
  }
}

function resolveSessionDefaultSettingsInternal(
  levels: HierarchyLevelWithAttribution[]
): {
  sessionDefaultSettings?: SessionDefaultSettings;
  winners: Partial<Record<keyof SessionDefaultSettings, SessionDefaultWinner>>;
} {
  const resolved: Partial<SessionDefaultSettings> = {};
  const winners: Partial<
    Record<keyof SessionDefaultSettings, SessionDefaultWinner>
  > = {};

  for (const entry of levels) {
    const sessionDefaults = entry.settings.general?.sessionDefaultSettings;
    if (!sessionDefaults) continue;

    const label = entry.label ?? settingsLevelToSourceType(entry.level);
    const precedence = getSessionDefaultPrecedence(entry.level);

    for (const key of SESSION_DEFAULT_KEYS) {
      const value = sessionDefaults[key];
      if (value === undefined) continue;

      const currentWinner = winners[key];
      if (!currentWinner || precedence < currentWinner.precedence) {
        winners[key] = {
          level: entry.level,
          precedence,
          label,
          folderPath: entry.folderPath,
        };
        setResolvedSessionDefault(resolved, key, value);
      }
    }
  }

  return {
    sessionDefaultSettings:
      Object.keys(resolved).length > 0
        ? (resolved as SessionDefaultSettings)
        : undefined,
    winners,
  };
}

function resolveSessionDefaultSettings(
  levels: HierarchyLevelWithAttribution[]
): SessionDefaultSettings | undefined {
  return resolveSessionDefaultSettingsInternal(levels).sessionDefaultSettings;
}

/**
 * When the org sets `allowManagedHooksOnly`, only Org-level hooks survive:
 * managed settings and org-enabled plugins. User/project hooks (including from
 * locally enabled plugins) are dropped so members cannot reintroduce hooks.
 */
function applyManagedHooksOnly(
  levels: HierarchyLevelWithAttribution[]
): HierarchyLevelWithAttribution[] {
  const enabled = levels.some(
    (level) =>
      level.level === SettingsLevel.Org &&
      level.settings.general?.allowManagedHooksOnly === true
  );
  if (!enabled) return levels;

  return levels.map((level) => {
    if (
      level.level === SettingsLevel.Org ||
      level.settings.hooks === undefined
    ) {
      return level;
    }
    const { hooks: _dropped, ...settingsWithoutHooks } = level.settings;
    return { ...level, settings: settingsWithoutHooks };
  });
}

export function mergeHierarchyWithSessionDefaults(
  levels: HierarchyLevelWithAttribution[]
): Settings {
  const effectiveLevels = applyManagedHooksOnly(levels);
  const merged = mergeHierarchy(effectiveLevels.map((level) => level.settings));
  const sessionDefaultSettings = resolveSessionDefaultSettings(levels);

  if (!sessionDefaultSettings) {
    return merged;
  }

  return {
    ...merged,
    general: {
      ...(merged.general ?? {}),
      sessionDefaultSettings,
    },
  };
}

/**
 * Merge settings hierarchy and produce a resolution chain tracking how
 * session default settings were resolved. The chain records which level
 * set or was skipped for each session default key.
 */
export function mergeHierarchyWithChain(
  levels: HierarchyLevelWithAttribution[]
): MergeHierarchyWithChainResult {
  const chain: SettingsResolutionEvent[] = [];
  const resolvedBy: Partial<
    Record<keyof SessionDefaultSettings, SessionDefaultWinner>
  > = {};

  // Walk levels in hierarchy order while applying dedicated session-default
  // precedence. Lower config levels may override org defaults for these keys.
  for (const entry of levels) {
    const displayLabel = entry.label ?? settingsLevelToSourceType(entry.level);
    const sessionDefaults = entry.settings.general?.sessionDefaultSettings;

    if (!sessionDefaults) {
      chain.push(
        createResolutionEvent('hierarchy-skip-no-defaults', {
          keys: [],
          action: 'skip',
          source: {
            type: settingsLevelToSourceType(entry.level),
            filePath: entry.folderPath,
          },
          reason: `${displayLabel} — checked, no sessionDefaultSettings found`,
        })
      );
      continue;
    }

    const setKeys: string[] = [];
    const setValues: Record<string, unknown> = {};
    const overrideKeys: string[] = [];
    const overrideValues: Record<string, unknown> = {};
    const overriddenSources = new Set<string>();
    const skipKeys: string[] = [];
    const skippedSources = new Set<string>();
    const precedence = getSessionDefaultPrecedence(entry.level);

    for (const key of SESSION_DEFAULT_KEYS) {
      const value = sessionDefaults[key];
      if (value === undefined) continue;

      const currentWinner = resolvedBy[key];
      if (!currentWinner) {
        resolvedBy[key] = {
          level: entry.level,
          precedence,
          label: displayLabel,
          folderPath: entry.folderPath,
        };
        setKeys.push(key);
        setValues[key] = value;
      } else if (precedence < currentWinner.precedence) {
        resolvedBy[key] = {
          level: entry.level,
          precedence,
          label: displayLabel,
          folderPath: entry.folderPath,
        };
        overrideKeys.push(key);
        overrideValues[key] = value;
        overriddenSources.add(currentWinner.label);
      } else {
        skipKeys.push(key);
        skippedSources.add(currentWinner.label);
      }
    }

    if (setKeys.length > 0) {
      chain.push(
        createResolutionEvent('hierarchy-set', {
          keys: setKeys,
          action: 'set',
          source: {
            type: settingsLevelToSourceType(entry.level),
            filePath: entry.folderPath,
          },
          value: setValues,
          reason: displayLabel,
        })
      );
    }

    if (overrideKeys.length > 0) {
      chain.push(
        createResolutionEvent('hierarchy-override-session-defaults', {
          keys: overrideKeys,
          action: 'override',
          source: {
            type: settingsLevelToSourceType(entry.level),
            filePath: entry.folderPath,
          },
          value: overrideValues,
          reason: `${displayLabel} — overrides ${[...overriddenSources].join(', ')}`,
        })
      );
    }

    if (skipKeys.length > 0) {
      chain.push(
        createResolutionEvent('hierarchy-skip-lower-priority', {
          keys: skipKeys,
          action: 'skip',
          source: {
            type: settingsLevelToSourceType(entry.level),
            filePath: entry.folderPath,
          },
          reason: `${displayLabel} — ignored, overridden by higher-precedence source: ${[...skippedSources].join(', ')}`,
        })
      );
    }
  }

  const settings = mergeHierarchyWithSessionDefaults(levels);
  return { settings, resolutionChain: chain };
}

export function transformManagedSettingsToSettings(
  managed: ManagedSettings
): Settings {
  const hasFields = Object.keys(managed).length > 0;
  if (!hasFields) return {};

  const general = { ...managed } as GeneralSettings;
  if (Array.isArray(general.customModels)) {
    general.customModels = IndustrySettingsFolder.parseCustomModelsFromSettings(
      general.customModels
    );
  }

  // Lift hooks to top-level Settings.hooks where consumers read them.
  const hooks = general.hooks;
  delete general.hooks;

  return hooks !== undefined ? { general, hooks } : { general };
}
