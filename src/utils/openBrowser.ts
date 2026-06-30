import { logException } from '@industry/logging';

/**
 * Safely opens a URL in the browser without crashing on failure.
 * Returns true if the browser was likely opened, false otherwise.
 *
 * This function prevents crashes in SSH sessions or when xdg-utils is not installed
 * on Linux by properly handling subprocess error events.
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    const open = (await import('open')).default;
    const subprocess = await open(url);

    // Critical: Attach error handler to prevent unhandled error event crash
    // This prevents Node.js from crashing when xdg-open is not found on Linux
    if (subprocess) {
      subprocess.on('error', (error) => {
        logException(error, 'Browser subprocess error', { url });
      });
    }

    // The browser was launched (though we can't know if it fully succeeded)
    return true;
  } catch (error) {
    // Failed to even start the subprocess
    logException(error, 'Failed to launch browser', { url });
    return false;
  }
}
