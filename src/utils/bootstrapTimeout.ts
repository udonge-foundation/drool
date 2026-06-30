import { MetaError } from '@industry/logging';

import type { BootstrapTimeoutOptions } from '@/utils/types';

/**
 * Run a bootstrap step with a timeout and optional fallback.
 *
 * Shared by both `daemon.ts` (daemon command handler) and `index.ts`
 * (shared CLI bootstrap) to avoid duplicating timeout + progress logic.
 */
export async function withBootstrapTimeout<T>(
  fn: () => Promise<T>,
  opts: BootstrapTimeoutOptions
): Promise<T> {
  const { stepName, timeoutMs, onProgress } = opts;
  const hasFallback = 'fallback' in opts;

  onProgress?.(`${stepName} starting`);
  const startMs = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new MetaError(`${stepName} timed out`, { timeout: timeoutMs })
            ),
          timeoutMs
        );
      }),
    ]);
    onProgress?.(`${stepName} completed (${Date.now() - startMs}ms)`);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onProgress?.(`${stepName} failed after ${Date.now() - startMs}ms: ${msg}`);
    if (hasFallback) return opts.fallback as T;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
