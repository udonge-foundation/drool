import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { WINDOWS_JOB_OBJECT_ERROR_MARKER } from './constants';

import type { SpawnWithRetryOptions } from './types';
import type { ChildProcess } from 'child_process';

const DEFAULT_BACKOFF_MS: readonly number[] = [50, 150, 400];
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_GRACE_PERIOD_MS = 250;

interface EarlyExitObservation {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
  stderr: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Watches a freshly-spawned child for `gracePeriodMs`, returning an
 * observation describing whether it stayed alive or exited/errored in the
 * window.
 */
function observeEarlySpawnFailure(
  childProcess: ChildProcess,
  gracePeriodMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<EarlyExitObservation> {
  const observation: EarlyExitObservation = {
    exited: false,
    code: null,
    signal: null,
    error: null,
    stderr: '',
  };

  const stderrListener = (data: Buffer | string): void => {
    observation.stderr += data.toString();
  };
  const exitListener = (
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    observation.exited = true;
    observation.code = code;
    observation.signal = signal;
  };
  const errorListener = (err: Error): void => {
    observation.error = err;
  };

  childProcess.stderr?.on('data', stderrListener);
  childProcess.once('exit', exitListener);
  childProcess.once('error', errorListener);

  const cleanup = (): void => {
    childProcess.stderr?.off('data', stderrListener);
    childProcess.off('exit', exitListener);
    childProcess.off('error', errorListener);
  };

  return new Promise((resolve) => {
    const resolveAndCleanup = (): void => {
      cleanup();
      resolve(observation);
    };
    const onExitResolve = (): void => {
      // Small microtask buffer so any synchronous stderr events emitted
      // just before/with exit are captured before we detach listeners.
      setImmediate(resolveAndCleanup);
    };

    childProcess.once('exit', onExitResolve);
    childProcess.once('error', onExitResolve);
    void sleep(gracePeriodMs).then(() => {
      childProcess.off('exit', onExitResolve);
      childProcess.off('error', onExitResolve);
      resolveAndCleanup();
    });
  });
}

/**
 * Wraps a Node `child_process.spawn` industry with automatic retries on the
 * Windows Job Object spawn failure class. On non-Windows platforms (or when
 * `enabled: false`) this simply invokes `spawnIndustry()` once.
 *
 * On Windows, after each spawn we watch for early exits within
 * `gracePeriodMs`. If the child exits early AND the exit looks like a Job
 * Object failure (stderr marker, or non-zero exit without an explicit
 * permanent-failure 'error' event), we dispose the dead child and respawn
 * up to `maxRetries`.
 */
export async function spawnWithWindowsJobObjectRetry(
  spawnIndustry: () => ChildProcess,
  options: SpawnWithRetryOptions = {}
): Promise<ChildProcess> {
  const enabled = options.enabled ?? process.platform === 'win32';
  if (!enabled) {
    return spawnIndustry();
  }

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const sleep = options.sleep ?? defaultSleep;
  const logPrefix = options.logPrefix ?? '[spawnWithWindowsJobObjectRetry]';

  let lastChild: ChildProcess | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const child = spawnIndustry();
    lastChild = child;
    const observation = await observeEarlySpawnFailure(
      child,
      gracePeriodMs,
      sleep
    );

    if (!observation.exited && !observation.error) {
      return child;
    }

    const isRetryableJobObjectFailure =
      observation.stderr.includes(WINDOWS_JOB_OBJECT_ERROR_MARKER) ||
      (observation.exited && observation.code !== 0 && !observation.error);

    if (attempt === maxRetries || !isRetryableJobObjectFailure) {
      return child;
    }

    logWarn('spawnWithWindowsJobObjectRetry: retrying on early failure', {
      name: logPrefix,
      attempt: attempt + 1,
      maxAttempts: maxRetries,
      exitCode: observation.code,
      signal: observation.signal,
      stderrTail: observation.stderr.slice(-256),
    });

    try {
      await options.disposeEarlyExited?.(child);
    } catch (disposeErr) {
      logWarn('spawnWithWindowsJobObjectRetry: dispose error', {
        cause:
          disposeErr instanceof Error
            ? disposeErr
            : new Error(String(disposeErr)),
        name: logPrefix,
      });
    }

    await sleep(backoff[attempt] ?? backoff[backoff.length - 1] ?? 400);
  }

  if (lastChild) return lastChild;
  throw new MetaError(
    'spawnWithWindowsJobObjectRetry: exhausted retries without child',
    {}
  );
}
