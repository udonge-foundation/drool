/**
 * Generic utilities shared by settings merge logic.
 */

import type { SandboxMode } from '@industry/drool-sdk-ext/protocol/settings';

/**
 * Union-merge two arrays, deduplicating entries.
 */
export function unionMergeArrays<T>(
  higher: T[] | undefined,
  lower: T[] | undefined
): T[] | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  const combined = [...higher];
  for (const item of lower) {
    if (!combined.includes(item)) {
      combined.push(item);
    }
  }
  return combined;
}

/**
 * Match a domain against a pattern with wildcard support.
 * Extracted from DroolSandboxManager for use in merge logic.
 *
 * - 'example.com' — exact match
 * - '*.example.com' — matches any subdomain (NOT example.com itself)
 */
export function domainMatchesPattern(domain: string, pattern: string): boolean {
  const lowerDomain = domain.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  if (lowerPattern.startsWith('*.')) {
    const suffix = lowerPattern.slice(1); // '.example.com'
    return lowerDomain.endsWith(suffix) && lowerDomain !== suffix.slice(1);
  }

  return lowerDomain === lowerPattern;
}

/**
 * Check if a path is under an entry (exact match or subtree).
 * Works on raw paths (~/..., /..., ./...) without Node.js path resolution.
 */
function normalizeParentPath(parent: string): string {
  if (parent === '/') return parent;
  return parent.endsWith('/') ? parent.slice(0, -1) : parent;
}

function isPathContainedBy(child: string, parent: string): boolean {
  const normalizedParent = normalizeParentPath(parent);

  if (normalizedParent === '/') {
    return child.startsWith('/');
  }

  return child === normalizedParent || child.startsWith(`${normalizedParent}/`);
}

/**
 * Semantic intersection of two path arrays.
 * Keeps only paths allowed by both inputs, preferring the narrower match.
 */
export function intersectPathArrays(
  a: string[] | undefined,
  b: string[] | undefined
): string[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;

  const result: string[] = [];

  for (const pA of a) {
    for (const pB of b) {
      if (pA === pB) {
        if (!result.includes(pA)) result.push(pA);
      } else if (isPathContainedBy(pB, pA)) {
        if (!result.includes(pB)) result.push(pB);
      } else if (isPathContainedBy(pA, pB)) {
        if (!result.includes(pA)) result.push(pA);
      }
    }
  }

  return result;
}

/**
 * Semantic intersection of two domain arrays.
 * Keeps only domains matched by both inputs, preferring the narrower match.
 */
export function intersectDomainArrays(
  a: string[] | undefined,
  b: string[] | undefined
): string[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;

  const result: string[] = [];

  for (const dA of a) {
    for (const dB of b) {
      const lA = dA.toLowerCase();
      const lB = dB.toLowerCase();

      if (lA === lB) {
        if (!result.includes(dA)) result.push(dA);
      } else if (domainMatchesPattern(dB, dA)) {
        if (!result.includes(dB)) result.push(dB);
      } else if (domainMatchesPattern(dA, dB)) {
        if (!result.includes(dA)) result.push(dA);
      }
    }
  }

  return result;
}

const MODE_STRICTNESS: Record<SandboxMode, number> = {
  'per-command': 0,
  'whole-process': 1,
};

/**
 * Pick the strictest sandbox mode from two candidates.
 * whole-process > per-command.
 */
export function pickStrictestMode(
  a: SandboxMode | undefined,
  b: SandboxMode | undefined
): SandboxMode | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return MODE_STRICTNESS[a] >= MODE_STRICTNESS[b] ? a : b;
}

/**
 * Merge a capability boolean across hierarchy levels.
 * false beats true; undefined delegates to the other side.
 */
export function mergeCapabilityBoolean(
  higher: boolean | undefined,
  lower: boolean | undefined
): boolean | undefined {
  if (higher === undefined && lower === undefined) return undefined;
  if (higher === undefined) return lower;
  if (lower === undefined) return higher;
  return higher && lower;
}
