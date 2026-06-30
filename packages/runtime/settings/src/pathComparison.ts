import {
  getPathModule,
  normalizePathForComparison,
} from './normalizePathForComparison';

import type { PathCompareOptions } from './types';

export function arePathsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
  options: PathCompareOptions = {}
): boolean {
  if (a == null || b == null) return a === b;
  return (
    normalizePathForComparison(a, options) ===
    normalizePathForComparison(b, options)
  );
}

export function isPathEqualOrDescendant(
  candidatePath: string,
  ancestorPath: string,
  options: PathCompareOptions = {}
): boolean {
  const platform = options.platform ?? process.platform;
  const pathMod = getPathModule(platform);

  const candidate = normalizePathForComparison(candidatePath, options);
  const ancestor = normalizePathForComparison(ancestorPath, options);

  if (candidate === ancestor) return true;

  // Special-case root ancestors (e.g. "C:\\" or "/") so we don't accidentally
  // generate a double-separator prefix.
  const isRootAncestor = pathMod.parse(ancestor).root === ancestor;

  const prefix = isRootAncestor
    ? ancestor
    : ancestor.endsWith(pathMod.sep)
      ? ancestor
      : ancestor + pathMod.sep;
  return candidate.startsWith(prefix);
}
