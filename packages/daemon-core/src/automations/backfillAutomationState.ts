/**
 * One-time migration helper: backfill automation `state.json` from the
 * session index cache. Used by the due-run poller when an automation has
 * no state.json yet — we look up the most recent session tagged with the
 * automation's ID and synthesize a state entry so catch-up logic can work
 * from the first poll after upgrade.
 *
 * Session tag matching tries two identifiers, in priority order:
 *   1. The resolved automation UUID (passed from the poller, sourced from
 *      state.json / ensureAutomationId)
 *   2. The automation UUID read directly from HEARTBEAT.md frontmatter
 *      (tertiary source when the resolved UUID is missing because
 *      ensureAutomationId failed to write state.json)
 *
 * Duplicates are de-duplicated before filtering.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import { AUTOMATION_HEARTBEAT_FILE } from '@industry/common/automations';
import { logException, logInfo, logWarn } from '@industry/logging';

import { writeAutomationState } from './automation-state';

import type { AutomationState } from './schemas';

/**
 * Type guard narrowing an unknown JSON value to a plain object record.
 * Lets us index into parsed YAML without `as` casts.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Best-effort read of the `id` frontmatter field in HEARTBEAT.md.
 *
 * Returns null when the file or frontmatter is missing, malformed, or has
 * no id. Tertiary UUID source used only when state.json is absent AND the
 * caller couldn't resolve config.id (e.g. ensureAutomationId write failed).
 */
function readIdFromHeartbeat(automationPath: string): string | null {
  try {
    const heartbeatPath = path.join(automationPath, AUTOMATION_HEARTBEAT_FILE);
    if (!fs.existsSync(heartbeatPath)) {
      return null;
    }
    const raw = fs.readFileSync(heartbeatPath, 'utf-8');
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!fmMatch) {
      return null;
    }
    const parsed: unknown = yaml.load(fmMatch[1]);
    if (isPlainRecord(parsed)) {
      const idValue = parsed.id;
      if (typeof idValue === 'string') {
        const trimmed = idValue.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
    }
    return null;
  } catch (err) {
    logWarn('[automation-state] Failed to read id from HEARTBEAT.md', {
      path: automationPath,
      cause: err,
    });
    return null;
  }
}

export async function backfillAutomationState(
  automationId: string,
  automationPath: string
): Promise<AutomationState | null> {
  const { sessionIndexCache } = await import(
    '../server/handlers/session-index-cache'
  );

  const allSessions = await sessionIndexCache.getAll();

  // Build the set of identifiers that might match this automation's sessions:
  // the caller-provided id (resolved UUID from state.json / ensureAutomationId)
  // and the HEARTBEAT.md frontmatter id (tertiary fallback for crash windows
  // where ensureAutomationId failed to write state.json).
  const heartbeatId = readIdFromHeartbeat(automationPath);
  const candidateIds = Array.from(
    new Set(
      [automationId, heartbeatId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      )
    )
  );

  const matchingSessions = allSessions.filter((session) =>
    session.tags?.some(
      (tag) =>
        tag.name === 'automation' &&
        tag.metadata?.type === 'run' &&
        typeof tag.metadata?.automationId === 'string' &&
        candidateIds.includes(tag.metadata.automationId)
    )
  );

  if (matchingSessions.length === 0) {
    logInfo('[automation-state] No matching sessions for backfill', {
      automationId,
    });
    return null;
  }

  matchingSessions.sort((a, b) => b.mtime - a.mtime);
  const mostRecent = matchingSessions[0]!;

  // Use the first candidate id as the canonical id written to state.json.
  // candidateIds[0] is the caller-provided id (resolved UUID from state.json
  // / ensureAutomationId when available) and is guaranteed non-empty here
  // because we found matching sessions.
  const state: AutomationState = {
    id: candidateIds[0]!,
    lastRunAt: new Date(mostRecent.mtime).toISOString(),
    lastRunId: mostRecent.sessionId,
    lastRunSessionId: mostRecent.sessionId,
  };

  try {
    writeAutomationState(automationPath, state);
    logInfo('[automation-state] Backfilled state from session index', {
      automationId,
      sessionId: mostRecent.sessionId,
    });
  } catch (err) {
    logException(err, '[automation-state] Failed to write backfilled state', {
      automationId,
      path: automationPath,
    });
    return null;
  }

  return state;
}
