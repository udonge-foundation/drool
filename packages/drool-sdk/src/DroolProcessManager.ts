import { spawn, type SpawnOptions } from 'child_process';

import { logInfo, logWarn } from '@industry/logging';
import { resolveDroolCommand } from '@industry/utils/cli';
import { expandTilde } from '@industry/utils/shell';

import { DroolProcessMode } from './enums';
import { ConnectionError } from './errors';
import { ManagedProcessImpl } from './ManagedProcessImpl';
import { spawnWithWindowsJobObjectRetry } from './windowsJobObjectRetry';

import type {
  DroolProcessConfig,
  ManagedProcess,
  SpawnWithRetryOptions,
} from './types';

function buildArgs(config: DroolProcessConfig): string[] {
  const args: string[] = [];

  if (config.mode === DroolProcessMode.Acp) {
    // ACP child mode: drool exec --output-format acp
    args.push('exec', '--output-format', 'acp');
  } else {
    // stream-jsonrpc mode (SDK compatibility)
    args.push(
      'exec',
      '--input-format',
      'stream-jsonrpc',
      '--output-format',
      'stream-jsonrpc'
    );
  }

  if (config.extraArgs) {
    args.push(...config.extraArgs);
  }

  return args;
}

/**
 * DroolProcessManager handles spawning and managing drool child processes.
 * This is a generalized process manager that can spawn processes in different modes:
 * - 'acp': For ACP child mode (`drool exec --output-format acp`)
 * - 'stream-jsonrpc': For SDK mode (`drool exec --input-format stream-jsonrpc`)
 */
export class DroolProcessManager {
  /**
   * Spawn a new drool process with the given configuration.
   *
   * Returns a synchronous ManagedProcess as soon as the OS reports the child
   * as spawned. This does not retry Windows Job Object spawn failures — use
   * {@link DroolProcessManager#spawnWithWindowsRetry} for that.
   */
  spawn(config: DroolProcessConfig): ManagedProcess {
    const { logPrefix, execPath, expandedCwd, childProcess } =
      this.spawnChildProcess(config);
    return new ManagedProcessImpl(childProcess, logPrefix, {
      cwd: expandedCwd,
      execPath,
    });
  }

  /**
   * Spawn a drool process with automatic retry for the Windows Job Object
   * spawn error class (FAC-19070). On non-Windows platforms this behaves
   * identically to {@link DroolProcessManager#spawn} but returns a promise.
   *
   * When a Windows child process exits within the startup grace period and
   * the exit looks like the `AssignProcessToJobObject` failure pattern, the
   * dead child is disposed and a fresh spawn is attempted, up to the
   * configured retry cap.
   */
  async spawnWithWindowsRetry(
    config: DroolProcessConfig,
    retryOptions: SpawnWithRetryOptions = {}
  ): Promise<ManagedProcess> {
    // Fast path: the Job Object spawn race only exists on Windows. Skip the
    // retry wrapper (and its grace-period observer) entirely on other
    // platforms so mac/linux callers pay zero latency cost.
    if (process.platform !== 'win32') {
      return this.spawn(config);
    }

    const planned = this.prepareSpawn(config);
    const childProcess = await spawnWithWindowsJobObjectRetry(
      () => this.invokeNodeSpawn(planned),
      {
        ...retryOptions,
        logPrefix: '[DroolProcessManager]',
        disposeEarlyExited: (child) => {
          // Ensure streams are flushed/closed so we don't leak file handles
          // onto the next attempt. kill() is a best-effort no-op if the
          // child already exited.
          try {
            child.stdin?.end();
          } catch (stdinErr) {
            logWarn('DroolProcessManager: stdin.end() threw during dispose', {
              cause:
                stdinErr instanceof Error
                  ? stdinErr
                  : new Error(String(stdinErr)),
            });
          }
          try {
            child.kill();
          } catch (killErr) {
            logWarn('DroolProcessManager: kill() threw during dispose', {
              cause:
                killErr instanceof Error ? killErr : new Error(String(killErr)),
            });
          }
        },
      }
    );

    if (!childProcess.stdout || !childProcess.stdin) {
      throw new ConnectionError('Failed to get process stdio');
    }

    return new ManagedProcessImpl(childProcess, planned.logPrefix, {
      cwd: planned.expandedCwd,
      execPath: planned.execPath,
    });
  }

  private prepareSpawn(config: DroolProcessConfig): {
    logPrefix: string;
    execPath: string;
    expandedCwd: string | undefined;
    args: string[];
    env: NodeJS.ProcessEnv;
    enableIpc: boolean;
  } {
    const command = resolveDroolCommand(config.isDevelopment ?? false);
    const execPath = config.execPath || command.execPath;
    const prefixArgs = config.execPath ? [] : command.prefixArgs;

    const args = [...prefixArgs, ...buildArgs(config)];
    const expandedCwd = config.cwd ? expandTilde(config.cwd) : undefined;

    const logPrefix =
      config.mode === DroolProcessMode.Acp ? '[drool acp]' : '[drool exec]';

    logInfo('[drool process] Spawning', {
      state: logPrefix,
      path: execPath,
      args,
      cwd: expandedCwd,
      version: process.env.CLI_VERSION || 'unknown',
    });

    return {
      logPrefix,
      execPath,
      expandedCwd,
      args,
      env: {
        ...process.env,
        ...config.env,
      },
      enableIpc: config.enableIpc ?? false,
    };
  }

  private invokeNodeSpawn(planned: {
    execPath: string;
    args: string[];
    expandedCwd: string | undefined;
    env: NodeJS.ProcessEnv;
    enableIpc: boolean;
  }): ReturnType<typeof spawn> {
    const options: SpawnOptions = {
      cwd: planned.expandedCwd,
      env: planned.env,
      stdio: planned.enableIpc
        ? ['pipe', 'pipe', 'pipe', 'ipc']
        : ['pipe', 'pipe', 'pipe'],
    };

    if (planned.enableIpc) {
      options.serialization = 'json';
    }

    return spawn(planned.execPath, planned.args, options);
  }

  private spawnChildProcess(config: DroolProcessConfig): {
    logPrefix: string;
    execPath: string;
    expandedCwd: string | undefined;
    childProcess: ReturnType<typeof spawn>;
  } {
    const planned = this.prepareSpawn(config);
    const childProcess = this.invokeNodeSpawn(planned);
    if (!childProcess.stdout || !childProcess.stdin) {
      throw new ConnectionError('Failed to get process stdio');
    }
    return {
      logPrefix: planned.logPrefix,
      execPath: planned.execPath,
      expandedCwd: planned.expandedCwd,
      childProcess,
    };
  }
}
