import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';

import { EnvironmentVariable, parsePositiveIntEnv } from '@industry/environment';
import { rotateLogFileIfNeededSync } from '@industry/logging/node/log-rotation';

const LOG_FILE_NAME = 'console.log';
/**
 * Default per-fragment size cap for the patched `console.*` sink.
 * Smaller than the telemetry log default because console traffic is
 * dominated by repeated UI render diagnostics; 25 MB is enough to
 * capture a single very long interactive day before within-day
 * fragmenting kicks in.
 */
const DEFAULT_CONSOLE_LOG_MAX_BYTES_PER_FRAGMENT = 25 * 1024 * 1024;
/** Default number of distinct days of console logs to retain. */
const DEFAULT_CONSOLE_LOG_MAX_DAYS = 30;
/**
 * Default total-byte cap for console logs. Tighter than the telemetry
 * default because console traffic is verbose and noisy.
 */
const DEFAULT_CONSOLE_LOG_MAX_TOTAL_BYTES = 250 * 1024 * 1024;

// This IIFE runs before initializeEnvironment(), so we cannot use
// getIndustryDirName() (which calls getEnv()). Read process.env directly
// via the shared parsePositiveIntEnv helper from @industry/environment.
const INDUSTRY_DIR =
  (process.env.INDUSTRY_ENV || process.env.NEXT_PUBLIC_ENV) === 'production'
    ? '.industry'
    : '.industry-dev';

// Resolve the user-home root the rest of the CLI will use. This runs before
// initializeEnvironment(), so we cannot call getIndustryDir(); reproduce the
// same precedence here so e2e tests (which pass INDUSTRY_HOME_OVERRIDE) and
// users running with a custom HOME both see console.log rotated in the
// expected directory rather than against the real home.
function resolveUserHome(): string {
  const override = process.env.INDUSTRY_HOME_OVERRIDE;
  if (override && override.length > 0) return override;
  return os.homedir();
}

// Patch console methods to write to a file instead of stdout/stderr
(() => {
  try {
    const industryDir = path.join(resolveUserHome(), INDUSTRY_DIR);
    const logsDir = path.join(industryDir, 'logs');
    if (!fs.existsSync(industryDir))
      fs.mkdirSync(industryDir, { recursive: true });
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const logFilePath = path.join(logsDir, LOG_FILE_NAME);

    const consoleLogMaxBytesPerFragment =
      parsePositiveIntEnv(
        process.env[EnvironmentVariable.INDUSTRY_LOG_MAX_BYTES]
      ) ?? DEFAULT_CONSOLE_LOG_MAX_BYTES_PER_FRAGMENT;
    const consoleLogMaxDays =
      parsePositiveIntEnv(
        process.env[EnvironmentVariable.INDUSTRY_LOG_MAX_DAYS]
      ) ?? DEFAULT_CONSOLE_LOG_MAX_DAYS;
    const consoleLogMaxTotalBytes =
      parsePositiveIntEnv(
        process.env[EnvironmentVariable.INDUSTRY_LOG_MAX_TOTAL_BYTES]
      ) ?? DEFAULT_CONSOLE_LOG_MAX_TOTAL_BYTES;
    const rotationOptions = {
      maxBytesPerFragment: consoleLogMaxBytesPerFragment,
      maxDays: consoleLogMaxDays,
      maxTotalBytes: consoleLogMaxTotalBytes,
    } as const;

    // Eagerly run a rotation pass on every process start so a quiet
    // TUI startup (no patched console.* calls) still triggers daily
    // rollover and prunes oversized history.
    try {
      rotateLogFileIfNeededSync(logFilePath, rotationOptions);
    } catch {
      // Swallow: rotation must never block CLI startup.
    }

    let writing = false;
    let writesSinceRotationCheck = 1;
    const ROTATION_CHECK_INTERVAL_WRITES = 256;

    const writeLine = (level: string, message: string) => {
      try {
        if (writesSinceRotationCheck === 0) {
          rotateLogFileIfNeededSync(logFilePath, rotationOptions);
        }
        writesSinceRotationCheck =
          (writesSinceRotationCheck + 1) % ROTATION_CHECK_INTERVAL_WRITES;

        const ts = new Date().toISOString();
        fs.appendFileSync(
          logFilePath,
          `[${ts}] ${level.toUpperCase()}: ${message}\n`
        );
      } catch {
        // Swallow to avoid recursion or crashing on logging errors
      }
    };

    const formatArgs = (args: unknown[]): string => {
      try {
        return util.format(...args);
      } catch {
        try {
          return args
            .map((a) => {
              try {
                return typeof a === 'string'
                  ? a
                  : util.inspect(a, { depth: 3 });
              } catch {
                return String(a);
              }
            })
            .join(' ');
        } catch {
          return '[unformattable arguments]';
        }
      }
    };

    const makeHandler =
      (level: string) =>
      (...args: unknown[]) => {
        if (writing) return; // prevent reentrancy
        writing = true;
        try {
          writeLine(level, formatArgs(args));
        } finally {
          writing = false;
        }
      };

    // eslint-disable-next-line no-console -- PLT-76: migrated from file-level disable
    console.log = makeHandler('info');
    // eslint-disable-next-line no-console -- PLT-76: migrated from file-level disable
    console.info = makeHandler('info');
    // eslint-disable-next-line no-console -- PLT-76: migrated from file-level disable
    console.debug = makeHandler('debug');
    // eslint-disable-next-line no-console -- PLT-76: migrated from file-level disable
    console.warn = makeHandler('warn');
    // eslint-disable-next-line no-console -- PLT-76: migrated from file-level disable
    console.error = makeHandler('error');
    // eslint-disable-next-line no-console -- PLT-76: migrated from file-level disable
    console.trace = (...args: unknown[]) => {
      if (writing) return;
      writing = true;
      try {
        const err = new Error(formatArgs(args));
        const stack = err.stack || '';
        writeLine('trace', stack);
      } finally {
        writing = false;
      }
    };
    // eslint-disable-next-line no-console -- PLT-76: migrated from file-level disable
    console.dir = (item?: unknown, options?: unknown) => {
      if (writing) return;
      writing = true;
      try {
        const msg = util.inspect(item, { ...(options || {}), depth: 4 });
        writeLine('dir', msg);
      } finally {
        writing = false;
      }
    };
    // eslint-disable-next-line no-console -- PLT-76: migrated from file-level disable
    console.assert = (value?: unknown, ...args: unknown[]) => {
      if (value) return;
      if (writing) return;
      writing = true;
      try {
        writeLine('assert', `Assertion failed: ${formatArgs(args)}`);
      } finally {
        writing = false;
      }
    };
  } catch {
    // If patching fails for any reason, do nothing and preserve normal console behavior
  }
})();
