/**
 * Windows-specific retry logic for file operations.
 *
 * On Windows, A/V software can lock files for up to 60 seconds (e.g., Parity Bit9),
 * causing EPERM/EACCES errors. This module follows the graceful-fs pattern used by npm:
 * retry for up to 60 seconds using setTimeout to yield the scheduler.
 *
 * Yielding is critical because busy-looping starves the A/V process of CPU,
 * preventing it from releasing the lock.
 */

import { promises as fs } from 'fs';

import { logInfo, logWarn } from '@industry/logging';
import { getErrorCode } from '@industry/utils/errors';

const MAX_RETRY_TIME_MS = 60000;
const MAX_BACKOFF_MS = 100;
const BACKOFF_INCREMENT_MS = 10;

/**
 * Rename file with retry logic for Windows to handle transient A/V locks.
 * On non-Windows platforms, performs a direct rename without retry.
 */
export async function renameWithRetry(
  oldPath: string,
  newPath: string,
  platform: string
): Promise<void> {
  if (platform !== 'windows') {
    return fs.rename(oldPath, newPath);
  }

  const start = Date.now();
  let backoff = 0;

  const attempt = async (): Promise<void> => {
    try {
      await fs.rename(oldPath, newPath);
    } catch (error) {
      const errorCode = getErrorCode(error);
      const isRetryable = ['EPERM', 'EACCES', 'EBUSY'].includes(
        errorCode ?? ''
      );
      const withinTimeout = Date.now() - start < MAX_RETRY_TIME_MS;

      if (isRetryable && withinTimeout) {
        try {
          await fs.stat(newPath);
          throw error;
        } catch (statErr) {
          if (getErrorCode(statErr) === 'ENOENT') {
            // Target doesn't exist yet, safe to retry
            logWarn('Retrying rename after transient error', {
              cause: statErr,
            });
          } else {
            throw error;
          }
        }

        logInfo('Retrying Windows rename due to A/V lock', {
          durationMs: Date.now() - start,
          delay: backoff,
          paths: [oldPath, newPath],
        });

        await new Promise<void>((resolve) => {
          setTimeout(resolve, backoff);
        });
        if (backoff < MAX_BACKOFF_MS) {
          backoff += BACKOFF_INCREMENT_MS;
        }
        return attempt();
      }
      throw error;
    }
  };

  return attempt();
}
