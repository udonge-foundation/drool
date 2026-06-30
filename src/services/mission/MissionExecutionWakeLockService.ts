import { ChildProcess, spawn, spawnSync } from 'child_process';

import { logInfo, logWarn } from '@industry/logging';

type CommandExistsFn = (command: string) => boolean;
type MissionWakeLockSignal = 'SIGTERM' | 'SIGKILL';

const MISSION_WAKE_LOCK_TERM_GRACE_MS = 2_000;
const LINUX_PARENT_CHECK_INTERVAL_SECONDS = 5;

interface WakeLockCommand {
  command: string;
  args: string[];
  windowsHide: boolean;
}

interface ActiveWakeLock {
  childProcess: ChildProcess;
  missionId: string;
  releaseRequested: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  sessionId: string;
}

function buildLinuxWakeLockLoop(): string {
  return [
    'parent_pid="$1"',
    'if [ -z "$parent_pid" ]; then exit 1; fi',
    'while kill -0 "$parent_pid" 2>/dev/null; do',
    `  sleep ${LINUX_PARENT_CHECK_INTERVAL_SECONDS}`,
    'done',
  ].join('\n');
}

function buildLinuxWakeLockArgs(
  baseArgs: string[],
  parentPid: number
): string[] {
  return [
    ...baseArgs,
    'sh',
    '-c',
    buildLinuxWakeLockLoop(),
    'sh',
    String(parentPid),
  ];
}

export function resolveWakeLockCommand(params: {
  platform: NodeJS.Platform;
  commandExists: CommandExistsFn;
  parentPid?: number;
}): WakeLockCommand | null {
  const { platform, commandExists } = params;
  const parentPid = params.parentPid ?? process.pid;

  if (platform === 'darwin') {
    if (!commandExists('caffeinate')) {
      return null;
    }
    return {
      command: 'caffeinate',
      args: ['-i', '-w', String(parentPid)],
      windowsHide: false,
    };
  }

  if (platform === 'linux') {
    if (commandExists('systemd-inhibit')) {
      return {
        command: 'systemd-inhibit',
        args: buildLinuxWakeLockArgs(
          [
            '--what=sleep:idle:handle-lid-switch',
            '--mode=block',
            '--who=drool',
            '--why=Keep system awake during mission execution',
          ],
          parentPid
        ),
        windowsHide: false,
      };
    }

    if (commandExists('gnome-session-inhibit')) {
      return {
        command: 'gnome-session-inhibit',
        args: buildLinuxWakeLockArgs(
          [
            '--inhibit',
            'suspend:idle',
            '--reason',
            'Keep system awake during mission execution',
          ],
          parentPid
        ),
        windowsHide: false,
      };
    }

    return null;
  }

  if (platform === 'win32') {
    const windowsScript = `
$ES_CONTINUOUS = 0x80000000
$ES_SYSTEM_REQUIRED = 0x00000001

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinPower {
  [DllImport("kernel32.dll", CharSet=CharSet.Auto, SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@

[WinPower]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null

try {
  while ($true) {
    Start-Sleep -Seconds 30
  }
} finally {
  [WinPower]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
}
`.trim();

    const command = commandExists('powershell')
      ? 'powershell'
      : commandExists('pwsh')
        ? 'pwsh'
        : null;

    if (!command) {
      return null;
    }

    return {
      command,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        windowsScript,
      ],
      windowsHide: true,
    };
  }

  return null;
}

interface MissionExecutionWakeLockServiceDependencies {
  platform?: NodeJS.Platform;
  parentPid?: number;
  clearTimeout?: typeof clearTimeout;
  isProcessAlive?: (pid: number) => boolean;
  setTimeout?: typeof setTimeout;
  signalProcess?: (
    pid: number,
    signal: MissionWakeLockSignal,
    options: { processGroup: boolean }
  ) => void;
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  termGraceMs?: number;
}

class MissionExecutionWakeLockService {
  private readonly platform: NodeJS.Platform;

  private readonly parentPid: number;

  private readonly spawnFn: typeof spawn;

  private readonly spawnSyncFn: typeof spawnSync;

  private readonly clearTimeoutFn: typeof clearTimeout;

  private readonly isProcessAliveFn: (pid: number) => boolean;

  private readonly setTimeoutFn: typeof setTimeout;

  private readonly signalProcessFn: (
    pid: number,
    signal: MissionWakeLockSignal,
    options: { processGroup: boolean }
  ) => void;

  private readonly termGraceMs: number;

  private currentWakeLock: ActiveWakeLock | null = null;

  constructor(deps?: MissionExecutionWakeLockServiceDependencies) {
    this.platform = deps?.platform ?? process.platform;
    this.parentPid = deps?.parentPid ?? process.pid;
    this.spawnFn = deps?.spawn ?? spawn;
    this.spawnSyncFn = deps?.spawnSync ?? spawnSync;
    this.clearTimeoutFn = deps?.clearTimeout ?? clearTimeout;
    this.isProcessAliveFn =
      deps?.isProcessAlive ?? ((pid) => this.isProcessAlive(pid));
    this.setTimeoutFn = deps?.setTimeout ?? setTimeout;
    this.signalProcessFn =
      deps?.signalProcess ??
      ((pid, signal, options) =>
        this.signalProcess(pid, signal, {
          processGroup: options.processGroup,
        }));
    this.termGraceMs = deps?.termGraceMs ?? MISSION_WAKE_LOCK_TERM_GRACE_MS;
  }

  private commandExists(command: string): boolean {
    const lookupCommand = this.platform === 'win32' ? 'where' : 'which';

    try {
      const result = this.spawnSyncFn(lookupCommand, [command], {
        stdio: 'ignore',
        timeout: 1000,
      });

      return result.status === 0;
    } catch {
      return false;
    }
  }

  private usesProcessGroups(): boolean {
    return this.platform !== 'win32';
  }

  private signalProcess(
    pid: number,
    signal: MissionWakeLockSignal,
    options: { processGroup: boolean }
  ): void {
    const targetPid = options.processGroup && pid > 0 ? -pid : pid;
    process.kill(targetPid, signal);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH' || err.code === 'ENOENT') {
        return false;
      }
      return true;
    }
  }

  private clearReleaseTimer(lock: ActiveWakeLock): void {
    if (!lock.releaseTimer) {
      return;
    }
    this.clearTimeoutFn(lock.releaseTimer);
    lock.releaseTimer = null;
  }

  private finalizeLock(lock: ActiveWakeLock): void {
    this.clearReleaseTimer(lock);
    if (this.currentWakeLock !== lock) {
      return;
    }
    this.currentWakeLock = null;
  }

  private trySignalLock(
    lock: ActiveWakeLock,
    signal: MissionWakeLockSignal
  ): boolean {
    const pid = lock.childProcess.pid;
    if (!pid) {
      try {
        lock.childProcess.kill(signal);
      } catch (error) {
        logWarn('[MissionWakeLock] Failed to signal mission wake lock child', {
          sessionId: lock.sessionId,
          signal,
          cause: error,
        });
      }
      return true;
    }

    try {
      this.signalProcessFn(pid, signal, {
        processGroup: this.usesProcessGroups(),
      });
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH' || err.code === 'ENOENT') {
        this.finalizeLock(lock);
        return false;
      }

      logWarn('[MissionWakeLock] Failed to signal mission wake lock process', {
        sessionId: lock.sessionId,
        signal,
        cause: error,
      });
      return true;
    }
  }

  private beginRelease(lock: ActiveWakeLock): void {
    if (lock.releaseRequested) {
      return;
    }

    lock.releaseRequested = true;
    const shouldWaitForExit = this.trySignalLock(lock, 'SIGTERM');
    if (!shouldWaitForExit) {
      return;
    }

    lock.releaseTimer = this.setTimeoutFn(() => {
      const pid = lock.childProcess.pid;
      if (!pid) {
        this.finalizeLock(lock);
        return;
      }
      if (!this.isProcessAliveFn(pid)) {
        this.finalizeLock(lock);
        return;
      }

      logWarn(
        '[MissionWakeLock] Wake lock did not exit after SIGTERM, escalating',
        {
          sessionId: lock.sessionId,
          pid,
        }
      );
      this.trySignalLock(lock, 'SIGKILL');
    }, this.termGraceMs);

    lock.releaseTimer.unref?.();
  }

  acquire(params: { sessionId: string; missionId: string }): void {
    if (
      this.currentWakeLock &&
      this.currentWakeLock.sessionId === params.sessionId &&
      !this.currentWakeLock.releaseRequested
    ) {
      return;
    }

    if (this.currentWakeLock) {
      this.beginRelease(this.currentWakeLock);
    }

    const command = resolveWakeLockCommand({
      platform: this.platform,
      commandExists: (name) => this.commandExists(name),
      parentPid: this.parentPid,
    });

    if (!command) {
      logWarn(
        '[MissionWakeLock] No supported wake-lock command found for platform'
      );
      return;
    }

    try {
      const child = this.spawnFn(command.command, command.args, {
        stdio: 'ignore',
        detached: this.usesProcessGroups(),
        windowsHide: command.windowsHide,
      });

      const wakeLock: ActiveWakeLock = {
        childProcess: child,
        missionId: params.missionId,
        releaseRequested: false,
        releaseTimer: null,
        sessionId: params.sessionId,
      };

      child.unref();
      child.once('exit', () => {
        this.finalizeLock(wakeLock);
      });

      this.currentWakeLock = wakeLock;

      logInfo('[MissionWakeLock] Acquired mission wake lock', {
        sessionId: params.sessionId,
        command: command.command,
      });
    } catch (error) {
      logWarn('[MissionWakeLock] Failed to acquire mission wake lock', {
        sessionId: params.sessionId,
        cause: error,
      });
    }
  }

  release(params?: { sessionId?: string; force?: boolean }): void {
    if (!this.currentWakeLock) {
      return;
    }

    const sessionMatches =
      !params?.sessionId || this.currentWakeLock.sessionId === params.sessionId;
    if (!params?.force && !sessionMatches) {
      return;
    }

    this.beginRelease(this.currentWakeLock);
  }
}

const missionExecutionWakeLockService = new MissionExecutionWakeLockService();

export function getMissionExecutionWakeLockService(): MissionExecutionWakeLockService {
  return missionExecutionWakeLockService;
}

export { MissionExecutionWakeLockService };
