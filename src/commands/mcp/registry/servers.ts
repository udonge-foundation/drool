import { REGISTRY_SERVERS } from '@industry/common/settings';

import type { RegistryServer } from '@industry/common/settings';

export function getRegistryServers(): RegistryServer[] {
  return [...REGISTRY_SERVERS].sort((a, b) => a.name.localeCompare(b.name));
}
