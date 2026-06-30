import fsPromises from 'fs/promises';
import path from 'path';

import { logInfo, logWarn } from '@industry/logging';

import { getCertificateCachePath } from '@/utils/certificates/getCertificateCachePath';
import type { CertificateCache } from '@/utils/certificates/types';
import { CERTIFICATE_CACHE_VERSION } from '@/utils/constants';

/**
 * Save certificates to the cache file
 * @param certificates - Array of certificates to cache
 * @param certificateCount - Count of certificates (for fast validation on next load)
 */
export async function saveCertificateCache(
  certificates: string[],
  certificateCount: number
): Promise<void> {
  try {
    const cachePath = getCertificateCachePath();
    const cacheDir = path.dirname(cachePath);

    await fsPromises.mkdir(cacheDir, { recursive: true });

    const cache: CertificateCache = {
      version: CERTIFICATE_CACHE_VERSION,
      timestamp: Date.now(),
      platform: process.platform,
      certificateCount,
      certificates,
    };

    await fsPromises.writeFile(cachePath, JSON.stringify(cache), 'utf-8');
    logInfo('Saved system certificates to cache', {
      value: `${certificates.length} certificates, count: ${certificateCount}`,
    });
  } catch (error) {
    logWarn('Failed to save certificate cache', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
