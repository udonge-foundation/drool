/**
 * Single source of truth for "what shell is the user actually in?"
 *
 * The Execute tool description and the system reminder both consume this
 * to deliver platform-correct guidance to the model. Adding new runtimes
 * here is the only entry point that needs editing — getExecuteCliDescription
 * and renderShellHint switch on RuntimeShell.kind.
 */

import { ExecuteCliRuntimeShell } from '@industry/drool-core/tools/definitions/cli/enums';

import { getWslVariant, isWsl } from '@/utils/isWsl';
import type { RuntimeShell } from '@/utils/types';
import { resolveWindowsPowerShellExecutableSync } from '@/utils/windowsShell';

let cachedRuntimeShell: RuntimeShell | undefined;

function detectRuntimeShell(): RuntimeShell {
  if (process.platform === 'win32') {
    try {
      const executable = resolveWindowsPowerShellExecutableSync();
      if (executable === 'pwsh.exe') {
        return { kind: ExecuteCliRuntimeShell.PowerShell7, executable };
      }
      return { kind: ExecuteCliRuntimeShell.PowerShell5, executable };
    } catch {
      // No PowerShell on PATH at all. Execute will hard-fail anyway,
      // but report unknown so prompts don't lie about what's available.
      return { kind: ExecuteCliRuntimeShell.Unknown };
    }
  }

  if (process.platform === 'linux') {
    if (isWsl()) {
      const variant = getWslVariant() ?? 'WSL2';
      const distro = process.env.WSL_DISTRO_NAME || undefined;
      return { kind: ExecuteCliRuntimeShell.WslBash, variant, distro };
    }
    return { kind: ExecuteCliRuntimeShell.Posix };
  }

  if (process.platform === 'darwin') {
    return { kind: ExecuteCliRuntimeShell.Posix };
  }

  return { kind: ExecuteCliRuntimeShell.Unknown };
}

/**
 * Return the detected runtime shell. Cached after first call.
 */
export function getRuntimeShell(): RuntimeShell {
  if (cachedRuntimeShell) {
    return cachedRuntimeShell;
  }
  cachedRuntimeShell = detectRuntimeShell();
  return cachedRuntimeShell;
}

/**
 * Test-only helper to reset the runtime shell cache.
 */
export function _resetRuntimeShellCacheForTests(): void {
  cachedRuntimeShell = undefined;
}
