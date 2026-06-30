import fs from 'fs';

import { HookSettingsSchema } from '@industry/common/settings';
import { EnvironmentVariable } from '@industry/environment';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getProcessEnvironmentVariable } from '@industry/utils/environment';

import {
  isObjectRecord,
  parseGeneralSettingsSection,
  parseJsoncObjectFile,
  parseMcpSettingsSection,
  warnOnUnknownHookEventKeys,
} from './SettingsParsing';

import type { Settings } from '@industry/common/settings';

const STRUCTURED_SETTINGS_KEYS = new Set([
  'mcp',
  'hooks',
  'drools',
  'skills',
  'commands',
]);

function parseSectionSettings(
  raw: Record<string, unknown>,
  settingsPath: string
): Settings {
  const settings: Settings = {};

  if (raw.hooks !== undefined) {
    warnOnUnknownHookEventKeys(raw.hooks, { path: settingsPath });
    const result = HookSettingsSchema.safeParse(raw.hooks);
    if (!result.success) {
      throw new MetaError(
        'Invalid runtime settings: "hooks" failed validation',
        { path: settingsPath }
      );
    }
    settings.hooks = result.data;
  }

  if (raw.mcp !== undefined) {
    if (!isObjectRecord(raw.mcp)) {
      throw new MetaError('Invalid runtime settings: "mcp" must be an object', {
        path: settingsPath,
      });
    }
    settings.mcp = parseMcpSettingsSection(raw.mcp, settingsPath);
  }

  if (raw.drools !== undefined) {
    if (!isObjectRecord(raw.drools)) {
      throw new MetaError(
        'Invalid runtime settings: "drools" must be an object',
        {
          path: settingsPath,
        }
      );
    }
    settings.drools = raw.drools as Settings['drools'];
  }

  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) {
      throw new MetaError(
        'Invalid runtime settings: "skills" must be an array',
        {
          path: settingsPath,
        }
      );
    }
    settings.skills = raw.skills as Settings['skills'];
  }

  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands)) {
      throw new MetaError(
        'Invalid runtime settings: "commands" must be an array',
        {
          path: settingsPath,
        }
      );
    }
    settings.commands = raw.commands as Settings['commands'];
  }

  return settings;
}

function parseRuntimeSettings(raw: unknown, settingsPath: string): Settings {
  if (!isObjectRecord(raw)) {
    throw new MetaError(
      'Invalid runtime settings: file must contain a JSON object',
      { path: settingsPath }
    );
  }

  if (raw.general !== undefined) {
    throw new MetaError(
      'Invalid runtime settings: put general settings at the root like settings.json; the "general" wrapper is not supported',
      { path: settingsPath }
    );
  }

  const settings = parseSectionSettings(raw, settingsPath);
  const generalEntries = Object.entries(raw).filter(
    ([key]) => !STRUCTURED_SETTINGS_KEYS.has(key)
  );

  if (generalEntries.length > 0) {
    settings.general = parseGeneralSettingsSection(
      Object.fromEntries(generalEntries),
      settingsPath
    );
  }

  return settings;
}

export function getRuntimeSettingsPathFromEnv(): string | null {
  const value = getProcessEnvironmentVariable(
    EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH
  )?.trim();
  return value || null;
}

export async function loadRuntimeSettingsOverlay(
  settingsPath: string
): Promise<Settings> {
  let content: string;
  try {
    content = await fs.promises.readFile(settingsPath, 'utf-8');
  } catch (error) {
    throw new MetaError('Failed to read runtime settings file', {
      path: settingsPath,
      cause: error,
    });
  }

  const parsed = parseJsoncObjectFile(
    content,
    settingsPath,
    'Runtime settings'
  );

  return parseRuntimeSettings(parsed, settingsPath);
}

export async function getRuntimeSettingsDiagnosticFailure(): Promise<{
  path: string;
  message: string;
} | null> {
  const runtimeSettingsPath = getRuntimeSettingsPathFromEnv();
  if (!runtimeSettingsPath) {
    return null;
  }

  try {
    // Check file exists and is accessible before attempting to parse.
    await fs.promises.access(runtimeSettingsPath, fs.constants.R_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    logWarn('Failed to access runtime settings file', { cause: error });
    return {
      path: runtimeSettingsPath,
      message:
        code === 'ENOENT'
          ? 'Runtime settings file not found'
          : 'Failed to access runtime settings file',
    };
  }

  try {
    await loadRuntimeSettingsOverlay(runtimeSettingsPath);
    return null;
  } catch (error) {
    logWarn('Failed to load runtime settings overlay', { cause: error });
    return {
      path:
        error instanceof MetaError && typeof error.metadata?.path === 'string'
          ? error.metadata.path
          : runtimeSettingsPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
