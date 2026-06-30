import { MarketplaceSource } from '@industry/common/settings';

import { GitProtocol } from './enums';

export function getGitUrlFromSource(
  source: MarketplaceSource,
  protocol: GitProtocol = GitProtocol.HTTPS
): string {
  if (source.source === 'github') {
    if (protocol === GitProtocol.SSH) {
      return `git@github.com:${source.repo}.git`;
    }
    return `https://github.com/${source.repo}.git`;
  }

  if (source.source === 'local') {
    return source.path;
  }

  return source.url;
}
