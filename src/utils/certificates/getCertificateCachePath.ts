import path from 'path';

import { CERTIFICATE_CACHE_FILE } from '@/utils/constants';
import { getUserIndustryDir } from '@/utils/industryPaths';

/**
 * Get the path to the certificate cache file
 */
export function getCertificateCachePath(): string {
  const industryDir = getUserIndustryDir();
  return path.join(industryDir, 'certs', CERTIFICATE_CACHE_FILE);
}
