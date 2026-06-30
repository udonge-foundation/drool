import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';

import { buildConfigOptions } from '@/acp/session/configOptions';
import { applyCurrentModel } from '@/acp/session/models';
import {
  getAllowedAcpAutonomyModes,
  resolveAllowedAcpAutonomyMode,
} from '@/acp/session/modes';
import type { ConfigOptionsState } from '@/acp/session/types';
import type { SessionSettings } from '@/controllers/SessionController';

import type {
  SessionMode,
  SessionModeState,
  SessionModelState,
} from '@agentclientprotocol/sdk';

const MODE_DESCRIPTIONS: Record<AutonomyMode, Omit<SessionMode, 'id'>> = {
  [AutonomyMode.Normal]: {
    name: 'Auto (Off)',
    description: 'Auto-approves only read operations',
  },
  [AutonomyMode.Spec]: {
    name: 'Spec',
    description: 'Build feature specs (read-only)',
  },
  [AutonomyMode.AutoLow]: {
    name: 'Auto (Low)',
    description:
      'Auto-approves file edits and low-risk actions during the session',
  },
  [AutonomyMode.AutoMedium]: {
    name: 'Auto (Medium)',
    description: 'Auto-approves medium-risk actions during the session',
  },
  [AutonomyMode.AutoHigh]: {
    name: 'Auto (High)',
    description: 'Auto-approves all actions',
  },
};

function buildAcpSessionModeState(
  currentModeId: AutonomyMode
): SessionModeState {
  const allowedModes = getAllowedAcpAutonomyModes();
  const resolvedCurrentModeId = resolveAllowedAcpAutonomyMode(currentModeId);
  const availableModes: SessionMode[] = allowedModes.map((id) => ({
    id,
    ...MODE_DESCRIPTIONS[id],
  }));

  if (!availableModes.some((mode) => mode.id === resolvedCurrentModeId)) {
    availableModes.push({
      id: resolvedCurrentModeId,
      ...MODE_DESCRIPTIONS[AutonomyMode.Normal],
    });
  }

  return { availableModes, currentModeId: resolvedCurrentModeId };
}

export function buildAcpSessionConfigState(params: {
  settings: Pick<
    SessionSettings,
    'autonomyMode' | 'modelId' | 'reasoningEffort'
  >;
  availableModels: SessionModelState['availableModels'];
}): {
  models: SessionModelState;
  modes: SessionModeState;
  configOptions: ConfigOptionsState;
} {
  const models = applyCurrentModel(
    params.availableModels,
    params.settings.modelId
  );
  const modes = buildAcpSessionModeState(params.settings.autonomyMode);
  const configOptions = buildConfigOptions({
    modelId: models.currentModelId,
    reasoningEffort: params.settings.reasoningEffort,
    autonomyMode: modes.currentModeId as AutonomyMode,
    availableModels: models.availableModels,
    availableAutonomyModes: modes.availableModes.map(
      (mode) => mode.id as AutonomyMode
    ),
  });

  return { models, modes, configOptions };
}
