import { MetaError } from '@industry/logging';
import {
  Updater,
  RemoteConfig,
  UpdaterState,
  UpdaterStateType,
} from '@industry/updater';

import { getEnv } from '@/environment';
import { getI18n } from '@/i18n';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import { TerminalSpinner, createSpinner } from '@/utils/terminalSpinner';

/**
 * Build the remote config for the CLI updater based on the current environment.
 * Production tiers use the public CDN; development uses the backend API.
 */
export function getCliRemoteConfig(): RemoteConfig {
  const environment = getEnv();
  return environment.isProductionTier
    ? {
        baseUrl: `https://${environment.downloadsBucket}/${environment.downloadsPathPrefix}industry-cli/`,
      }
    : {
        apiUrl: environment.apiBaseUrl,
      };
}

let updateServiceInstance: Updater | null = null;

// Track the last error from blocking updates for metric reporting
let lastBlockingUpdateError: Error | null = null;

export function getLastBlockingUpdateError(): Error | null {
  return lastBlockingUpdateError;
}

export function setLastBlockingUpdateError(error: Error | null): void {
  lastBlockingUpdateError = error;
}

/**
 * Get or create the singleton UpdateService instance.
 *
 * This wrapper configures the updater with:
 * - CLI-specific binary name (drool/drool.exe)
 * - Environment-based remote config (prod CDN vs dev S3 vs preprod)
 * - Terminal spinner UI integration via state callbacks
 */

export function getUpdateService(): Updater {
  if (!updateServiceInstance) {
    let spinner: TerminalSpinner | null = null;
    const environment = getEnv();

    updateServiceInstance = new Updater({
      currentVersion: process.env.CLI_VERSION || '',
      binaryName: process.platform === 'win32' ? 'drool.exe' : 'drool',
      remoteConfig: getCliRemoteConfig(),
      deploymentEnv: environment.deploymentEnv,
      onBeforeRestart: async () => {
        await CliTelemetryClient.getInstance().forceFlush();
      },
      onStateChange: (state: UpdaterState) => {
        const t = getI18n().t;
        switch (state.type) {
          case UpdaterStateType.Checking:
            if (!spinner) {
              spinner = createSpinner({
                message: t('common:updateSpinner.checking'),
              });
              spinner.start();
            }
            break;

          case UpdaterStateType.NoUpdate:
            if (spinner) {
              spinner.stopWithMessage(
                t('common:updateSpinner.alreadyUpToDate')
              );
            }
            break;

          case UpdaterStateType.UpdateAvailable:
            if (spinner) {
              spinner.updateMessage(
                t('common:updateSpinner.updatingToVersion', {
                  version: state.version,
                })
              );
            }
            break;

          case UpdaterStateType.Downloading:
            if (spinner) {
              spinner.updateMessage(t('common:updateSpinner.downloading'));
            }
            break;

          case UpdaterStateType.Verifying:
            if (spinner) {
              spinner.updateMessage(t('common:updateSpinner.verifying'));
            }
            break;

          case UpdaterStateType.Installing:
            if (spinner) {
              spinner.updateMessage(t('common:updateSpinner.installing'));
            }
            break;

          case UpdaterStateType.Complete:
            if (spinner) {
              const message = state.skipped
                ? t('common:updateSpinner.skippedUpdate', {
                    version: state.version,
                  })
                : t('common:updateSpinner.successfullyUpdated', {
                    version: state.version,
                  });
              spinner.stopWithMessage(message);
            }
            break;

          case UpdaterStateType.Error:
            // Track error for metric reporting
            lastBlockingUpdateError = state.error;
            if (spinner) {
              const manualUpdateCommand =
                process.platform === 'win32'
                  ? 'irm https://app.example.com/cli/windows | iex'
                  : 'curl -fsSL https://app.example.com/cli | sh';
              spinner.stopWithError(
                t('common:updateSpinner.autoUpdateFailed', {
                  command: manualUpdateCommand,
                })
              );
            }
            break;

          case UpdaterStateType.PendingInstall:
            // Windows only: update staged, will apply on next restart
            if (spinner) {
              spinner.stopWithMessage(
                t('common:updateSpinner.pendingInstall', {
                  version: state.version,
                })
              );
            }
            break;
          default:
            throw new MetaError('Unknown updater state type:', {
              type: (state as UpdaterState).type,
            });
        }
      },
    });
  }

  return updateServiceInstance;
}
