import { getBaseEnv } from '@industry/environment';

import type { MachineTemplate } from '@industry/common/api/v0/machine-templates';

// Empty workspace template IDs for dev and prod
const EMPTY_WORKSPACE_TEMPLATE_ID_DEV = 'industry-ws-244b4011788ed6454507';
const EMPTY_WORKSPACE_TEMPLATE_ID_PROD = 'industry-ws-fe5b6e6398ac0cd0a780';

// Empty workspace IDs per environment
// These are Firestore document IDs, not E2B template IDs
const EMPTY_WORKSPACE_ID_DEV = 'empty-workspace-dev';
const EMPTY_WORKSPACE_ID_PROD = 'empty-workspace-2';

/**
 * Default "empty" workspace item for session creation.
 *
 * Keyed off the base env's deploymentEnv (production tier vs everything
 * else) so the returned templateId / providerEnvironmentId point at the
 * right Firestore doc + E2B template for the current deployment. Callers
 * that need to override (e.g., cross-environment tests) may pass
 * `isProduction` explicitly.
 */
export function getEmptyWorkspaceItem(
  isProduction = getBaseEnv().isProductionTier
): MachineTemplate & {
  providerEnvironmentId: string;
} {
  return {
    templateId: isProduction ? EMPTY_WORKSPACE_ID_PROD : EMPTY_WORKSPACE_ID_DEV,
    providerEnvironmentId: isProduction
      ? EMPTY_WORKSPACE_TEMPLATE_ID_PROD
      : EMPTY_WORKSPACE_TEMPLATE_ID_DEV,
    templateName: 'Empty Template',
    repoUrl: '',
    defaultBranch: 'main',
    buildStatus: { status: 'success' as const },
    createdBy: '',
  };
}
