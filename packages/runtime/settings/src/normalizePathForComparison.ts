import * as path from 'path';

import type { PathCompareOptions } from './types';

export function getPathModule(
  platform: NodeJS.Platform
): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function stripTrailingSeparators(
  resolvedPath: string,
  platform: NodeJS.Platform
): string {
  const pathMod = getPathModule(platform);
  const root = pathMod.parse(resolvedPath).root;

  // Do not strip the root path trailing separator (e.g. "C:\\" or "/")
  if (resolvedPath === root) return resolvedPath;

  return resolvedPath.replace(/[\\/]+$/, '');
}

export function normalizePathForComparison(
  inputPath: string,
  options: PathCompareOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  const pathMod = getPathModule(platform);

  let resolved = pathMod.resolve(inputPath);
  resolved = stripTrailingSeparators(resolved, platform);

  // Windows paths are case-insensitive, so normalize casing for comparisons.
  if (platform === 'win32') {
    resolved = resolved.toLowerCase();
  }

  return resolved;
}
