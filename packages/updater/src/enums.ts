/**
 * Update state types enum.
 */
export enum UpdaterStateType {
  Checking = 'checking',
  NoUpdate = 'no-update',
  UpdateAvailable = 'update-available',
  Downloading = 'downloading',
  Verifying = 'verifying',
  Installing = 'installing',
  Complete = 'complete',
  Error = 'error',
  PendingInstall = 'pending-install', // Windows: staged, needs restart to apply
}

/**
 * Update outcome enum for metrics reporting.
 */
export enum UpdateOutcome {
  Updated = 'updated',
  NoUpdate = 'no-update',
  Skipped = 'skipped',
  Error = 'error',
  BackgroundInProgress = 'background-in-progress',
  PendingRestart = 'pending-restart', // Windows: update staged, restart needed
  UpdatedNoRestart = 'updated-no-restart', // POSIX: updated on disk, restart intentionally skipped
}

/**
 * Categories of update failures with distinct, actionable remediation paths.
 * Produced by `classifyUpdateError`; consumed by UIs to pick the right
 * user-facing message.
 */
export enum UpdateErrorCategory {
  /**
   * File/directory is busy or locked (e.g., another drool process running,
   * Windows antivirus scanning the binary). Typically transient — retry
   * after closing other instances usually works.
   */
  FileLocked = 'file_locked',

  /**
   * Writing to disk was denied by the OS (EACCES / EPERM after retries).
   * Could be a stale updates directory with bad permissions, a policy
   * restriction (AppLocker, WDAC, FSLogix), or SYSTEM-owned leftover files.
   * Unlike FileLocked, this does not resolve on its own.
   */
  PermissionDenied = 'permission_denied',

  /**
   * No space left on the device (ENOSPC).
   */
  DiskFull = 'disk_full',

  /**
   * Networking issue — couldn't reach the download host, TLS failure,
   * DNS resolution failure, HTTP error from the CDN/API, etc.
   */
  Network = 'network',

  /**
   * Downloaded binary failed checksum/signature verification.
   * Not retryable by the user; likely a bad release or tampering.
   */
  VerificationFailed = 'verification_failed',

  /**
   * Anything we don't recognise — fall back to the raw error message.
   */
  Unknown = 'unknown',
}
