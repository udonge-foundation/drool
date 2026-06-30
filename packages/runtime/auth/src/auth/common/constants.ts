/**
 * Shared constants for authentication.
 */

import type { AuthedUser } from './types';

/**
 * Synthetic user returned by all auth helpers when airgap mode is enabled.
 *
 * The orgId is opaque and intentionally non-routable so any code path that
 * leaks it into Industry-backed APIs gets a 4xx instead of mis-routing to a
 * real org.
 */
export const AIRGAPPED_USER: AuthedUser = {
  userId: 'airgapped-user',
  email: '',
  orgId: 'airgapped-org',
};

/**
 * Synthetic bearer token used by airgap mode when callers still expect a
 * non-empty token (e.g. for headers they then forward to BYOK providers).
 * Must NOT match any real Industry API key prefix.
 */
export const AIRGAPPED_TOKEN = 'airgapped-token';
