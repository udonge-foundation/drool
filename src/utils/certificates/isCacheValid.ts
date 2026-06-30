import type { CertificateCache } from '@/utils/certificates/types';
import {
  CERTIFICATE_CACHE_VERSION,
  CERTIFICATE_CACHE_FALLBACK_TTL_MS,
} from '@/utils/constants';

/**
 * Check if a certificate cache is valid using count-based validation.
 * If count matches, cache is valid (no TTL needed - count match proves freshness).
 * If count doesn't match, cache is invalid.
 * If count is null (count check failed), fall back to TTL-based validation.
 */
export function isCacheValid(
  cache: CertificateCache,
  currentCount: number | null
): boolean {
  if (cache.version !== CERTIFICATE_CACHE_VERSION) {
    return false;
  }
  if (cache.platform !== process.platform) {
    return false;
  }

  const age = Date.now() - cache.timestamp;
  if (age >= CERTIFICATE_CACHE_FALLBACK_TTL_MS) {
    return false;
  }

  if (currentCount !== null) {
    return cache.certificateCount === currentCount;
  }

  return true;
}
