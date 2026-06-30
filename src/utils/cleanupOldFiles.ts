import * as fs from 'fs';
import * as path from 'path';

/**
 * Clean up old temporary files (older than 48 hours) from the specified directory.
 * This runs on exit to prevent gradual accumulation of stale temp files.
 * Errors are silently ignored to never prevent exit.
 *
 * @param tempDirPath - Absolute path to the temp directory to clean up
 * @param timeoutMs - Maximum time to spend on cleanup in milliseconds (default: 5000ms)
 */
export async function cleanupOldFiles(
  tempDirPath: string,
  timeoutMs: number = 5000
): Promise<void> {
  const cleanupPromise = (async () => {
    try {
      if (!fs.existsSync(tempDirPath)) return;

      const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
      const now = Date.now();

      // Get all subdirectories in temp folder
      const subdirs = fs
        .readdirSync(tempDirPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

      // Clean up old files in each subdirectory
      for (const subdir of subdirs) {
        const subdirPath = path.join(tempDirPath, subdir);
        const entries = fs.readdirSync(subdirPath, { withFileTypes: true });

        for (const entry of entries) {
          const entryPath = path.join(subdirPath, entry.name);
          const stats = fs.statSync(entryPath);

          // Remove if older than 48 hours
          if (now - stats.mtimeMs > MAX_AGE_MS) {
            if (entry.isDirectory()) {
              fs.rmSync(entryPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(entryPath);
            }
          }
        }
      }
    } catch {
      // Silently ignore cleanup errors - don't prevent exit
    }
  })();

  // Race between cleanup and timeout
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => resolve(), timeoutMs);
  });

  await Promise.race([cleanupPromise, timeoutPromise]);
}
