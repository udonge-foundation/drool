import { DroolInteractionMode } from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo } from '@industry/logging';

import { getSkillCreatorMessage } from '@/commands/create-skill';
import { SKILL_CREATION_TITLE_MARKER } from '@/hooks/skill-creation/constants';
import type {
  CreateSkillSessionParams,
  CreateSkillSessionResult,
} from '@/hooks/skill-creation/types';
import { getI18n } from '@/i18n';
import { getSessionService } from '@/services/SessionService';

/**
 * Creates a new session for skill creation by forking the current session
 * and enabling spec mode. Returns the skill creator message to be sent via runAgent.
 */
export async function createSkillSession(
  params: CreateSkillSessionParams
): Promise<CreateSkillSessionResult> {
  const { description } = params;
  const sessionService = getSessionService();
  const currentSessionId = sessionService.getCurrentSessionId();

  if (!currentSessionId) {
    throw new Error('No active session. Start a conversation first.');
  }

  logInfo('[SkillCreation] Starting skill creation session', {
    sessionId: currentSessionId,
  });

  // Fork the entire session
  const originalTitle = sessionService.getSessionTitle();
  const translatedTitle = getI18n().t(
    'common:appMessages.skillCreationPrefix',
    {
      title: originalTitle || getI18n().t('common:appMessages.sessionFallback'),
    }
  );
  // Include a locale-independent marker so detection works in any language
  const newTitle = `${SKILL_CREATION_TITLE_MARKER} ${translatedTitle}`;
  const newSessionId = await sessionService.forkSession(
    currentSessionId,
    null, // null = include all messages
    newTitle,
    currentSessionId,
    'create-skill'
  );

  logInfo('[SkillCreation] Session forked', {
    sessionId: newSessionId,
  });

  // Load the new session first, then enable spec mode.
  // setInteractionMode persists to disk, so the session must be loaded
  // before we modify its settings.
  const newSession = await sessionService.loadSession(newSessionId);

  getSessionService().setInteractionMode(DroolInteractionMode.Spec);

  logInfo('[SkillCreation] Skill creation session ready', {
    sessionId: newSessionId,
  });

  return {
    newSessionId,
    newSession,
    skillCreatorMessage: await getSkillCreatorMessage(description),
  };
}
