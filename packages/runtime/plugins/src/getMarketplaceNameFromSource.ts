import * as path from 'path';

import { MarketplaceSource } from '@industry/common/settings';

// Eight hex chars give ~2^32 distinct prefixes, so coexisting pins of the same
// repo would need to collide on the same first byte run before name clashes
// become possible -- effectively never in practice. The full 40-char SHA still
// lives in `source.sha` so clone + checkout remain unambiguous.
const SHORT_SHA_LENGTH = 8;

export function getMarketplaceNameFromSource(
  source: MarketplaceSource
): string {
  if (source.source === 'local') {
    const basename = path.basename(source.path);
    return basename || 'unknown-marketplace';
  }

  let baseName: string;
  if (source.source === 'github') {
    const parts = source.repo.split('/').filter(Boolean);
    baseName = parts[parts.length - 1] ?? 'unknown-marketplace';
  } else {
    const urlParts = source.url
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean);
    baseName = urlParts[urlParts.length - 1] ?? 'unknown-marketplace';
  }

  // Append the pin so multiple refs/shas of the same repo can coexist. Refs
  // like `release/1.0` contain path separators, so sanitize them out to keep
  // the name safe for use as a directory name. SHA pins are truncated so the
  // install dir stays well under Windows' 260-char MAX_PATH even when the
  // upstream repo has deep paths of its own.
  if (source.sha) {
    return `${baseName}@${source.sha.slice(0, SHORT_SHA_LENGTH)}`;
  }
  if (source.ref) {
    const safeRef = source.ref.replace(/[/\\]/g, '-');
    return `${baseName}@${safeRef}`;
  }
  return baseName;
}
