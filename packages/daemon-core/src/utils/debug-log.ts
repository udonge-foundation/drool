/**
 * Debug logger that writes directly to process.stdout, bypassing
 * any console patching (e.g., the CLI's patch-console.ts which
 * redirects console.* to a file).
 *
 * Used by daemon-core components when `debug: true` to provide
 * visible terminal output for operators running `drool daemon --debug`.
 *
 * Writes are wrapped in a try/catch because process.stdout can be in a
 * broken/closed state when the daemon is spawned by a parent (Electron on
 * packaged Windows builds, or a developer's parent shell that has exited).
 * Letting EPIPE bubble up turns into an uncaughtException that exits the
 * daemon with code 1 -- the exact failure mode of the macOS dev-install
 * cluster we identified in the 0.71.1 crash investigation.
 */
export function debugLog(
  message: string,
  metadata?: Record<string, unknown>
): void {
  const ts = new Date().toISOString();
  const meta =
    metadata && Object.keys(metadata).length > 0
      ? ` ${JSON.stringify(metadata)}`
      : '';
  try {
    process.stdout.write(`[${ts}] DEBUG: ${message}${meta}\n`);
    // eslint-disable-next-line industry/require-catch-handling
  } catch {
    // best-effort; debug logging must never crash the host process
  }
}
