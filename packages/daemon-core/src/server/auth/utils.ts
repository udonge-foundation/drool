import { INDUSTRY_API_KEY_PREFIX } from '@industry/common/industryApiKeys/constants';
import { logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  getAuthedUser,
  validateWorkOsJwt,
  verifyToken,
} from '@industry/runtime/auth';

import { verifyActAsGrantViaBackend } from './verify-act-as-grant';
import { DaemonUserAuthEnv } from '../../types';
import { DaemonUser } from '../types';

import type { RuntimeAuthConfig } from '@industry/runtime/auth';

interface AuthenticateOptions {
  /** Runtime auth config threaded from host getEnv() output */
  runtimeAuthConfig: RuntimeAuthConfig;
  /** API key from client (fk-...) */
  apiKey?: string;
  /** WorkOS JWT token from client */
  token?: string;
  /**
   * Act-as delegation grant (`fdg-...`). When present the connection is
   * authenticated as the daemon's own service account, with the grant's
   * operator recorded for audit. Requires `token` (the operator's WorkOS JWT).
   */
  actAsGrant?: string;
}

/**
 * Authenticate a WebSocket client credential against the daemon's identity.
 *
 * The client may provide:
 * - INDUSTRY_API_KEY (fk-...): Verified via /whoami endpoint
 * - WorkOS JWT: Verified locally by decoding the JWT
 *
 * When testingBypassTokenPassword is set (e2e tests), the daemon identity check
 * is skipped and the JWT is verified using the bypass secret.
 *
 * Otherwise, the client's identity must match the daemon's own identity (from getAuthedUser).
 *
 * @returns The authenticated DaemonUser
 * @throws MetaError if not authenticated or identity mismatch
 */
export async function authenticateUser(
  options: AuthenticateOptions
): Promise<DaemonUser> {
  const { runtimeAuthConfig, apiKey, token, actAsGrant } = options;
  const { testingBypassTokenPassword } = runtimeAuthConfig;

  // Determine which credential was provided
  const credential = apiKey?.startsWith(INDUSTRY_API_KEY_PREFIX)
    ? apiKey
    : token;
  if (!credential) {
    throw new MetaError('No authentication provided');
  }

  // Act-as delegation: a human operator drives a session against this
  // service-account-owned daemon. The operator presents their own WorkOS JWT
  // plus a backend-minted grant. We verify the operator locally, confirm the
  // grant (as the SA) against the backend, and authenticate the connection as
  // the SA with the operator recorded for audit.
  if (actAsGrant) {
    if (!token) {
      throw new MetaError('Act-as grant requires an operator token');
    }

    const saApiKey = runtimeAuthConfig.apiKey;
    if (!saApiKey) {
      throw new MetaError(
        'Act-as is only supported on service-account-owned daemons'
      );
    }

    const operatorUser = await verifyToken(token, runtimeAuthConfig);
    if (!operatorUser.orgId) {
      throw new MetaError('Operator not affiliated with an organization');
    }

    const daemonUser = await getAuthedUser(runtimeAuthConfig);
    if (!daemonUser || !daemonUser.orgId) {
      throw new MetaError('Daemon not authenticated');
    }

    const result = await verifyActAsGrantViaBackend({
      grant: actAsGrant,
      runtimeAuthConfig,
    });

    // The grant must bind exactly this operator to exactly this SA, in the
    // same org. Any mismatch means the grant was minted for a different
    // operator/SA and must not authenticate this connection.
    if (result.operatorUserId !== operatorUser.userId) {
      throw new MetaError('Act-as grant operator mismatch');
    }
    if (result.serviceAccountId !== daemonUser.userId) {
      throw new MetaError('Act-as grant target mismatch');
    }
    if (operatorUser.orgId !== daemonUser.orgId) {
      throw new MetaError('Operator and daemon organizations differ');
    }

    logInfo('Act-as grant verified', {
      operatorUserId: operatorUser.userId,
      serviceAccountId: daemonUser.userId,
    });

    return {
      userId: daemonUser.userId,
      orgId: daemonUser.orgId,
      apiKey: saApiKey,
      operator: { userId: operatorUser.userId },
    };
  }

  // E2E testing bypass: verify token with shared secret, skip daemon identity check
  if (
    testingBypassTokenPassword &&
    !credential.startsWith(INDUSTRY_API_KEY_PREFIX)
  ) {
    const payload = await validateWorkOsJwt({
      token: credential,
      bypassTokenPassword: testingBypassTokenPassword,
    });

    if (!payload.external_org_id) {
      throw new MetaError('Client not affiliated with an organization');
    }

    logInfo('Client credential verified via testing bypass');

    return {
      userId: payload.sub,
      orgId: payload.external_org_id,
      token: credential,
      testingBypassTokenPassword,
    };
  }

  // Get daemon's own identity for comparison
  const daemonUser = await getAuthedUser(runtimeAuthConfig);
  if (!daemonUser || !daemonUser.orgId) {
    throw new MetaError('Daemon not authenticated');
  }

  // Verify the client's token
  const clientUser = await verifyToken(credential, runtimeAuthConfig);
  if (!clientUser.orgId) {
    throw new MetaError('Client not affiliated with an organization');
  }

  logInfo('Client credential verified');

  // Verify client identity matches daemon identity
  if (
    clientUser.userId !== daemonUser.userId ||
    clientUser.orgId !== daemonUser.orgId
  ) {
    throw new MetaError('Client identity does not match daemon identity');
  }

  // Return with appropriate credential field
  if (credential.startsWith(INDUSTRY_API_KEY_PREFIX)) {
    return {
      userId: clientUser.userId,
      orgId: clientUser.orgId,
      apiKey: credential,
    };
  }

  return {
    userId: clientUser.userId,
    orgId: clientUser.orgId,
    token: credential,
  };
}

/**
 * Get the environment variables for injecting auth credentials to CLI processes.
 *
 * For local scenarios: Don't pass any auth env - CLI reads from shared stored credentials
 * so it can refresh expired tokens.
 * For testing bypass: Pass INDUSTRY_API_KEY since no shared stored credentials exist in CI.
 * For API key auth: Pass INDUSTRY_API_KEY.
 */
export function getDaemonUserAuthEnv(
  user: DaemonUser
): DaemonUserAuthEnv | Record<string, never> {
  // Testing bypass: no shared stored credentials in CI, pass token + bypass password
  if (user.testingBypassTokenPassword && user.token) {
    return {
      INDUSTRY_API_KEY: user.token,
      TESTING_BYPASS_TOKEN_PASSWORD: user.testingBypassTokenPassword,
    };
  }
  // Local JWT users: CLI reads from shared stored credentials (supports refresh)
  if ('token' in user && user.token) {
    return {};
  }
  // API key auth
  if (user.apiKey) {
    return { INDUSTRY_API_KEY: user.apiKey };
  }
  return {};
}
