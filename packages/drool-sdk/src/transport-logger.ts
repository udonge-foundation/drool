import fs from 'fs';
import path from 'path';

import { EnvironmentVariable, resolveEnv } from '@industry/environment';
import { logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { TransportDirection } from './enums';

const LOG_FILE_NAME = 'drool-transport.log';
// Transport frames can contain raw JSON-RPC payloads (including tool inputs
// and outputs), so restrict permissions to the current user only.
const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

interface TransportLoggerState {
  stream: fs.WriteStream | null;
  // When true, all future writes are silently ignored (e.g. after an error).
  failed: boolean;
}

// Module-level cache: initialised lazily on first message when enabled.
let state: TransportLoggerState | null = null;
let enabledCache: boolean | null = null;

// Captured once per host process so every line carries the same host pid tag.
const HOST_PID_TAG = `host_pid=${process.pid}`;

function isTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

function directionMarker(direction: TransportDirection): string {
  // IN is padded to 3 chars so that it column-aligns with OUT for the
  // common case. OUT! is intentionally wider -- failed sends should stand
  // out visually when scanning the log.
  switch (direction) {
    case TransportDirection.In:
      return 'IN ';
    case TransportDirection.Out:
      return 'OUT';
    case TransportDirection.OutFailed:
      return 'OUT!';
    default:
      return '???';
  }
}

/**
 * Check whether transport logging is enabled via env var. The result is
 * cached on first access for performance (env vars don't change mid-run).
 *
 * @public
 */
export function isTransportLoggingEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  enabledCache = isTruthy(
    resolveEnv({
      name: EnvironmentVariable.INDUSTRY_DROOL_SDK_TRANSPORT_LOG,
      fallback: '',
    }) ?? ''
  );
  return enabledCache;
}

/**
 * Returns true if `value` looks like a file path rather than a truthy flag
 * (e.g. `1`, `true`). Accepts POSIX (`/`), Windows (`\`), relative (`.`),
 * tilde (`~`), and absolute Windows drive paths (`C:/...`, `C:\...`).
 */
function looksLikePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    value.startsWith('~') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\') ||
    value.includes('/') ||
    value.includes('\\')
  );
}

/**
 * Resolve the log file path. If the env var value looks like a path
 * (absolute, relative, or tilde-prefixed), use it directly. Otherwise
 * resolve to `<industryHome>/<industryDirName>/logs/drool-transport.log`.
 *
 * `getIndustryHome()` is used instead of `os.homedir()` so that wrapper
 * scripts and tests running with `INDUSTRY_HOME_OVERRIDE` set emit the log
 * into the isolated home rather than the real one.
 */
function resolveLogPath(): string {
  const envValue = resolveEnv({
    name: EnvironmentVariable.INDUSTRY_DROOL_SDK_TRANSPORT_LOG,
  });
  if (envValue && looksLikePath(envValue)) {
    if (
      envValue === '~' ||
      envValue.startsWith('~/') ||
      envValue.startsWith('~\\')
    ) {
      const rest = envValue.slice(2); // drop '~' and its following separator
      return rest ? path.join(getIndustryHome(), rest) : getIndustryHome();
    }
    return envValue;
  }

  return path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'logs',
    LOG_FILE_NAME
  );
}

function initState(): TransportLoggerState {
  const result: TransportLoggerState = { stream: null, failed: false };
  try {
    const logPath = resolveLogPath();
    const logsDir = path.dirname(logPath);
    const logsDirExisted = fs.existsSync(logsDir);
    if (!logsDirExisted) {
      fs.mkdirSync(logsDir, { recursive: true, mode: LOG_DIR_MODE });
    }
    // Only chmod directories we just created. The `mode` passed to
    // `mkdirSync` is subject to the umask, which may strip bits we want,
    // so an explicit chmod on fresh directories is worthwhile. We avoid
    // touching any pre-existing directory because users can point the log
    // at an arbitrary path (e.g. `$HOME/Downloads` or `/tmp`) and silently
    // tightening permissions on those would be surprising. Errors are
    // logged (not thrown) because not every filesystem supports chmod.
    if (process.platform !== 'win32' && !logsDirExisted) {
      try {
        fs.chmodSync(logsDir, LOG_DIR_MODE);
      } catch (chmodError) {
        logWarn('[drool-sdk transport-logger] failed to chmod logs dir', {
          cause: chmodError,
        });
      }
    }
    const stream = fs.createWriteStream(logPath, {
      flags: 'a',
      encoding: 'utf8',
      mode: LOG_FILE_MODE,
    });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(logPath, LOG_FILE_MODE);
      } catch (chmodError) {
        logWarn('[drool-sdk transport-logger] failed to chmod log file', {
          cause: chmodError,
        });
      }
    }
    stream.on('error', (streamError) => {
      // Disable further writes silently to avoid crashing the host.
      logWarn('[drool-sdk transport-logger] write stream error', {
        cause: streamError,
      });
      result.stream = null;
      result.failed = true;
    });
    result.stream = stream;
  } catch (initError) {
    logWarn('[drool-sdk transport-logger] failed to open log file', {
      cause: initError,
    });
    result.failed = true;
  }
  return result;
}

function getState(): TransportLoggerState | null {
  if (!isTransportLoggingEnabled()) return null;
  if (state === null) {
    state = initState();
  }
  if (state.failed) return null;
  return state;
}

/**
 * Log a single JSON-RPC transport message. This is the hot path and is
 * designed to be as cheap as possible when logging is disabled:
 *   - Single boolean check when the env var is unset.
 *   - No JSON serialisation (messages are already strings on the wire).
 *   - Fire-and-forget writes via `WriteStream.write()`: Node buffers
 *     internally and never blocks the caller.
 *   - Any I/O error disables the logger for the remainder of the process
 *     instead of propagating up into the transport.
 */
export function logTransportMessage(
  direction: TransportDirection,
  message: string,
  childPid?: number
): void {
  const s = getState();
  if (!s || !s.stream) return;
  try {
    // ISO timestamp + host/child pid tags + direction marker + raw JSON-RPC
    // payload on one line. Tags let multiple daemons/CLIs (host_pid) and
    // multiple spawned drool exec children (child_pid) share a single log
    // file without ambiguity. Payloads are untouched so the file stays
    // trivially `jq`-able (strip the prefix before the first `{` or `[`).
    const marker = directionMarker(direction);
    const childTag = `[child_pid=${childPid ?? '-'}]`;
    s.stream.write(
      `[${new Date().toISOString()}] [${HOST_PID_TAG}] ${childTag} ${marker} ${message}\n`
    );
  } catch (writeError) {
    logWarn('[drool-sdk transport-logger] write failed, disabling', {
      cause: writeError,
    });
    s.failed = true;
    s.stream = null;
  }
}

/**
 * Test-only: reset the cached state so subsequent tests can re-read env vars.
 * Waits for the underlying write stream to flush before resolving.
 *
 * @public
 */
export async function __resetTransportLoggerForTests(): Promise<void> {
  const stream = state?.stream ?? null;
  state = null;
  enabledCache = null;
  if (!stream) return;
  await new Promise<void>((resolve) => {
    stream.once('finish', () => resolve());
    stream.once('error', () => resolve());
    try {
      stream.end();
    } catch (endError) {
      logWarn('[drool-sdk transport-logger] failed to end stream on reset', {
        cause: endError,
      });
      resolve();
    }
  });
}
