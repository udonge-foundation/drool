import { promises as fs } from 'fs';
import path from 'path';

import { parse, type ParseError } from 'jsonc-parser';

import { EnvironmentVariable } from '@industry/environment';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { mergeSandboxSettings } from '@industry/utils/settings';

import { extractRuntimeSettingsPathArg } from '@/utils/runtimeSettingsArgs';
import { resolveRuntimeSettingsPath } from '@/utils/runtimeSettingsBootstrap';

import type { SandboxSettings } from '@industry/common/settings';

const SETTINGS_FILE_NAMES = ['settings.json', 'settings.local.json'] as const;

interface BootstrapSettingsOptions {
  argv?: string[];
  cwd?: string;
  industryHome?: string;
  runtimeSettingsPathInput?: string;
}

function parseSandboxSettingsFile(
  content: string,
  settingsPath: string
): SandboxSettings | undefined {
  const errors: ParseError[] = [];
  const parsed = parse(content, errors);
  if (errors.length > 0) {
    logWarn('[whole-process-sandbox] Ignoring malformed settings file', {
      path: settingsPath,
    });
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as {
    general?: { sandbox?: SandboxSettings };
    sandbox?: SandboxSettings;
  };

  return record.sandbox ?? record.general?.sandbox;
}

async function loadSandboxSettingsFile(
  settingsPath: string,
  { required }: { required: boolean }
): Promise<SandboxSettings | undefined> {
  let content: string;
  try {
    content = await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!required && code === 'ENOENT') {
      return undefined;
    }
    throw new MetaError('Failed to read sandbox settings file', {
      path: settingsPath,
      cause: error,
    });
  }

  return parseSandboxSettingsFile(content, settingsPath);
}

async function loadSandboxSettingsFolder(
  folderPath: string
): Promise<SandboxSettings | undefined> {
  let sandboxSettings: SandboxSettings | undefined;

  for (const fileName of SETTINGS_FILE_NAMES) {
    const fileSettings = await loadSandboxSettingsFile(
      path.join(folderPath, fileName),
      { required: false }
    );
    if (fileSettings !== undefined) {
      sandboxSettings = fileSettings;
    }
  }

  return sandboxSettings;
}

function getAncestorIndustryFolders(cwd: string): string[] {
  const folders: string[] = [];
  let current = path.resolve(cwd);

  for (;;) {
    folders.push(path.join(current, getIndustryDirName()));
    const parent = path.dirname(current);
    if (parent === current) {
      return folders.reverse();
    }
    current = parent;
  }
}

/**
 * Resolve the sandbox settings that are safe to inspect before command
 * entrypoints load. This intentionally uses only local settings files and the
 * explicit runtime settings overlay; remote org/dynamic settings cannot be
 * fetched before the whole-process sandbox is active.
 */
export async function loadWholeProcessSandboxBootstrapSettings(
  options: BootstrapSettingsOptions = {}
): Promise<SandboxSettings | undefined> {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const industryHome = options.industryHome ?? getIndustryHome();
  const runtimeSettingsPathInput =
    options.runtimeSettingsPathInput ??
    extractRuntimeSettingsPathArg(argv).runtimeSettingsPathArg ??
    process.env[EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH];

  const localFolders = [
    path.join(industryHome, getIndustryDirName()),
    ...getAncestorIndustryFolders(cwd),
  ];

  const seenFolders = new Set<string>();
  let sandboxSettings: SandboxSettings | undefined;

  for (const folder of localFolders) {
    const resolvedFolder = path.resolve(folder);
    if (seenFolders.has(resolvedFolder)) {
      continue;
    }
    seenFolders.add(resolvedFolder);

    const folderSettings = await loadSandboxSettingsFolder(resolvedFolder);
    sandboxSettings = mergeSandboxSettings(folderSettings, sandboxSettings);
  }

  if (runtimeSettingsPathInput?.trim()) {
    const resolvedRuntimeSettingsPath = await resolveRuntimeSettingsPath(
      runtimeSettingsPathInput
    );
    process.env[EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH] =
      resolvedRuntimeSettingsPath;

    const runtimeSandboxSettings = await loadSandboxSettingsFile(
      resolvedRuntimeSettingsPath,
      { required: true }
    );
    sandboxSettings = mergeSandboxSettings(
      runtimeSandboxSettings,
      sandboxSettings
    );
  }

  return sandboxSettings;
}
