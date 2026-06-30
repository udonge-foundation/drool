import * as fs from 'fs';
import * as path from 'path';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import {
  GeneralSettingsSchema,
  ManagedSettingsSchema,
  McpConfigSchema,
} from '@industry/common/settings';
import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException } from '@industry/logging';
import {
  getRuntimeSettingsDiagnosticFailure,
  SETTINGS_FILE_NAME,
  SETTINGS_LOCAL_FILE_NAME,
  SettingsManager,
} from '@industry/runtime/settings';

import { DiagnosticFailureType } from '@/services/diagnostics/enums';
import { getRuntimeSettingsStartupFailure } from '@/services/diagnostics/RuntimeSettingsFailureStore';
import type { DiagnosticFailure } from '@/services/diagnostics/types';
import { formatJsoncParseError } from '@/services/mcp/mcpConfigDiagnostics';

async function fileExists(filePath: string): Promise<boolean> {
  return fs.promises.stat(filePath).then(
    (stats) => stats.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
}

async function checkSettingsFile(
  folderPath: string,
  fileName: string,
  scope: string
): Promise<DiagnosticFailure[]> {
  const filePath = path.join(folderPath, fileName);
  if (!(await fileExists(filePath))) return [];

  const content = await fs.promises.readFile(filePath, 'utf-8');
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors);

  if (errors.length > 0) {
    return [
      {
        type: DiagnosticFailureType.SettingsParse,
        scope,
        path: filePath,
        message: formatJsoncParseError(content, errors),
      },
    ];
  }

  // JSONC is valid -- run Zod schema validation
  const result = GeneralSettingsSchema.safeParse(parsed);
  if (!result.success) {
    return result.error.issues.map((issue) => ({
      type: DiagnosticFailureType.SettingsParse,
      scope,
      path: filePath,
      message:
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
    }));
  }

  return [];
}

async function collectSettingsParseFailures(): Promise<DiagnosticFailure[]> {
  try {
    const manager = SettingsManager.getInstance();
    const hierarchy = await manager.getSettingsHierarchyWithAttribution();

    const seenPaths = new Set<string>();
    const checks: Array<Promise<DiagnosticFailure[]>> = [];

    for (const entry of hierarchy) {
      let folderPath: string | undefined;

      if (entry.folderPath) {
        folderPath = entry.folderPath;
      } else if (entry.level === SettingsLevel.User) {
        folderPath = manager.getUserPath();
      } else if (entry.level === SettingsLevel.Project) {
        folderPath = manager.getProjectPath() ?? undefined;
      } else {
        continue;
      }

      if (!folderPath) continue;

      for (const fileName of [SETTINGS_FILE_NAME, SETTINGS_LOCAL_FILE_NAME]) {
        const filePath = path.join(folderPath, fileName);
        if (seenPaths.has(filePath)) continue;
        seenPaths.add(filePath);

        checks.push(checkSettingsFile(folderPath, fileName, entry.level));
      }
    }

    const results = await Promise.all(checks);
    return results.flat();
  } catch (error) {
    logException(error, '[Diagnostics] Failed to check settings files');
    return [];
  }
}

async function checkMcpConfigFile(
  folderPath: string,
  scope: string
): Promise<DiagnosticFailure[]> {
  const filePath = path.join(folderPath, 'mcp.json');
  if (!(await fileExists(filePath))) return [];

  const content = await fs.promises.readFile(filePath, 'utf-8');
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors);

  if (errors.length > 0) {
    return [
      {
        type: DiagnosticFailureType.McpParse,
        scope,
        path: filePath,
        message: formatJsoncParseError(content, errors),
      },
    ];
  }

  const result = McpConfigSchema.safeParse(parsed);
  if (!result.success) {
    return result.error.issues.map((issue) => ({
      type: DiagnosticFailureType.McpParse,
      scope,
      path: filePath,
      message:
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
    }));
  }

  return [];
}

async function collectMcpParseFailures(): Promise<DiagnosticFailure[]> {
  try {
    const manager = SettingsManager.getInstance();
    const checks: Array<Promise<DiagnosticFailure[]>> = [];
    const seenPaths = new Set<string>();

    const addCheck = (folderPath: string | null | undefined, scope: string) => {
      if (!folderPath) return;
      const filePath = path.join(folderPath, 'mcp.json');
      if (seenPaths.has(filePath)) return;
      seenPaths.add(filePath);
      checks.push(checkMcpConfigFile(folderPath, scope));
    };

    addCheck(manager.getUserPath(), SettingsLevel.User);
    addCheck(manager.getProjectPath(), SettingsLevel.Project);

    const results = await Promise.all(checks);
    return results.flat();
  } catch (error) {
    logException(error, '[Diagnostics] Failed to check mcp.json');
    return [];
  }
}

async function collectOrgOverrideFailures(): Promise<DiagnosticFailure[]> {
  const failures: DiagnosticFailure[] = [];
  const localPath = process.env.INDUSTRY_ORG_MANAGED_SETTINGS_LOCAL_PATH;

  if (!localPath) return failures;

  try {
    if (!(await fileExists(localPath))) {
      failures.push({
        type: DiagnosticFailureType.OrgOverride,
        scope: 'org',
        path: localPath,
        message: 'File not found',
      });
      return failures;
    }

    const content = await fs.promises.readFile(localPath, 'utf-8');
    const parseErrors: ParseError[] = [];
    const parsed = parseJsonc(content, parseErrors);

    if (parseErrors.length > 0) {
      failures.push({
        type: DiagnosticFailureType.OrgOverride,
        scope: 'org',
        path: localPath,
        message: formatJsoncParseError(content, parseErrors),
      });
      return failures;
    }

    const validated = ManagedSettingsSchema.safeParse(parsed);
    if (!validated.success) {
      for (const issue of validated.error.issues) {
        failures.push({
          type: DiagnosticFailureType.OrgOverride,
          scope: 'org',
          path: localPath,
          message:
            issue.path.length > 0
              ? `${issue.path.join('.')}: ${issue.message}`
              : issue.message,
        });
      }
    }
  } catch (error) {
    logException(error, '[Diagnostics] Failed to check org override');
  }

  return failures;
}

async function collectRuntimeSettingsFailures(): Promise<DiagnosticFailure[]> {
  const failures: DiagnosticFailure[] = [];

  const startupFailure = getRuntimeSettingsStartupFailure();
  if (startupFailure) {
    failures.push(startupFailure);
  }

  try {
    const runtimeFailure = await getRuntimeSettingsDiagnosticFailure();

    if (runtimeFailure) {
      failures.push({
        type: DiagnosticFailureType.RuntimeSettings,
        scope: 'runtime',
        path: runtimeFailure.path,
        message: runtimeFailure.message,
      });
    }
  } catch (error) {
    logException(error, '[Diagnostics] Failed to check runtime settings');
  }

  return failures;
}

export async function collectDiagnostics(): Promise<DiagnosticFailure[]> {
  const [settings, mcp, org, runtime] = await Promise.all([
    collectSettingsParseFailures(),
    collectMcpParseFailures(),
    collectOrgOverrideFailures(),
    collectRuntimeSettingsFailures(),
  ]);

  return [...settings, ...mcp, ...org, ...runtime];
}
