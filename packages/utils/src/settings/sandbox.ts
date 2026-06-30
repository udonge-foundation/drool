/**
 * Sandbox settings utilities: merge helpers.
 *
 * Implements the hierarchy merge semantics defined in Section 9.4 of the
 * sandbox design doc. Core principle: lower-priority levels may only
 * tighten the sandbox, never loosen it.
 *
 * Path resolution functions that require Node.js modules (os, path) are in
 * sandbox-paths.ts to avoid breaking browser bundles (Vite).
 */
import {
  intersectDomainArrays,
  intersectPathArrays,
  mergeCapabilityBoolean,
  pickStrictestMode,
  unionMergeArrays,
} from './merge-utils';

import type {
  SandboxFilesystemSettings,
  SandboxSettings,
} from '@industry/common/settings';

// =============================================================================
// Sandbox Settings Merge (Section 9.4 hierarchy semantics)
// =============================================================================

/**
 * Merge two SandboxFilesystemSettings across hierarchy levels.
 *
 * Both levels are known to be participating (enabled: true).
 *
 * Capability fields (allowWrite): semantic intersection — lower levels
 * may narrow the set, but must never add paths a higher level did not allow.
 * Omitted at a participating level = [] (restrictive default).
 *
 * Restriction fields (denyWrite, denyRead): union merge — restrictions
 * are additive across all levels.
 */
function mergeFilesystemParticipating(
  higher: SandboxFilesystemSettings | undefined,
  lower: SandboxFilesystemSettings | undefined
): SandboxFilesystemSettings | undefined {
  const allowWrite = intersectPathArrays(
    higher?.allowWrite ?? [],
    lower?.allowWrite ?? []
  );
  const allowRead = intersectPathArrays(
    higher?.allowRead ?? [],
    lower?.allowRead ?? []
  );
  const denyWrite = unionMergeArrays(higher?.denyWrite, lower?.denyWrite);
  const denyRead = unionMergeArrays(higher?.denyRead, lower?.denyRead);

  if (
    !allowWrite?.length &&
    !allowRead?.length &&
    !denyWrite?.length &&
    !denyRead?.length
  ) {
    return undefined;
  }

  return {
    allowWrite: allowWrite?.length ? allowWrite : undefined,
    allowRead: allowRead?.length ? allowRead : undefined,
    denyWrite,
    denyRead,
  };
}

/**
 * Derive the effective Unix socket allow-set for a single level.
 *
 * allowAllUnixSockets: true => 'all'
 * Otherwise => the explicit allowUnixSockets list (default [])
 */
function deriveSocketSet(
  network: SandboxSettings['network'] | undefined
): 'all' | string[] {
  if (network?.allowAllUnixSockets === true) return 'all';
  return network?.allowUnixSockets ?? [];
}

/**
 * Intersect two Unix socket allow-sets.
 */
function intersectSocketSets(
  a: 'all' | string[],
  b: 'all' | string[]
): { allowAllUnixSockets?: boolean; allowUnixSockets?: string[] } {
  if (a === 'all') {
    if (b === 'all') return { allowAllUnixSockets: true };
    return b.length ? { allowUnixSockets: b } : {};
  }
  if (b === 'all') {
    return a.length ? { allowUnixSockets: a } : {};
  }
  // Both are explicit lists — set intersection
  const intersection = a.filter((s) => b.includes(s));
  return intersection.length ? { allowUnixSockets: intersection } : {};
}

/**
 * Merge two SandboxNetworkSettings across hierarchy levels.
 *
 * Both levels are known to be participating (enabled: true).
 *
 * Capability fields (allowedDomains, unix sockets): semantic intersection.
 * Omitted at a participating level = [] / false (restrictive default).
 *
 * allowLocalBinding: false beats true (capability boolean).
 * httpProxyPort/socksProxyPort: highest participating level wins.
 */
function mergeNetworkParticipating(
  higher: SandboxSettings['network'],
  lower: SandboxSettings['network']
): SandboxSettings['network'] {
  const allowedDomains = intersectDomainArrays(
    higher?.allowedDomains ?? [],
    lower?.allowedDomains ?? []
  );

  const socketResult = intersectSocketSets(
    deriveSocketSet(higher),
    deriveSocketSet(lower)
  );

  const allowLocalBinding = mergeCapabilityBoolean(
    higher?.allowLocalBinding ?? false,
    lower?.allowLocalBinding ?? false
  );

  // Control-plane selectors: highest participating level wins
  const httpProxyPort = higher?.httpProxyPort ?? lower?.httpProxyPort;
  const socksProxyPort = higher?.socksProxyPort ?? lower?.socksProxyPort;

  const result: SandboxSettings['network'] = {};
  if (allowedDomains?.length) result.allowedDomains = allowedDomains;
  if (socketResult.allowAllUnixSockets !== undefined)
    result.allowAllUnixSockets = socketResult.allowAllUnixSockets;
  if (socketResult.allowUnixSockets !== undefined)
    result.allowUnixSockets = socketResult.allowUnixSockets;
  if (allowLocalBinding !== undefined)
    result.allowLocalBinding = allowLocalBinding;
  if (httpProxyPort !== undefined) result.httpProxyPort = httpProxyPort;
  if (socksProxyPort !== undefined) result.socksProxyPort = socksProxyPort;

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Merge two SandboxSettings across hierarchy levels.
 *
 * Implements Section 9.4 of the sandbox design doc:
 *
 * - enabled: true wins (OR) — enabling is always stricter
 * - mode: strictest wins (whole-process > per-command)
 * - Participation: only levels with enabled: true contribute policy.
 *   Omitted capability fields at a participating level = restrictive default.
 * - Capability arrays (allowWrite, allowedDomains, unix sockets):
 *   semantic intersection across participating levels
 * - Restriction arrays (denyWrite, denyRead): union across participating levels
 * - Capability booleans (allowLocalBinding): false beats true
 * - Control-plane (httpProxyPort, socksProxyPort): highest participating wins
 */
export function mergeSandboxSettings(
  higher: SandboxSettings | undefined,
  lower: SandboxSettings | undefined
): SandboxSettings | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  // enabled: true wins (OR across levels)
  const enabled =
    higher.enabled === true || lower.enabled === true
      ? true
      : (higher.enabled ?? lower.enabled);

  // mode: strictest wins
  const mode = pickStrictestMode(higher.mode, lower.mode);

  // Participation: only levels with enabled: true contribute to other fields
  const higherParticipates = higher.enabled === true;
  const lowerParticipates = lower.enabled === true;

  let filesystem: SandboxFilesystemSettings | undefined;
  let network: SandboxSettings['network'];

  if (higherParticipates && lowerParticipates) {
    // Both participate: apply full merge rules
    filesystem = mergeFilesystemParticipating(
      higher.filesystem,
      lower.filesystem
    );
    network = mergeNetworkParticipating(higher.network, lower.network);
  } else if (higherParticipates) {
    // Only higher participates: its policy stands, lower delegates
    filesystem = higher.filesystem;
    network = higher.network;
  } else if (lowerParticipates) {
    // Only lower participates: its policy stands, higher delegates
    filesystem = lower.filesystem;
    network = lower.network;
  } else {
    // Neither participates: carry settings through for potential lower levels
    // Use simple first-defined-wins for pass-through
    filesystem = higher.filesystem ?? lower.filesystem;
    network = higher.network ?? lower.network;
  }

  const result: SandboxSettings = {};
  if (enabled !== undefined) result.enabled = enabled;
  if (mode !== undefined) result.mode = mode;
  if (filesystem !== undefined) result.filesystem = filesystem;
  if (network !== undefined) result.network = network;

  return Object.keys(result).length > 0 ? result : undefined;
}

// =============================================================================
// Same-Level Patch Merge
// =============================================================================

/**
 * Merge a sandbox settings patch into current settings at the SAME level.
 *
 * Unlike the cross-hierarchy merge above, this does NOT apply ceiling semantics.
 * Arrays explicitly present in the patch replace the current value at that leaf.
 * Omitted branches are preserved.
 */
export function mergeSandboxLevelUpdate(
  current: SandboxSettings | undefined,
  patch: SandboxSettings | undefined
): SandboxSettings | undefined {
  if (!patch) return current;
  if (!current) return patch;

  const mergedFs =
    patch.filesystem !== undefined
      ? {
          allowWrite:
            patch.filesystem.allowWrite ?? current.filesystem?.allowWrite,
          allowRead:
            patch.filesystem.allowRead ?? current.filesystem?.allowRead,
          denyWrite:
            patch.filesystem.denyWrite ?? current.filesystem?.denyWrite,
          denyRead: patch.filesystem.denyRead ?? current.filesystem?.denyRead,
        }
      : current.filesystem;

  const mergedNet =
    patch.network !== undefined
      ? {
          allowedDomains:
            patch.network.allowedDomains ?? current.network?.allowedDomains,
          allowUnixSockets:
            patch.network.allowUnixSockets ?? current.network?.allowUnixSockets,
          allowAllUnixSockets:
            patch.network.allowAllUnixSockets ??
            current.network?.allowAllUnixSockets,
          allowLocalBinding:
            patch.network.allowLocalBinding ??
            current.network?.allowLocalBinding,
          httpProxyPort:
            patch.network.httpProxyPort ?? current.network?.httpProxyPort,
          socksProxyPort:
            patch.network.socksProxyPort ?? current.network?.socksProxyPort,
        }
      : current.network;

  return {
    enabled: patch.enabled ?? current.enabled,
    mode: patch.mode ?? current.mode,
    filesystem: mergedFs,
    network: mergedNet,
  };
}
