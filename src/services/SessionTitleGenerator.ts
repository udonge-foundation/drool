import { YOU_ARE_DROOL_SYSTEM_PROMPT } from '@industry/common/cli';
import { sendCompletion } from '@industry/drool-core/llms/client/sendMessage';
import { logException } from '@industry/logging';

import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { createOneShotSendMessageClient } from '@/services/llmStreamingClient';
import { getSessionService } from '@/services/SessionService';
import { resolveModelWithByokFallback } from '@/utils/modelResolution';

import type { SessionTitleAutoStage } from '@industry/common/session/summary';

const MAX_OUTPUT_TOKENS = 100;

const SESSION_TITLE_SYSTEM_PROMPT = `${YOU_ARE_DROOL_SYSTEM_PROMPT}
You are a helpful assistant that generates concise session titles.
Given only a user message, generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this session.
Output ONLY the title as plain text, without quotes or extra formatting.`;

// Model to use for title generation via Industry proxy (fast and cheap)
const TITLE_GENERATION_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Normalizes a title by removing quotes and extra whitespace.
 */
function normalizeTitle(text: string): string {
  return text
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates and updates the session title.
 *
 * For BYOK users, the user's custom model is used. Otherwise the default
 * Haiku model goes through the Industry proxy.
 *
 * Called in parallel with the chat flow:
 * 1. After the first user message is submitted (stage: 'first_message')
 * 2. After the first file edit (stage: 'first_file_edit')
 */
export async function generateAndUpdateSessionTitle(params: {
  sessionId: string;
  stage: SessionTitleAutoStage;
  firstUserText?: string;
  editedFilePath?: string;
}): Promise<string | null> {
  const { sessionId, stage, firstUserText } = params;
  const droolRuntimeService = getDroolRuntimeService();

  if (droolRuntimeService.isNonInteractiveCLIMode()) {
    return null;
  }

  const sessionService = getSessionService();

  try {
    if (sessionService.isSessionTitleManuallySet(sessionId)) {
      return null;
    }

    const existingStage = sessionService.getSessionTitleAutoStage(sessionId);

    if (stage === 'first_message') {
      if (existingStage === 'first_file_edit') {
        return null;
      }
      if (
        existingStage === 'first_message' &&
        sessionService.getSessionTitleText(sessionId)
      ) {
        return null;
      }
    }

    if (stage === 'first_file_edit' && existingStage === 'first_file_edit') {
      return null;
    }

    const { modelId } = resolveModelWithByokFallback({
      fallback: TITLE_GENERATION_MODEL,
    });

    const userContent = firstUserText || 'Generate a title for this session';

    const rawTitle = await sendCompletion(createOneShotSendMessageClient(), {
      modelId,
      systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
      userContent,
      maxTokensOverride: MAX_OUTPUT_TOKENS,
      sessionId,
    });

    const title = normalizeTitle(rawTitle);

    if (!title) {
      return null;
    }

    await sessionService.updateSessionTitle(sessionId, title, {
      manual: false,
      stage,
    });

    return title;
  } catch (error) {
    logException(error, '[SessionTitle] Failed to generate/update');
    return null;
  }
}
