/**
 * Windows Console UTF-8 Encoding Setup
 *
 * This module handles setting up proper UTF-8 encoding for Windows console
 * to prevent garbled character rendering when using ANSI escape sequences
 * and Unicode characters.
 *
 * Background:
 * - Windows console defaults to the OEM code page (often CP437 or CP850)
 * - Unicode characters and ANSI escape sequences require UTF-8 (CP 65001)
 * - Without proper encoding, characters like ⠴, ✓, ◌, etc. appear garbled
 */

import { execSync } from 'child_process';

import { logException, logInfo, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { classifyStartupProcess } from '@/utils/startupProcess';

function getSkipReason(): string | null {
  const context = classifyStartupProcess();
  if (!context.isInteractiveTty) {
    return 'non-tty';
  }
  if (context.isDroolWorkerProcess) {
    return 'internal-worker';
  }
  return null;
}

/**
 * Sets the Windows console code page to UTF-8 (65001) to ensure proper
 * rendering of Unicode characters and ANSI escape sequences.
 *
 * This prevents garbled characters like:
 * - "â tm" instead of "⠴" (Braille spinner)
 * - "[âŹ+ 2s]" instead of proper timing display
 * - "◌" instead of "•" (bullet points)
 *
 * Only runs on Windows (win32) platform.
 */
export function setupWindowsConsoleEncoding(): void {
  // Only run on Windows
  if (process.platform !== 'win32') {
    return;
  }

  const start = performance.now();
  let attempted = false;
  let outcome = 'skipped';
  const skippedReason = getSkipReason();

  if (!skippedReason) {
    attempted = true;
    try {
      // Set console input and output code page to UTF-8 (65001)
      // This needs to be done via child process since Node.js doesn't expose
      // the Windows SetConsoleCP and SetConsoleOutputCP APIs directly
      execSync('chcp 65001 >nul 2>&1', {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000, // 5 second timeout to prevent hanging
      });

      logInfo('Windows console code page set to UTF-8 (65001)');
      outcome = 'success';
    } catch (error) {
      // Log but don't fail - the CLI should still work, just with potential
      // garbled characters
      logException(
        error instanceof Error ? error : new Error(String(error)),
        'Failed to set Windows console code page to UTF-8'
      );
      outcome = 'error';
    }
  }

  // Also set Node.js stdout/stderr encoding to UTF-8
  // This ensures Node.js properly encodes Unicode characters when writing
  try {
    if (process.stdout.setDefaultEncoding) {
      process.stdout.setDefaultEncoding('utf8');
    }
    if (process.stderr.setDefaultEncoding) {
      process.stderr.setDefaultEncoding('utf8');
    }
  } catch (error) {
    // This should rarely fail, but log if it does
    logException(
      error instanceof Error ? error : new Error(String(error)),
      'Failed to set Node.js stdout/stderr encoding to UTF-8'
    );
  }

  Metrics.addToCounter(
    Metric.WINDOWS_CONSOLE_ENCODING_LATENCY_MS,
    performance.now() - start,
    {
      attempted,
      outcome,
      ...(skippedReason && { skippedReason }),
    }
  );
}
