import { WorkosMembershipRole } from './enums';
import { OnboardingWorkRole } from './onboarding/enums';

import type { ToolSettings } from './types';

/**
 * Email domains excluded from organization-level deduplication checks.
 * These are either public email providers (gmail.com) or internal domains (example.com).
 */
export const EXCLUDED_EMAIL_DOMAINS = ['gmail.com', 'example.com'];

/** Minimum search length before organization members filtering is applied. */
export const MIN_MEMBERS_SEARCH_LENGTH = 3;

export const MEMBERSHIP_ROLES = [
  WorkosMembershipRole.User,
  WorkosMembershipRole.Manager,
  WorkosMembershipRole.Owner,
] as const;

export const MEMBERSHIP_ROLE_LABELS: Record<WorkosMembershipRole, string> = {
  [WorkosMembershipRole.User]: 'User',
  [WorkosMembershipRole.Manager]: 'Manager',
  [WorkosMembershipRole.Owner]: 'Owner',
};

export const MEMBERSHIP_ROLE_ORDER: Record<WorkosMembershipRole, number> = {
  [WorkosMembershipRole.User]: 0,
  [WorkosMembershipRole.Manager]: 1,
  [WorkosMembershipRole.Owner]: 2,
};

export const ONBOARDING_WORK_ROLE_LABELS: Record<OnboardingWorkRole, string> = {
  [OnboardingWorkRole.Engineering]: 'Engineering',
  [OnboardingWorkRole.Product]: 'Product',
  [OnboardingWorkRole.Design]: 'Design',
  [OnboardingWorkRole.Finance]: 'Finance',
  [OnboardingWorkRole.Marketing]: 'Marketing',
  [OnboardingWorkRole.Sales]: 'Sales',
  [OnboardingWorkRole.Operations]: 'Operations',
  [OnboardingWorkRole.SomethingElse]: 'Something else',
};

export const NEW_ORG_NAME_PREFIX = 'NEW-ORGANIZATION';

/**
 * Firestore id prefix for ephemeral E2E test organizations (`e2e-org-<runId>`).
 * These org docs are throwaway, so connector tool-pack provisioning is skipped
 * for them to avoid leaking orphaned Merge packs that are never cleaned up.
 */
export const E2E_ORG_ID_PREFIX = 'e2e-org-';

export const DEFAULT_ORGANIZATION_TOOL_SETTINGS: ToolSettings = {
  browserToolsEnabled: false,
};
