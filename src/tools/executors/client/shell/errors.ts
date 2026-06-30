/**
 * Error thrown by the Node-side git executor when a secret scan cannot
 * reliably be performed (e.g. the staged/push diff exceeds the configured
 * `SECRET_SCANNER_MAX_BUFFER`). Callers MUST convert this into a
 * user-visible block — silently returning "no findings" is a fail-open
 * regression of Drool-Shield.
 *
 * TODO(FAC-18955): Replace the current execFile-based implementation with
 * a streaming `spawn` + chunked scanner so we can scan arbitrarily large
 * diffs without ever hitting this limit. Tracked as a follow-up PR since
 * it is a meaningfully larger change than the fail-closed fix here.
 */
export class ScanUnavailableError extends Error {
  readonly reason: 'maxBuffer';

  constructor(message: string, reason: 'maxBuffer' = 'maxBuffer') {
    super(message);
    this.name = 'ScanUnavailableError';
    this.reason = reason;
  }
}
