/**
 * Terminal capability detection and logging.
 * Reports platform, terminal emulator, multiplexer, TTY mode, WSL, and derived features.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';

import { logInfo } from '@industry/logging';

import { isKittyProtocolEnabled } from '@/utils/kittyProtocolDetector';
import { getRuntimeShell } from '@/utils/runtimeShell';
import { getTerminalInfo } from '@/utils/terminalInfo';
import type { TerminalCapabilities } from '@/utils/types';

/**
 * Checks if the current process has admin/root privileges.
 */
function checkAdminPrivileges(): boolean {
  if (process.platform === 'win32') {
    // On Windows, check for elevated privileges via environment variable
    // or by attempting to access a privileged location
    return process.env.ADMIN === '1' || process.env.ELEVATED === 'true';
  }
  // On Unix-like systems, check if running as root (uid 0)
  return os.userInfo().uid === 0;
}

/**
 * Detects multiplexer by walking up the process tree.
 * This is useful when environment variables are not available (e.g., running with sudo).
 * Only works on Unix-like systems (macOS, Linux).
 */
function detectMultiplexerFromProcessTree(): 'tmux' | 'screen' | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }

  try {
    let currentPid = process.ppid;

    for (let i = 0; i < 10; i++) {
      if (!currentPid || currentPid <= 1) {
        break;
      }

      try {
        const result = spawnSync(
          'ps',
          ['-o', 'ppid=,command=', '-p', String(currentPid)],
          {
            encoding: 'utf8',
            timeout: 500,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        const psOutput = result.stdout?.trim() ?? '';
        if (!psOutput) break;

        const match = psOutput.match(/^\s*(\d+)\s+(.+)$/);
        if (!match) break;

        const parentPid = parseInt(match[1], 10);
        const command = match[2];

        // Check for tmux server process
        if (/tmux:\s*server|tmux\s+new|tmux\s+attach/i.test(command)) {
          return 'tmux';
        }
        // Check for screen
        if (/\bscreen\b/i.test(command)) {
          return 'screen';
        }

        currentPid = parentPid;
      } catch {
        break;
      }
    }
  } catch {
    // Silently fail - this is a best-effort fallback
  }

  return null;
}

/**
 * Detects terminal capabilities and environment details.
 */
async function detectTerminalCapabilities(): Promise<TerminalCapabilities> {
  const terminalInfo = getTerminalInfo();
  const isTTY = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const kittyProtocolEnabled = isKittyProtocolEnabled();

  // Detect multiplexer from env vars first, then fall back to process tree detection
  let multiplexer: 'tmux' | 'screen' | 'none' = 'none';
  if (process.env.TMUX) {
    multiplexer = 'tmux';
  } else if (process.env.STY) {
    multiplexer = 'screen';
  } else {
    // Fall back to process tree detection (e.g., when running with sudo)
    const fromProcessTree = detectMultiplexerFromProcessTree();
    if (fromProcessTree) {
      multiplexer = fromProcessTree;
    }
  }

  // Detect WSL environment and version, and read /proc/version on Linux
  let wsl: 'WSL1' | 'WSL2' | 'WSL' | null = null;
  let procVersion: string | null = null;
  if (process.platform === 'linux') {
    try {
      procVersion = (await fs.readFile('/proc/version', 'utf8')).trim();

      // Detect WSL from /proc/version or WSL_DISTRO_NAME env var
      const isWsl =
        !!process.env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(procVersion);
      if (isWsl) {
        // Determine WSL version from kernel version
        // WSL2 uses kernel 5.x+, WSL1 uses 4.x
        const kernelMatch = procVersion.match(/Linux version (\d+)\./);
        const majorVersion = kernelMatch ? parseInt(kernelMatch[1], 10) : 0;
        wsl = majorVersion >= 5 ? 'WSL2' : 'WSL1';
      }
    } catch {
      // Could not read /proc/version, check env var as fallback
      if (process.env.WSL_DISTRO_NAME) {
        wsl = 'WSL';
      }
    }
  }

  return {
    platform: process.platform,
    arch: process.arch,
    terminal: terminalInfo.name,
    terminalVersion: terminalInfo.version ?? null,
    multiplexer,
    wsl,
    runtimeShell: getRuntimeShell().kind,
    kittyProtocol: kittyProtocolEnabled,
    isTTY,
    TERM: process.env.TERM ?? null,
    TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
    procVersion,
    isAdmin: checkAdminPrivileges(),
  };
}

/**
 * Logs terminal capabilities for debugging and compatibility analysis.
 * Should be called after Kitty protocol detection completes.
 */
export async function logTerminalCapabilities(): Promise<void> {
  const capabilities = await detectTerminalCapabilities();
  logInfo('[TUI] Terminal capabilities initialized', { value: capabilities });
}
