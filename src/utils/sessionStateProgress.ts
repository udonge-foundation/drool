import { logWarn } from '@industry/logging';
import {
  buildSessionToolProgressUpdates,
  getLatestSessionAssistantText,
} from '@industry/utils/session';

import type { MultiSessionStateManager } from '@industry/daemon-client/session';
import type { ToolStreamingUpdate } from '@industry/drool-sdk-ext/protocol/drool';
import type { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';

const MAX_PROGRESS_UPDATES = 12;

type SessionStateParams = {
  sessionId: string;
  sessionStateManager?: MultiSessionStateManager | null;
};

type NewSessionStateProgressUpdatesParams = SessionStateParams & {
  seenProgressKeys: Set<string>;
};

function getMessagesFromState({
  sessionId,
  sessionStateManager,
}: SessionStateParams): IndustryDroolMessage[] | null {
  try {
    return (
      sessionStateManager?.getSessionManager(sessionId)?.getMessages() ?? null
    );
  } catch (error) {
    logWarn('[sessionStateProgress] Failed to read session messages', {
      sessionId,
      cause: error,
    });
    return null;
  }
}

function getSessionProgressDedupeKey(update: ToolStreamingUpdate): string {
  return [
    update.type,
    update.toolName,
    update.text,
    update.details,
    update.error,
    update.timestamp,
  ].join('|');
}

/** Read the latest final assistant text from a persisted session. */
export function readSessionFinalTextFromState({
  sessionId,
  sessionStateManager,
}: SessionStateParams): string {
  const messages = getMessagesFromState({ sessionId, sessionStateManager });
  if (!messages) return '';

  return getLatestSessionAssistantText(messages);
}

/** Convert persisted session messages into Task progress updates. */
export function readSessionProgressFromState({
  sessionId,
  sessionStateManager,
}: SessionStateParams): ToolStreamingUpdate[] | null {
  const messages = getMessagesFromState({ sessionId, sessionStateManager });
  if (!messages) return null;
  if (messages.length === 0) return null;

  return buildSessionToolProgressUpdates(messages, {
    maxUpdates: MAX_PROGRESS_UPDATES,
  });
}

/** Read progress updates not yet seen by a polling caller. */
export function readNewSessionStateProgressUpdates({
  sessionId,
  sessionStateManager,
  seenProgressKeys,
}: NewSessionStateProgressUpdatesParams): ToolStreamingUpdate[] | null {
  const progressUpdates = readSessionProgressFromState({
    sessionId,
    sessionStateManager,
  });
  if (!progressUpdates) return null;

  const newUpdates: ToolStreamingUpdate[] = [];
  for (const update of progressUpdates) {
    const progressUpdate = {
      ...update,
      subagentSessionId: update.subagentSessionId ?? sessionId,
    };
    const key = getSessionProgressDedupeKey(progressUpdate);
    if (seenProgressKeys.has(key)) continue;
    seenProgressKeys.add(key);
    newUpdates.push(progressUpdate);
  }
  return newUpdates;
}
