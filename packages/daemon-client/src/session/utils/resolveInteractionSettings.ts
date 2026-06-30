import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { hasDecoupledInteractionSettings } from '@industry/utils/autonomy';

type InteractionSettings = {
  interactionMode: DroolInteractionMode;
  autonomyLevel: AutonomyLevel;
};

type ResolveInteractionSettingsParams = {
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
  fallback: InteractionSettings;
};

const DEFAULT_INTERACTION_SETTINGS: InteractionSettings = {
  interactionMode: DroolInteractionMode.Auto,
  autonomyLevel: AutonomyLevel.Off,
};

export function getDefaultInteractionSettings(): InteractionSettings {
  return {
    interactionMode: DEFAULT_INTERACTION_SETTINGS.interactionMode,
    autonomyLevel: DEFAULT_INTERACTION_SETTINGS.autonomyLevel,
  };
}

export function resolveInteractionSettings({
  interactionMode,
  autonomyLevel,
  fallback,
}: ResolveInteractionSettingsParams): InteractionSettings {
  if (hasDecoupledInteractionSettings({ interactionMode, autonomyLevel })) {
    return {
      interactionMode: interactionMode ?? fallback.interactionMode,
      autonomyLevel: autonomyLevel ?? fallback.autonomyLevel,
    };
  }

  return fallback;
}
