import fs from 'fs';
import path from 'path';

import { EnvironmentVariable } from '@industry/environment';
import { MetaError } from '@industry/logging/errors';
import { expandTilde } from '@industry/utils/shell/node';

export function getRuntimeSettingsPathFromEnv(): string | null {
  const value =
    process.env[EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH]?.trim();
  return value || null;
}

export async function resolveRuntimeSettingsPath(
  rawPath: string
): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new MetaError('Invalid runtime settings path: value cannot be empty');
  }

  const expanded = expandTilde(trimmed);
  const resolvedPath = path.resolve(expanded);

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new MetaError('Runtime settings file not found', {
        path: resolvedPath,
      });
    }
    throw new MetaError('Failed to access runtime settings file', {
      path: resolvedPath,
      cause: error,
    });
  }

  if (!stats.isFile()) {
    throw new MetaError('Runtime settings path must point to a file', {
      path: resolvedPath,
    });
  }

  try {
    await fs.promises.access(resolvedPath, fs.constants.R_OK);
  } catch (error) {
    throw new MetaError('Runtime settings file is not readable', {
      path: resolvedPath,
      cause: error,
    });
  }

  return resolvedPath;
}
