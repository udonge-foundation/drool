import * as fs from 'fs';
import * as path from 'path';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

const BREADCRUMB_FILE_NAME = 'daemon-critical-error.json';

/**
 * Maximum stack/message lengths persisted to the breadcrumb. The desktop
 * forwards this content as a metric tag so we keep it small enough that the
 * combined payload comfortably fits within the telemetry tag budget.
 */
const MAX_MESSAGE_LEN = 512;
const MAX_STACK_LEN = 4096;

export function getCriticalErrorBreadcrumbPath(): string {
  return path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'logs',
    BREADCRUMB_FILE_NAME
  );
}

/**
 * Persist the most recent critical error to a single-line JSON file.
 *
 * Writes are synchronous and bypass the regular telemetry path so the payload
 * survives an immediate `process.exit` or a parent-driven force-kill that
 * happens before the async `logException` batch can flush. The desktop reads
 * this file in `handleProcessExit` and forwards it as a tag on the next
 * `desktop_daemon_crash_count` metric, giving us the actual error that took
 * the daemon down without depending on Axiom batching.
 *
 * The file is rewritten on every call (not appended) — only the most recent
 * crash matters for diagnosis, and the timestamp lets the desktop confirm
 * the breadcrumb belongs to the current daemon spawn.
 */
export function writeCriticalErrorBreadcrumb(payload: {
  context: string;
  message: string;
  stack?: string;
}): void {
  try {
    const dir = path.dirname(getCriticalErrorBreadcrumbPath());
    fs.mkdirSync(dir, { recursive: true });

    const data = JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      context: payload.context.slice(0, MAX_MESSAGE_LEN),
      message: payload.message.slice(0, MAX_MESSAGE_LEN),
      stack: payload.stack?.slice(0, MAX_STACK_LEN),
    });

    const fd = fs.openSync(getCriticalErrorBreadcrumbPath(), 'w');
    try {
      fs.writeSync(fd, data);
      try {
        fs.fsyncSync(fd);
      } catch {
        // fsync can fail on some filesystems (e.g. network mounts). The
        // write itself already returned successfully, so swallow the
        // post-write durability error.
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Breadcrumb is strictly best-effort. Never let it impede the original
    // error-handling path: the caller is already in the middle of a critical
    // failure and any throw here would only make things worse.
  }
}
