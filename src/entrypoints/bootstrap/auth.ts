/**
 * Auth bootstrap layer — authentication, identity, and feature flags.
 *
 * Handles: system certificates, session end hook, telemetry auth getter,
 * auth token validation, org ID provider, host identity, feature flags warm.
 */
import { logInfo, logWarn } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';
import { getAuthToken, getAuthedUser } from '@industry/runtime/auth';
import {
  fetchFeatureFlags,
  setOrgIdProvider,
} from '@industry/runtime/feature-flags';

import { ensureSessionEndHookRegistered } from '@/services/SessionService';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { withStartupLatency } from '@/utils/startupLatency';

export async function bootstrapAuth(): Promise<{ token: string | null }> {
  ensureSessionEndHookRegistered();

  try {
    CliTelemetryClient.getInstance().setAuthTokenGetter(async () => {
      const { getRuntimeAuthConfig } = await import('@/environment');
      return getAuthToken(getRuntimeAuthConfig());
    });
  } catch {
    // Best-effort: telemetry client not initialized.
  }

  const token = await withStartupLatency(
    Metric.CLI_STARTUP_AUTH_TOKEN_LATENCY,
    () =>
      import('@/environment').then(({ getRuntimeAuthConfig }) =>
        getAuthToken(getRuntimeAuthConfig())
      ),
    (result) => ({ status: result ? 'present' : 'missing' })
  );
  if (!token) {
    logWarn('[bootstrap] Invalid auth');
  } else {
    logInfo('[bootstrap] Valid auth');
  }

  setOrgIdProvider(async () => {
    const { getRuntimeAuthConfig } = await import('@/environment');
    return (await getAuthedUser(getRuntimeAuthConfig()))?.orgId;
  });

  // Host identity
  const { initializeCliHostIdentity } = await import(
    '@/utils/initializeCliHostIdentity'
  );
  await initializeCliHostIdentity();
  logInfo('[bootstrap] Host identity initialized');

  // Feature flags (fire-and-forget)
  try {
    void withStartupLatency(Metric.CLI_STARTUP_FEATURE_FLAGS_WARM_LATENCY, () =>
      fetchFeatureFlags()
    ).catch((error) => {
      logWarn('[bootstrap] Failed to eagerly fetch feature flags', {
        cause: error,
      });
    });
  } catch {
    // Best-effort
  }

  return { token };
}
