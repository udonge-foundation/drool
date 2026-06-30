import fsPromises from 'fs/promises';

import { logInfo, logWarn } from '@industry/logging';

import { getCertificateCachePath } from '@/utils/certificates/getCertificateCachePath';
import { isCacheValid } from '@/utils/certificates/isCacheValid';
import type { CertificateCache } from '@/utils/certificates/types';

/**
 * Load cached certificates from disk
 * @param currentCount - Current certificate count for validation (null if count check failed)
 * @returns Array of cached certificates, or null if cache is invalid/missing
 */
export async function loadCachedCertificates(
  currentCount: number | null
): Promise<string[] | null> {
  try {
    const cachePath = getCertificateCachePath();

    let content: string;
    try {
      content = await fsPromises.readFile(cachePath, 'utf-8');
    } catch {
      // Cache file doesn't exist
      return null;
    }

    const cache: CertificateCache = JSON.parse(content);

    if (!isCacheValid(cache, currentCount)) {
      logInfo('Certificate cache invalid, will re-extract', {
        value: `cachedCount: ${cache.certificateCount}, currentCount: ${currentCount}, cacheAge: ${Date.now() - cache.timestamp}ms`,
      });
      return null;
    }

    logInfo('Using cached system certificates', {
      value: `${cache.certificates.length} certificates, cached ${Math.round((Date.now() - cache.timestamp) / 1000 / 60)} minutes ago`,
    });
    return cache.certificates;
  } catch (error) {
    logWarn('Failed to load certificate cache, will re-extract', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
