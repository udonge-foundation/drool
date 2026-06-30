import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import * as path from 'path';

import { SemVer } from 'semver';

import {
  BinaryDownloadPlanSchema,
  UpdateArch,
  UpdatePlatform,
} from '@industry/common/updater';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { isErrnoException } from '@industry/utils/errors';

import { UpdateOutcome, UpdaterStateType } from './enums';
import { getRestartChildEnvironment, isBaselineBuild } from './environment';
import { preserveCurrentBinary } from './preservedBinary';
import {
  MAX_PENDING_UPDATE_ATTEMPTS,
  MAX_PENDING_UPDATE_AGE_MS,
} from './utils/constants';
import {
  setExecutablePermissions,
  setSecureDirectoryPermissions,
} from './utils/filePermissions';
import {
  deletePendingUpdateMarker,
  readPendingUpdateMarker,
  verifyStagedBinaryExists,
  writePendingUpdateMarker,
} from './utils/pendingUpdate';
import { renameWithRetry } from './utils/windowsRetry';

import type { PendingUpdateMarker, UpdateInfo, UpdaterConfig } from './types';
import type { BinaryDownloadPlan } from '@industry/common/updater';

const SIGNALS_TO_FORWARD: NodeJS.Signals[] =
  process.platform === 'win32'
    ? (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGQUIT'] as const)
    : (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const);

/**
 * Updater handles checking for new versions, downloading updates, and installing them.
 * Configurable for different applications and distribution methods.
 */
export class Updater {
  private currentVersion: SemVer;

  private platform: UpdatePlatform;

  private arch: UpdateArch;

  private stagedUpdatePath?: string;

  private stagedUpdateVersion?: string;

  private config: UpdaterConfig;

  public constructor(config: UpdaterConfig) {
    this.config = config;
    this.currentVersion = new SemVer(config.currentVersion);

    // Detect platform
    switch (process.platform) {
      case 'darwin':
        this.platform = UpdatePlatform.Darwin;
        break;
      case 'linux':
        this.platform = UpdatePlatform.Linux;
        break;
      case 'win32':
        this.platform = UpdatePlatform.Windows;
        break;
      default:
        throw new MetaError('Unsupported platform', {
          platform: process.platform,
        });
    }

    // Detect architecture
    this.arch = process.arch === 'arm64' ? UpdateArch.Arm64 : UpdateArch.X64;

    // Determine arch based on build-time flag
    // Baseline builds stay on the baseline channel, regular builds stay on regular channel
    if (this.arch === UpdateArch.X64 && isBaselineBuild()) {
      this.arch = UpdateArch.X64Baseline;
      logInfo('Using baseline update channel', {
        platform: this.platform,
        arch: this.arch,
      });
    }

    logInfo('Updater initialized', {
      currentVersion: this.currentVersion.version,
      platform: this.platform,
      arch: this.arch,
    });
  }

  getCurrentVersion(): string {
    return this.currentVersion.version;
  }

  /**
   * Check if the install directory (where the current binary lives) is writable.
   * Returns false when the binary is installed in a read-only location
   * (e.g. /usr/local/bin owned by root in a container), which means the update
   * would always fail with EACCES at rename/copy time.
   *
   * On Windows, updates are staged as pending and applied on next restart,
   * so write permission to the install directory is not required at update time.
   */
  private static async isTargetDirectoryWritable(): Promise<boolean> {
    if (process.platform === 'win32') {
      return true;
    }
    try {
      const targetDir = path.dirname(process.execPath);
      // eslint-disable-next-line no-bitwise -- combining POSIX permission flags
      await fs.access(targetDir, fsConstants.W_OK | fsConstants.X_OK);
      return true;
    } catch (err) {
      logWarn('Target directory not writable for update', { cause: err });
      return false;
    }
  }

  /**
   * Get full download URL by resolving relative path against base URL.
   */
  private getDownloadUrl(relativePath: string): string {
    const config = this.config.remoteConfig;
    if (!config.baseUrl) {
      throw new MetaError('Base URL not configured');
    }
    return new URL(relativePath, config.baseUrl).toString();
  }

  /**
   * Fetch binary download plan from backend API.
   * Returns presigned URLs or a baseUrl depending on environment.
   */
  private async fetchDownloadPlan(): Promise<BinaryDownloadPlan> {
    const config = this.config.remoteConfig;
    if (!config.apiUrl) {
      throw new MetaError('API URL not configured');
    }

    const binaryName = this.config.binaryName.replace('.exe', '');
    const params = new URLSearchParams({
      binaryName,
      platform: this.platform,
      arch: this.arch,
    });

    const url = `${config.apiUrl}/api/binary-download-plan?${params}`;

    logInfo('Fetching binary download plan from backend API', {
      url,
      platform: this.platform,
    });

    const response = await fetch(url);
    if (!response.ok) {
      throw new MetaError('Failed to fetch binary download plan', {
        statusCode: response.status,
        statusText: response.statusText,
        url,
      });
    }

    const json: unknown = await response.json();
    return BinaryDownloadPlanSchema.parse(json);
  }

  /**
   * Compare the current version against `/LATEST` and return update info if a new version is available.
   * Returns null if no update is available.
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    let latestVersionText: string;
    const { remoteConfig } = this.config;

    if (remoteConfig.apiUrl) {
      // API mode: backend resolves version and returns full download URLs
      const plan = await this.fetchDownloadPlan();
      latestVersionText = plan.version;
    } else {
      // HTTP/CDN mode: fetch LATEST directly
      const latestUrl = this.getDownloadUrl('LATEST');

      logInfo('Checking for updates via HTTP', {
        currentVersion: this.currentVersion.version,
        url: latestUrl,
        platform: this.platform,
      });

      const response = await fetch(latestUrl);
      if (!response.ok) {
        throw new MetaError('Failed to fetch latest version', {
          statusCode: response.status,
          statusText: response.statusText,
          url: latestUrl,
        });
      }
      latestVersionText = (await response.text()).trim();
    }

    const latestVersion = new SemVer(latestVersionText);

    const versionComparison = latestVersion.compare(this.currentVersion);

    // Skip update only if versions are exactly the same
    if (versionComparison === 0) {
      logInfo('Already on target version', {
        currentVersion: this.currentVersion.version,
        latestVersion: latestVersion.version,
      });
      return null;
    }

    // Construct the subpaths for the UpdateInfo return object
    const releasePath = `releases/${latestVersion.toString()}/${this.platform}/${this.arch}`;
    const binPath = `${releasePath}/${this.config.binaryName}`;
    const checksumFileName = `${this.config.binaryName}.sha256`;
    const checksumPath = `${releasePath}/${checksumFileName}`;

    const isRollback = versionComparison < 0;
    logInfo('Update available', {
      currentVersion: this.currentVersion.version,
      latestVersion: latestVersion.version,
      isRollback,
    });

    return {
      version: latestVersion,
      binPath,
      checksumPath,
      isRollback,
    };
  }

  /**
   * Download and stage an update for later installation.
   */
  async downloadAndStageUpdate(updateInfo: UpdateInfo): Promise<void> {
    // Create updates directory within INDUSTRY_DIR for staging updates
    const industryDir = path.join(getIndustryHome(), getIndustryDirName());
    const updatesDir =
      this.config.stagingDir || path.join(industryDir, 'updates');
    await fs.mkdir(updatesDir, { recursive: true });
    await setSecureDirectoryPermissions(updatesDir);

    if (this.config.onStateChange) {
      this.config.onStateChange({ type: UpdaterStateType.Downloading });
    }

    logInfo('Downloading update', {
      version: updateInfo.version.version,
    });

    try {
      // Resolve download URLs based on mode
      let binUrl: string;
      let checksumUrl: string;

      if (this.config.remoteConfig.apiUrl) {
        // API mode: use resolved URLs from backend
        const plan = await this.fetchDownloadPlan();
        // API mode: use resolved URLs from backend
        binUrl = plan.binaryUrl;
        checksumUrl = plan.checksumUrl;
      } else {
        // Direct baseUrl mode (production CDN)
        binUrl = this.getDownloadUrl(updateInfo.binPath);
        checksumUrl = this.getDownloadUrl(updateInfo.checksumPath);
      }

      // 1. Download the binary file
      logInfo('Downloading update binary', {
        version: updateInfo.version.version,
      });

      const binResponse = await fetch(binUrl);
      if (!binResponse.ok) {
        throw new MetaError('Failed to download update binary', {
          statusCode: binResponse.status,
          statusText: binResponse.statusText,
          url: binUrl,
        });
      }
      const binBuffer = Buffer.from(await binResponse.arrayBuffer());

      const tempBinPath = path.join(updatesDir, this.config.binaryName);
      await fs.writeFile(tempBinPath, binBuffer);

      // 2. Download and verify checksum
      if (this.config.onStateChange) {
        this.config.onStateChange({ type: UpdaterStateType.Verifying });
      }

      logInfo('Downloading and verifying checksum');

      const checksumResponse = await fetch(checksumUrl);
      if (!checksumResponse.ok) {
        throw new MetaError('Failed to download update checksum', {
          statusCode: checksumResponse.status,
          statusText: checksumResponse.statusText,
          url: checksumUrl,
        });
      }
      const checksumText = await checksumResponse.text();

      const expectedChecksum = checksumText.trim().split(' ')[0];
      const actualChecksum = createHash('sha256')
        .update(binBuffer)
        .digest('hex');

      if (expectedChecksum !== actualChecksum) {
        throw new MetaError('Checksum verification failed', {
          checksumExpected: expectedChecksum,
          checksumActual: actualChecksum,
        });
      }

      // 3. Copy file permissions from current executable
      const currentStats = await fs.stat(process.execPath);
      await fs.chmod(tempBinPath, currentStats.mode);

      // Store the staged update path and version for applyUpdate()
      this.stagedUpdatePath = tempBinPath;
      this.stagedUpdateVersion = updateInfo.version.version;

      logInfo('Update staged successfully', {
        stagedPath: this.stagedUpdatePath,
        version: this.stagedUpdateVersion,
      });
    } catch (error) {
      // Cleanup on error - legitimate recovery logic
      logWarn('Failed to download and stage update', {
        version: updateInfo.version.version,
        cause: error,
      });
      await fs.rm(updatesDir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Apply a previously staged update using atomic file replacement.
   * This method implements cross-platform atomic binary replacement strategies.
   * Returns true if update was applied and false otherwise.
   */
  async applyUpdate(): Promise<boolean> {
    if (!this.stagedUpdatePath) {
      throw new MetaError(
        'No update has been staged. Call downloadAndStageUpdate() first.'
      );
    }

    const currentExecutablePath = process.execPath;

    // Make sure that we only apply the update against the correct binary to prevent us from accidentally
    // overwriting the wrong executable when running in dev mode.
    if (
      path.basename(currentExecutablePath) !==
      path.basename(this.stagedUpdatePath)
    ) {
      throw new MetaError(
        'Should have skipped update - executable name mismatch (development mode)',
        {
          currentExecutable: currentExecutablePath,
          stagedExecutable: this.stagedUpdatePath,
        }
      );
    }

    if (this.config.onStateChange) {
      this.config.onStateChange({ type: UpdaterStateType.Installing });
    }

    try {
      if (this.platform === UpdatePlatform.Windows) {
        // Windows strategy: Stage update and defer installation to next startup.
        // Windows locks running executables, making in-place updates impossible.
        // Instead, we write a pending update marker that will be applied on next CLI startup.
        const industryDir = path.join(getIndustryHome(), getIndustryDirName());
        const updatesDir =
          this.config.stagingDir || path.join(industryDir, 'updates');

        const marker: PendingUpdateMarker = {
          version: this.stagedUpdateVersion || 'unknown',
          stagedPath: this.stagedUpdatePath,
          targetPath: currentExecutablePath,
          createdAt: new Date().toISOString(),
        };

        await writePendingUpdateMarker(updatesDir, marker);

        logInfo(
          'Windows update staged as pending - will apply on next restart',
          {
            version: marker.version,
            stagedPath: marker.stagedPath,
            targetPath: marker.targetPath,
          }
        );

        // Emit pending install state for UI feedback
        if (this.config.onStateChange) {
          this.config.onStateChange({
            type: UpdaterStateType.PendingInstall,
            version: marker.version,
          });
        }

        // Don't cleanup staged path - it's needed for the pending update
        // Return false to indicate update is pending, not applied
        return false;
      }
      // POSIX (Linux/macOS) strategy: Direct atomic rename
      // The running process continues using the old inode. Before we replace
      // the on-disk binary, copy the currently-running executable to a temp
      // directory and point INDUSTRY_DROOL_BINARY at it so any child processes
      // we spawn after this update (subagents, daemon, exec runners) keep
      // using the same version as this TUI for the rest of its lifetime.
      await preserveCurrentBinary();
      try {
        await fs.rename(this.stagedUpdatePath, currentExecutablePath);
      } catch (error) {
        // EXDEV: cross-device link not permitted - staged dir and target are on different filesystems
        // Fallback to copy + unlink pattern (not atomic but works cross-device)
        logWarn('Rename failed during update apply', { cause: error });
        if (isErrnoException(error) && error.code === 'EXDEV') {
          logInfo('Cross-device rename failed, using copy fallback', {
            stagedPath: this.stagedUpdatePath,
            targetPath: currentExecutablePath,
          });
          // Preserve mode bits from staged binary before copying
          const stagedStats = await fs.stat(this.stagedUpdatePath);
          let etxtbsyBackupPath: string | undefined;
          try {
            await fs.copyFile(this.stagedUpdatePath, currentExecutablePath);
          } catch (copyError) {
            logWarn('Copy failed during update apply', { cause: copyError });
            if (isErrnoException(copyError) && copyError.code === 'ETXTBSY') {
              // On Linux, copyFile to a running binary fails with ETXTBSY because
              // the kernel locks the inode. Rename the busy binary out of the way
              // first (the running process retains its fd), then copy the staged
              // binary to the now-free path.
              logInfo(
                'Target binary busy (ETXTBSY), renaming out of the way first'
              );
              etxtbsyBackupPath = `${currentExecutablePath}.old`;
              await fs.rename(currentExecutablePath, etxtbsyBackupPath);
              try {
                await fs.copyFile(this.stagedUpdatePath, currentExecutablePath);
              } catch (retryError) {
                // Restore backup on failure so the user isn't left without a binary
                await fs
                  .rename(etxtbsyBackupPath, currentExecutablePath)
                  .catch(() => {});
                throw retryError;
              }
            } else {
              throw copyError;
            }
          }
          await fs.chmod(currentExecutablePath, stagedStats.mode);
          await fs.unlink(this.stagedUpdatePath);
          // Clean up ETXTBSY backup after all install steps succeed
          if (etxtbsyBackupPath) {
            await fs.unlink(etxtbsyBackupPath).catch(() => {});
          }
        } else {
          throw error;
        }
      }

      // Ensure executable permissions are set
      await setExecutablePermissions(currentExecutablePath);

      // Cleanup staged path reference
      this.stagedUpdatePath = undefined;

      // Cleanup updates directory
      const industryDir = path.join(getIndustryHome(), getIndustryDirName());
      const updatesDir =
        this.config.stagingDir || path.join(industryDir, 'updates');
      await fs.rm(updatesDir, { recursive: true, force: true });
    } catch (error) {
      logWarn('Failed to apply update', {
        platform: this.platform,
        filePath: currentExecutablePath,
        stagedPath: this.stagedUpdatePath,
        cause: error,
      });
      throw error;
    }

    return true;
  }

  private emitCompleteState(version: string, skipped: boolean): void {
    if (this.config.onStateChange) {
      this.config.onStateChange({
        type: UpdaterStateType.Complete,
        version,
        skipped,
      });
    }
  }

  private shouldSkipRollback(updateInfo: UpdateInfo, context: string): boolean {
    if (!updateInfo.isRollback || !this.config.skipRollbacks) {
      return false;
    }
    logInfo('Rollback detected but rollbacks are disabled', {
      caller: context,
      currentVersion: this.currentVersion.version,
      latestVersion: updateInfo.version.version,
    });
    this.emitCompleteState(updateInfo.version.version, true);
    return true;
  }

  private async shouldSkipNotWritable(
    updateInfo: UpdateInfo,
    caller: string
  ): Promise<boolean> {
    if (await Updater.isTargetDirectoryWritable()) {
      return false;
    }
    logInfo('Skipping update - install directory not writable', {
      caller,
      directory: path.dirname(process.execPath),
      version: updateInfo.version.version,
    });
    this.emitCompleteState(updateInfo.version.version, true);
    return true;
  }

  private async runStagedUpdateFlow({
    updateInfo,
    caller,
    extraSuccessMetadata,
  }: {
    updateInfo: UpdateInfo;
    caller: string;
    extraSuccessMetadata?: Record<string, unknown>;
  }): Promise<UpdateOutcome.Updated | UpdateOutcome.PendingRestart> {
    if (this.config.onStateChange) {
      this.config.onStateChange({
        type: UpdaterStateType.UpdateAvailable,
        version: updateInfo.version.version,
      });
    }

    await this.downloadAndStageUpdate(updateInfo);

    const updated = await this.applyUpdate();

    if (!updated) {
      logInfo('Update staged as pending (Windows)', {
        caller,
        currentVersion: this.currentVersion.version,
        latestVersion: updateInfo.version.version,
        platform: this.platform,
      });
      return UpdateOutcome.PendingRestart;
    }

    this.emitCompleteState(updateInfo.version.version, false);

    logInfo('Update completed successfully', {
      caller,
      currentVersion: this.currentVersion.version,
      latestVersion: updateInfo.version.version,
      platform: this.platform,
      ...extraSuccessMetadata,
    });

    return UpdateOutcome.Updated;
  }

  private emitErrorState(error: unknown): void {
    if (this.config.onStateChange) {
      this.config.onStateChange({
        type: UpdaterStateType.Error,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Download, stage, and apply an update with optional process restart.
   * This method is useful when you want fine-grained control over the update process.
   *
   * @param updateInfo - Update information from checkForUpdates()
   * @param options - Options for the update process
   * @param options.launchUpdatedAsChild - Whether to relaunch the process after applying the update (default: true)
   * @returns The outcome of the update process
   */
  async performUpdate(
    updateInfo: UpdateInfo,
    options?: { launchUpdatedAsChild?: boolean }
  ): Promise<UpdateOutcome> {
    const { launchUpdatedAsChild = true } = options || {};

    try {
      if (this.shouldSkipRollback(updateInfo, 'perform update')) {
        return UpdateOutcome.Skipped;
      }

      if (await this.shouldSkipNotWritable(updateInfo, 'perform update')) {
        return UpdateOutcome.Skipped;
      }

      const outcome = await this.runStagedUpdateFlow({
        updateInfo,
        caller: 'perform update',
      });

      if (outcome === UpdateOutcome.Updated && launchUpdatedAsChild) {
        await Updater.launchUpdatedAsChild();
      }

      return outcome;
    } catch (error) {
      this.emitErrorState(error);

      logException(error, 'Update failed', {
        currentVersion: this.currentVersion.version,
        platform: this.platform,
      });

      return UpdateOutcome.Error;
    }
  }

  /**
   * Run the complete auto-update process.
   * This method handles all errors internally and reports them via onStateChange callback.
   * @returns The outcome of the update process for metrics reporting
   */
  async runAutoUpdate(): Promise<UpdateOutcome> {
    try {
      // Skip auto-update if executable name doesn't match (development mode)
      // Same check as in applyUpdate() to avoid downloading when we won't apply
      if (path.basename(process.execPath) !== this.config.binaryName) {
        logInfo(
          'Skipping auto-update - executable name mismatch (development mode)',
          {
            currentExecutable: process.execPath,
            stagedExecutable: this.config.binaryName,
          }
        );
        if (this.config.onStateChange) {
          this.config.onStateChange({ type: UpdaterStateType.NoUpdate });
        }
        return UpdateOutcome.NoUpdate;
      }

      logInfo('Starting auto-update', {
        currentVersion: this.currentVersion.version,
        platform: this.platform,
        arch: this.arch,
      });

      if (this.config.onStateChange) {
        this.config.onStateChange({ type: UpdaterStateType.Checking });
      }

      const updateInfo = await this.checkForUpdates();
      if (!updateInfo) {
        // No update available
        if (this.config.onStateChange) {
          this.config.onStateChange({ type: UpdaterStateType.NoUpdate });
        }
        return UpdateOutcome.NoUpdate;
      }

      if (this.shouldSkipRollback(updateInfo, 'check for updates')) {
        return UpdateOutcome.Skipped;
      }

      if (await this.shouldSkipNotWritable(updateInfo, 'check for updates')) {
        return UpdateOutcome.Skipped;
      }

      const outcome = await this.runStagedUpdateFlow({
        updateInfo,
        caller: 'check for updates',
        extraSuccessMetadata: { succeeded: true },
      });

      if (outcome === UpdateOutcome.PendingRestart) {
        return outcome;
      }

      // Flush logs/telemetry before restarting
      if (this.config.onBeforeRestart) {
        try {
          await this.config.onBeforeRestart();
        } catch (err) {
          logWarn('Pre-restart flush failed', { cause: err });
        }
      }

      // Relaunch the process
      await Updater.launchUpdatedAsChild();
      return UpdateOutcome.Updated;
    } catch (error) {
      this.emitErrorState(error);

      // Log the error but don't throw - this is a background operation
      logException(error, 'Auto-update failed', {
        currentVersion: this.currentVersion.version,
        platform: this.platform,
        succeeded: false,
      });

      return UpdateOutcome.Error;
    }
  }

  /**
   * Relaunch the current process with the same arguments and environment.
   * This method spawns a child process and keeps the parent alive as a TTY
   * shim that forwards signals and exits when the child exits.
   */
  public static async launchUpdatedAsChild(): Promise<void> {
    const currentExecutablePath = process.execPath;
    const args = process.argv.slice(2);
    const childEnv = getRestartChildEnvironment();

    logInfo('Restarting process after update', {
      currentExecutable: currentExecutablePath,
      cwd: process.cwd(),
    });

    const child = spawn(currentExecutablePath, args, {
      detached: false, // stay in same session/FG group
      stdio: 'inherit', // keep the same TTY FDs
      cwd: process.cwd(),
      env: childEnv,
    });

    child.on('error', (error) => {
      logException(error, 'Failed to spawn updated process', {
        currentExecutable: currentExecutablePath,
      });
      process.exit(1);
    });

    // Forward terminal signals so Ctrl+C still works
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch (error) {
          // Child likely died between check and kill - log and ignore error
          logWarn('Error forwarding signal to child process', {
            signal,
            cause: error,
          });
        }
      }
    };

    SIGNALS_TO_FORWARD.forEach((signal) => process.on(signal, forward));

    // Keep parent as group leader; exit when child exits
    child.on('exit', (code, signal) => {
      SIGNALS_TO_FORWARD.forEach((sig) => process.off(sig, forward));
      if (signal) {
        try {
          process.kill(process.pid, signal);
        } catch (error) {
          logException(error, 'Failed to forward signal to parent');
        }
      }
      process.exit(code ?? 0);
    });

    // Block forever; parent acts as shim to preserve TTY state
    await new Promise<never>(() => {});
  }

  /**
   * Apply a pending Windows update that was staged during a previous session.
   * This should be called early in startup, before any other operations,
   * when the binary is no longer locked.
   *
   * @returns Object with applied status, version if applied, and optional error
   */
  public static async applyPendingWindowsUpdate(): Promise<{
    applied: boolean;
    version?: string;
    error?: Error;
  }> {
    // Only applicable on Windows
    if (process.platform !== 'win32') {
      return { applied: false };
    }

    const industryDir = path.join(getIndustryHome(), getIndustryDirName());
    const updatesDir = path.join(industryDir, 'updates');

    let marker: PendingUpdateMarker | null = null;
    try {
      marker = await readPendingUpdateMarker(updatesDir);

      if (!marker) {
        return { applied: false };
      }

      // Check if marker is stale (older than MAX_PENDING_UPDATE_AGE_MS)
      const markerAge = Date.now() - new Date(marker.createdAt).getTime();
      if (markerAge > MAX_PENDING_UPDATE_AGE_MS) {
        logWarn('Pending update marker is stale, cleaning up', {
          version: marker.version,
          createdAt: new Date(marker.createdAt).getTime(),
          durationMs: markerAge,
        });
        await deletePendingUpdateMarker(updatesDir);
        await fs
          .rm(updatesDir, { recursive: true, force: true })
          .catch(() => {});
        return { applied: false };
      }

      // Check if max retry attempts have been exceeded
      const failedAttempts = marker.failedAttempts ?? 0;
      if (failedAttempts >= MAX_PENDING_UPDATE_ATTEMPTS) {
        logWarn('Pending update exceeded max retry attempts, cleaning up', {
          version: marker.version,
          failedAttempts,
          maxAttempts: MAX_PENDING_UPDATE_ATTEMPTS,
        });
        await deletePendingUpdateMarker(updatesDir);
        await fs
          .rm(updatesDir, { recursive: true, force: true })
          .catch(() => {});
        return {
          applied: false,
          error: new MetaError(
            'Pending update failed after max retry attempts',
            {
              failedAttempts,
              maxAttempts: MAX_PENDING_UPDATE_ATTEMPTS,
            }
          ),
        };
      }

      logInfo('Found pending Windows update, applying', {
        version: marker.version,
        stagedPath: marker.stagedPath,
        targetPath: marker.targetPath,
        attempt: failedAttempts + 1,
      });

      // Verify staged binary still exists
      const stagedExists = await verifyStagedBinaryExists(marker.stagedPath);
      if (!stagedExists) {
        logWarn('Staged binary not found, cleaning up marker', {
          stagedPath: marker.stagedPath,
        });
        await deletePendingUpdateMarker(updatesDir);
        return {
          applied: false,
          error: new Error('Staged binary not found'),
        };
      }

      // Now we can safely apply the update since the old binary is not running
      const backupPath = `${marker.targetPath}.old`;

      // Step 1: Rename current executable to backup with retry logic
      await renameWithRetry(marker.targetPath, backupPath, 'windows');

      try {
        // Step 2: Copy staged update to target location
        await fs.copyFile(marker.stagedPath, marker.targetPath);

        // Ensure executable permissions are set
        await setExecutablePermissions(marker.targetPath);

        // Step 3: Delete the staged update and marker
        await fs.unlink(marker.stagedPath);
        await deletePendingUpdateMarker(updatesDir);

        // Clean up updates directory
        await fs.rm(updatesDir, { recursive: true, force: true }).catch(() => {
          // Ignore cleanup errors
        });

        // Clean up backup file
        await fs.unlink(backupPath).catch(() => {
          // Ignore cleanup errors - backup can be left behind
        });

        logInfo('Successfully applied pending Windows update', {
          version: marker.version,
        });

        return { applied: true, version: marker.version };
      } catch (error) {
        // Rollback: restore original executable
        logWarn('Rolling back pending update after failure', {
          backupPath,
          targetPath: marker.targetPath,
          cause: error,
        });
        await renameWithRetry(backupPath, marker.targetPath, 'windows');
        throw error;
      }
    } catch (error) {
      // Increment failed attempts counter so we don't retry indefinitely
      const currentAttempts = marker?.failedAttempts ?? 0;
      if (marker) {
        try {
          await writePendingUpdateMarker(updatesDir, {
            ...marker,
            failedAttempts: currentAttempts + 1,
          });
        } catch (err) {
          // Best-effort: if we can't write the marker, the next startup
          // will still read the old one and eventually hit the max retry limit
          logWarn('Failed to update pending update marker', { cause: err });
        }
      }

      logException(error, 'Failed to apply pending Windows update (updater)', {
        attempt: currentAttempts + 1,
        maxAttempts: MAX_PENDING_UPDATE_ATTEMPTS,
      });
      return {
        applied: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
