import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';

import type {
  ApprovedSpecNewSessionPayload,
  SpecHandoffPrompt,
} from '@/agent/types';
import {
  getSessionController,
  type SessionSettings,
} from '@/controllers/SessionController';
import { getSessionService } from '@/services/SessionService';

function buildSpecHandoffSessionSettings(
  autonomyLevel: AutonomyLevel
): Partial<SessionSettings> {
  const sessionService = getSessionService();
  return {
    interactionMode: DroolInteractionMode.Auto,
    autonomyLevel,
    modelId: sessionService.getModel(),
    reasoningEffort: sessionService.getReasoningEffort(),
    ...(sessionService.hasSpecModeModel()
      ? {
          specModeModelId: sessionService.getSpecModeModel(),
          specModeReasoningEffort: sessionService.getSpecModeReasoningEffort(),
        }
      : {}),
  };
}

function buildApprovedSpecImplementationPrompt(params: {
  payload: ApprovedSpecNewSessionPayload;
  sourceTranscriptPath?: string;
}): SpecHandoffPrompt {
  const { payload, sourceTranscriptPath } = params;

  const sections = [
    `Implement the following plan:`,
    payload.userComment ? `User note: ${payload.userComment}` : undefined,
    payload.plan,
    sourceTranscriptPath
      ? `If you need specific details from the planning session (like exact code snippets, error messages, or content generated), read the full transcript at: ${sourceTranscriptPath}`
      : `If you need specific details from the planning session, read the full spec at: ${payload.filePath}`,
  ].filter(Boolean);

  return {
    openingLine: `✓ New session created\n\nSpec approved: ${payload.filePath}`,
    sessionTitle: payload.title,
    userMessage: sections.join('\n\n'),
  };
}

/**
 * Create a new session for spec handoff, configure autonomy/interaction mode,
 * and return the handoff prompt info. Shared by TUI (app.tsx) and non-TUI (sharedAgentRunner) paths.
 */
export async function createSpecHandoffSession(
  payload: ApprovedSpecNewSessionPayload
): Promise<{ newSessionId: string; handoff: SpecHandoffPrompt }> {
  const sessionService = getSessionService();
  const sourceTranscriptPath =
    sessionService.getSessionTranscriptPath() || undefined;
  const handoff = buildApprovedSpecImplementationPrompt({
    payload,
    sourceTranscriptPath,
  });

  const chosenAutonomyLevel = payload.autonomyLevel ?? AutonomyLevel.Off;
  const controller = getSessionController();

  const newSessionId = await controller.createSession({
    cwd: sessionService.getCurrentSessionCwd(),
    sessionTitle: handoff.sessionTitle,
    initialSettings: buildSpecHandoffSessionSettings(chosenAutonomyLevel),
  });

  await controller.loadSession({ sessionId: newSessionId });

  sessionService.setInteractionMode(DroolInteractionMode.Auto);
  sessionService.setAutonomyLevel(chosenAutonomyLevel);

  return { newSessionId, handoff };
}
