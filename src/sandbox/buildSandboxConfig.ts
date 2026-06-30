/**
 * Helper to build a resolved SandboxConfig from SandboxSettings.
 * Resolves ~/-prefixed and other path prefixes to absolute paths.
 */

import { SandboxMode } from '@industry/drool-sdk-ext/protocol/settings';
import { resolveFilesystemPaths } from '@industry/utils/settings/sandbox-paths';

import type { SandboxConfig } from '@/sandbox/types';

import type { SandboxSettings } from '@industry/common/settings';

export function buildSandboxConfig(settings: SandboxSettings): SandboxConfig {
  const resolvedFilesystem = resolveFilesystemPaths(settings.filesystem);

  // The spec save directory is intentionally NOT added to the global
  // allow-write list: doing so would let a user-level `general.specSaveDir`
  // widen an org/folder allow-write ceiling and grant every write-capable
  // tool access to that path. ExitSpecMode enforces (and prompts for) its own
  // spec write target in its executor, keeping the exception local to it.
  const allowWrite = [...(resolvedFilesystem?.allowWrite ?? [])];

  return {
    enabled: settings.enabled ?? false,
    mode: settings.mode ?? SandboxMode.PerCommand,
    filesystem: {
      allowWrite,
      allowRead: resolvedFilesystem?.allowRead ?? [],
      denyWrite: resolvedFilesystem?.denyWrite ?? [],
      denyRead: resolvedFilesystem?.denyRead ?? [],
    },
    network: {
      allowedDomains: settings.network?.allowedDomains ?? [],
      allowUnixSockets: settings.network?.allowUnixSockets,
      allowAllUnixSockets: settings.network?.allowAllUnixSockets,
      allowLocalBinding: settings.network?.allowLocalBinding,
      httpProxyPort: settings.network?.httpProxyPort,
      socksProxyPort: settings.network?.socksProxyPort,
    },
  };
}
