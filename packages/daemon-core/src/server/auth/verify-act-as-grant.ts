import {
  VerifyActAsGrantRequest,
  VerifyActAsGrantResponse,
} from '@industry/common/api/act-as-grants';

import { IndustryApiClient } from '../../services/ApiClient';

import type { RuntimeAuthConfig } from '@industry/runtime/auth';

/**
 * Verify an act-as grant against the backend, authenticated as the daemon's
 * own service account (via `runtimeAuthConfig`). Returns the operator + SA the
 * grant binds to.
 *
 * Kept in its own module so callers reach it across a module boundary, which
 * lets tests stub the backend round-trip via `vi.mock` instead of threading a
 * test-only dependency through production options.
 */
export async function verifyActAsGrantViaBackend({
  grant,
  runtimeAuthConfig,
  reverify = false,
}: {
  grant: string;
  runtimeAuthConfig: RuntimeAuthConfig;
  /**
   * Set for the daemon's periodic re-verification of an already-connected
   * act-as session. Tells the backend to ignore the short connect TTL while
   * still enforcing revocation / SA-active / operator-role checks.
   */
  reverify?: boolean;
}): Promise<VerifyActAsGrantResponse> {
  const client = new IndustryApiClient(runtimeAuthConfig);
  const response = await client.post<
    VerifyActAsGrantResponse,
    VerifyActAsGrantRequest
  >('/api/v0/act-as-grants/verify', { grant, reverify });
  return response.data;
}
