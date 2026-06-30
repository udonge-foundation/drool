import { getCredentialsStorage } from '../credentials/CredentialsStorage';

import type { RuntimeAuthConfig } from './common/types';

function normalizeActiveOrganizationId(
  activeOrganizationId: string | null | undefined
): string | null {
  const trimmed = activeOrganizationId?.trim();
  return trimmed || null;
}

export async function getActiveOrganizationId(
  config?: Pick<RuntimeAuthConfig, 'disableKeyring' | 'airgapEnabled'>
): Promise<string | null> {
  if (config?.airgapEnabled) return null;
  const storage = getCredentialsStorage({
    disableKeyring: config?.disableKeyring,
  });
  const credentials = await storage.load();
  return normalizeActiveOrganizationId(credentials?.active_organization_id);
}

export async function setActiveOrganizationId(
  activeOrganizationId: string | null,
  config?: Pick<RuntimeAuthConfig, 'disableKeyring' | 'airgapEnabled'>
): Promise<void> {
  if (config?.airgapEnabled) return;
  const storage = getCredentialsStorage({
    disableKeyring: config?.disableKeyring,
  });
  const credentials = await storage.load();
  if (!credentials) {
    return;
  }

  await storage.save({
    ...credentials,
    active_organization_id: normalizeActiveOrganizationId(activeOrganizationId),
  });
}
