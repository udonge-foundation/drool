import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { logWarn, logInfo } from '@industry/logging';
import { fetchFeatureFlags, getFlag } from '@industry/runtime/feature-flags';

import { getRuntimeAuthConfig } from '@/environment';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { collectAndEmitRepoMetadata } from '@/telemetry/customer/repoMetadata';

/**
 * Initialize OTEL telemetry.
 * Call this after authentication is available (e.g., after settings initialization).
 * Enabled in both production and development - separate GCP pipelines exist
 * for each. Set OTEL_CUSTOMER_ENABLED=false to opt out (e.g. in tests or
 * locally) — the explicit opt-out is honored before we force-enable the
 * client.
 */
export async function initCustomerTelemetry(): Promise<void> {
  try {
    if (getRuntimeAuthConfig().airgapEnabled) {
      logInfo('[initCustomerTelemetry] Airgap Mode is enabled; skipping');
      return;
    }

    // Defaults to checking OTEL_CUSTOMER_ENABLED environment variable
    CustomerMetrics.initialize();

    if (process.env.OTEL_CUSTOMER_ENABLED === 'false') {
      logInfo('[initCustomerTelemetry] disabled via OTEL_CUSTOMER_ENABLED');
      return;
    }

    CustomerMetrics.enable();
    logInfo('[initCustomerTelemetry] Enabled');

    // Collect and emit repo metadata in background (non-blocking)
    collectAndEmitRepoMetadata(process.cwd()).catch(() => {
      // Errors are already logged in collectAndEmitRepoMetadata
    });
  } catch (error) {
    logWarn('[initCustomerTelemetry] failed to initialize customer OTEL', {
      cause: error,
    });
  }
}

/**
 * Initialize Sub-Agents V2 flag availability.
 * Sets the flag immediately from disk cache (synchronous), then kicks off
 * an async remote fetch to update for the current session.
 */
export function initSubAgentsV2Flag(): void {
  // Set immediately from disk cache / default
  const cachedValue = getFlag(IndustryFeatureFlags.SubAgentsV2);
  getExecRuntimeConfig().setSubAgentsV2Enabled(cachedValue);

  if (cachedValue) {
    logInfo('[initSubAgentsV2Flag] Sub-Agents V2 enabled (from disk cache)');
  }

  // Fetch remote flags and update (non-blocking)
  fetchFeatureFlags()
    .then(() => {
      const remoteValue = getFlag(IndustryFeatureFlags.SubAgentsV2);
      getExecRuntimeConfig().setSubAgentsV2Enabled(remoteValue);

      if (remoteValue && !cachedValue) {
        logInfo('[initSubAgentsV2Flag] Sub-Agents V2 enabled (from remote)');
      }
    })
    .catch((error) => {
      logWarn(
        '[initSubAgentsV2Flag] failed to fetch remote Sub-Agents V2 flag',
        { cause: error }
      );
    });
}
