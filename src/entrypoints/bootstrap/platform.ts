/**
 * Platform bootstrap layer — OS-specific cleanup and setup.
 *
 * Handles: Windows pending update, POSIX stale binary cleanup,
 * system certificates.
 */
import { logException, logInfo, logWarn } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { withStartupLatency } from '@/utils/startupLatency';
import { loadSystemCertificates } from '@/utils/systemCertificates';

export async function bootstrapPlatform(): Promise<void> {
  // Windows pending update / POSIX stale binary cleanup
  if (process.platform === 'win32') {
    const { Updater } = await import('@industry/updater');
    const pendingResult = await withStartupLatency(
      Metric.CLI_STARTUP_PENDING_UPDATE_APPLY_LATENCY,
      () => Updater.applyPendingWindowsUpdate(),
      (result) => ({
        status: result.applied ? 'applied' : result.error ? 'error' : 'skipped',
      })
    );
    if (pendingResult.applied) {
      logInfo('[bootstrap] Applied pending Windows update', {
        version: pendingResult.version,
      });
    } else if (pendingResult.error) {
      logWarn('[bootstrap] Failed to apply pending Windows update', {
        cause: pendingResult.error,
      });
    }
  } else {
    void import('@industry/updater')
      .then(({ cleanupStalePreservedBinaries }) =>
        cleanupStalePreservedBinaries()
      )
      .catch((error) => {
        logException(error, '[bootstrap] cleanupStalePreservedBinaries failed');
      });
  }

  // System certificates
  await withStartupLatency(Metric.CLI_STARTUP_CERTIFICATES_LATENCY, () =>
    loadSystemCertificates()
  );
}
