import chalk from 'chalk';
import { SemVer, valid as semverValid } from 'semver';

import { logInfo } from '@industry/logging';
import {
  Updater,
  UpdaterState,
  UpdaterStateType,
  UpdateOutcome,
} from '@industry/updater';

import { getEnv, getRuntimeAuthConfig } from '@/environment';
import { getI18n } from '@/i18n';
import { getCliRemoteConfig } from '@/services/update/getUpdateService';

import type { UpdateInfo } from '@industry/updater';

interface UpdateCommandOptions {
  check?: boolean;
  version?: string;
}

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function printManualUpdateInstructions(): void {
  const t = getI18n().t;
  const manualUpdateCommand =
    process.platform === 'win32'
      ? 'irm https://app.example.com/cli/windows | iex'
      : 'curl -fsSL https://app.example.com/cli | sh';

  writeStdout(chalk.gray(t('commands:update.manualUpdateHint')));
  writeStdout(chalk.cyan(`  ${manualUpdateCommand}`));
}

function createStateChangeHandler(versionRef: { value: string }) {
  return (state: UpdaterState): void => {
    const t = getI18n().t;
    switch (state.type) {
      case UpdaterStateType.Downloading:
        writeStdout(
          chalk.gray(
            t('commands:update.downloading', { version: versionRef.value })
          )
        );
        break;

      case UpdaterStateType.Verifying:
        writeStdout(chalk.gray(t('commands:update.verifying')));
        break;

      case UpdaterStateType.Installing:
        writeStdout(chalk.gray(t('commands:update.installing')));
        break;

      case UpdaterStateType.Error:
        writeStderr(
          chalk.red(
            t('commands:update.updateError', { message: state.error.message })
          )
        );
        break;

      default:
        break;
    }
  };
}

function resolvePlatform(): 'darwin' | 'linux' | 'windows' {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return process.platform;
    case 'win32':
      return 'windows';
    default:
      return process.platform as 'linux';
  }
}

function resolveArch(): 'x64' | 'arm64' | 'x64-baseline' {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (arch === 'x64' && process.env.IS_BASELINE === 'true') {
    return 'x64-baseline';
  }
  return arch;
}

function buildUpdateInfoForVersion(
  targetVersion: string,
  currentVersion: string
): UpdateInfo {
  const targetSemVer = new SemVer(targetVersion);
  const currentSemVer = new SemVer(currentVersion);
  const platform = resolvePlatform();
  const arch = resolveArch();
  const binaryName = process.platform === 'win32' ? 'drool.exe' : 'drool';
  const releasePath = `releases/${targetSemVer.toString()}/${platform}/${arch}`;

  return {
    version: targetSemVer,
    binPath: `${releasePath}/${binaryName}`,
    checksumPath: `${releasePath}/${binaryName}.sha256`,
    isRollback: targetSemVer.compare(currentSemVer) < 0,
  };
}

export async function run(options: UpdateCommandOptions): Promise<void> {
  const t = getI18n().t;
  const environment = getEnv();
  const { extras } = environment;

  if (!extras.autoUpdateEnabled) {
    writeStdout(chalk.yellow(t('commands:update.autoUpdateNotAvailable')));
    writeStdout(chalk.gray(t('commands:update.runNpmUpdate')));
    return;
  }

  if (getRuntimeAuthConfig().airgapEnabled) {
    writeStdout(
      chalk.yellow('Auto-update is disabled because Airgap Mode is enabled.')
    );
    return;
  }

  const currentVersion = process.env.CLI_VERSION;

  if (!currentVersion || !semverValid(currentVersion)) {
    writeStderr(chalk.yellow(t('commands:update.cannotDetermineVersion')));
    return;
  }

  writeStdout(chalk.bold(t('commands:update.title')));
  writeStdout(
    t('commands:update.currentVersion', {
      version: chalk.cyan(currentVersion),
    })
  );
  writeStdout('');

  const targetVersionRef = { value: '' };

  const updater = new Updater({
    currentVersion,
    binaryName: process.platform === 'win32' ? 'drool.exe' : 'drool',
    remoteConfig: getCliRemoteConfig(),
    deploymentEnv: environment.deploymentEnv,
    onStateChange: createStateChangeHandler(targetVersionRef),
  });

  const isTargetedUpdate = !!options.version;
  let updateInfo: UpdateInfo | null;

  if (options.version) {
    if (!semverValid(options.version)) {
      writeStderr(
        chalk.red(
          t('commands:update.invalidVersionFormat', {
            version: options.version,
          })
        )
      );
      writeStdout(chalk.gray(t('commands:update.validSemverHint')));
      process.exit(1);
      return;
    }
    updateInfo = buildUpdateInfoForVersion(options.version, currentVersion);
  } else {
    writeStdout(chalk.gray(t('commands:update.checkingForUpdates')));
    updateInfo = await updater.checkForUpdates();
  }

  if (!updateInfo) {
    writeStdout(chalk.green(t('commands:update.alreadyUpToDate')));
    return;
  }

  const targetVersion = updateInfo.version.version;
  targetVersionRef.value = targetVersion;

  if (options.check) {
    writeStdout(
      `${chalk.yellow('!')} ${t('commands:update.updateAvailable', { version: chalk.cyan(targetVersion) })}`
    );
    if (updateInfo.isRollback) {
      writeStdout(chalk.yellow(t('commands:update.rollbackNote')));
    }
    writeStdout('');
    writeStdout(chalk.gray(t('commands:update.runWithoutCheck')));
    return;
  }

  if (isTargetedUpdate) {
    writeStdout(
      t('commands:update.updatingToVersion', {
        version: chalk.cyan(targetVersion),
      })
    );
  } else {
    writeStdout(
      t('commands:update.updatingFromTo', {
        from: chalk.cyan(currentVersion),
        to: chalk.cyan(targetVersion),
      })
    );
    if (updateInfo.isRollback) {
      writeStdout(chalk.yellow(t('commands:update.rollbackNote')));
    }
  }
  writeStdout('');

  logInfo('Starting manual update', { version: targetVersion });

  try {
    const outcome = await updater.performUpdate(updateInfo, {
      launchUpdatedAsChild: false,
    });

    writeStdout('');

    if (outcome === UpdateOutcome.Updated) {
      writeStdout(
        chalk.green(
          t('commands:update.successfullyUpdated', {
            version: targetVersion,
          })
        )
      );
    } else if (outcome === UpdateOutcome.PendingRestart) {
      writeStdout(
        chalk.green(
          t('commands:update.updateStaged', { version: targetVersion })
        )
      );
      writeStdout(chalk.gray(t('commands:update.appliedOnNextLaunch')));
    } else if (outcome === UpdateOutcome.Skipped) {
      writeStdout(
        chalk.yellow(
          t('commands:update.updateSkipped', { version: targetVersion })
        )
      );
    } else if (outcome === UpdateOutcome.Error) {
      writeStderr(chalk.red(t('commands:update.updateFailed')));
      writeStdout('');
      printManualUpdateInstructions();
      process.exit(1);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeStderr(
      chalk.red(
        t('commands:update.updateFailedWithMessage', {
          message: errorMessage,
        })
      )
    );
    writeStdout('');
    printManualUpdateInstructions();
    process.exit(1);
  }
}
