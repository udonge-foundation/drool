import type {
  SessionSettingsStore,
  SessionSettingsStoreSnapshot,
} from '@/services/daemon/types';
import { getSessionService } from '@/services/SessionService';

import type { DaemonGetDefaultSettingsResult } from '@industry/common/daemon';

export function getCurrentSessionSettingsSnapshot(): SessionSettingsStoreSnapshot {
  const sessionService = getSessionService();
  return {
    // Daemon must see the user's literal selection; the cloud-sync
    // round-trip would otherwise overwrite "auto" with the routed pick.
    modelId: sessionService.getDisplayModel(),
    reasoningEffort: sessionService.getDisplayReasoningEffort(),
    interactionMode: sessionService.getInteractionMode(),
    autonomyLevel: sessionService.getAutonomyLevel(),
    specModeModelId: sessionService.hasSpecModeModel()
      ? sessionService.getDisplaySpecModeModel()
      : null,
    specModeReasoningEffort: sessionService.hasSpecModeModel()
      ? sessionService.getDisplaySpecModeReasoningEffort()
      : null,
    missionSettings: sessionService.getMissionSettings() ?? null,
    compactionThresholdCheckEnabled:
      sessionService.getCompactionThresholdCheckEnabled(),
  };
}

export function getSettingsSnapshotFromStore(
  store: SessionSettingsStore
): SessionSettingsStoreSnapshot {
  const modelId = store.getModelId();
  const reasoningEffort =
    store.getReasoningEffort() as SessionSettingsStoreSnapshot['reasoningEffort'];
  const interactionMode = store.getInteractionMode();
  const autonomyLevel = store.getAutonomyLevel();
  const specModeModelId = store.getSpecModeModelId();
  const specModeReasoningEffort =
    store.getSpecModeReasoningEffort() as SessionSettingsStoreSnapshot['specModeReasoningEffort'];
  const missionSettings = store.getMissionSettings();
  const compactionThresholdCheckEnabled =
    store.getCompactionThresholdCheckEnabled();

  return {
    ...(modelId !== null ? { modelId } : {}),
    ...(reasoningEffort !== null ? { reasoningEffort } : {}),
    ...(interactionMode !== null ? { interactionMode } : {}),
    ...(autonomyLevel !== null ? { autonomyLevel } : {}),
    ...(specModeModelId !== null ? { specModeModelId } : {}),
    ...(specModeReasoningEffort !== null ? { specModeReasoningEffort } : {}),
    ...(missionSettings !== null ? { missionSettings } : {}),
    ...(compactionThresholdCheckEnabled !== null
      ? { compactionThresholdCheckEnabled }
      : {}),
  };
}

function hasResolvedDaemonDefaults(
  defaults: DaemonGetDefaultSettingsResult
): boolean {
  return (
    defaults.modelId !== undefined ||
    defaults.reasoningEffort !== undefined ||
    defaults.interactionMode !== undefined ||
    defaults.autonomyLevel !== undefined
  );
}

export function getStoreSettingsFromDaemonDefaults(
  defaults: DaemonGetDefaultSettingsResult
): SessionSettingsStoreSnapshot {
  const hasResolvedDefaults = hasResolvedDaemonDefaults(defaults);
  return {
    ...(defaults.modelId !== undefined ? { modelId: defaults.modelId } : {}),
    ...(defaults.reasoningEffort !== undefined
      ? { reasoningEffort: defaults.reasoningEffort }
      : {}),
    ...(defaults.interactionMode !== undefined
      ? { interactionMode: defaults.interactionMode }
      : {}),
    ...(defaults.autonomyLevel !== undefined
      ? { autonomyLevel: defaults.autonomyLevel }
      : {}),
    ...(hasResolvedDefaults
      ? {
          specModeModelId: defaults.specModeModelId ?? null,
          specModeReasoningEffort: defaults.specModeReasoningEffort ?? null,
        }
      : {}),
    ...(defaults.missionSettings !== undefined
      ? { missionSettings: defaults.missionSettings }
      : {}),
    ...(defaults.availableModels !== undefined
      ? { availableModels: defaults.availableModels }
      : {}),
  };
}

export function applySettingsSnapshotToStore(
  store: SessionSettingsStore,
  settings: SessionSettingsStoreSnapshot
): void {
  let mutated = false;

  if (
    settings.modelId !== undefined &&
    store.getModelId() !== settings.modelId
  ) {
    store.setModelId(settings.modelId);
    mutated = true;
  }
  if (
    settings.reasoningEffort !== undefined &&
    store.getReasoningEffort() !== settings.reasoningEffort
  ) {
    store.setReasoningEffort(settings.reasoningEffort);
    mutated = true;
  }
  if (
    settings.interactionMode !== undefined &&
    store.getInteractionMode() !== settings.interactionMode
  ) {
    store.setInteractionMode(settings.interactionMode);
    mutated = true;
  }
  if (
    settings.autonomyLevel !== undefined &&
    store.getAutonomyLevel() !== settings.autonomyLevel
  ) {
    store.setAutonomyLevel(settings.autonomyLevel);
    mutated = true;
  }
  if (
    settings.specModeModelId !== undefined &&
    store.getSpecModeModelId() !== settings.specModeModelId
  ) {
    store.setSpecModeModelId(settings.specModeModelId);
    mutated = true;
  }
  if (
    settings.specModeReasoningEffort !== undefined &&
    store.getSpecModeReasoningEffort() !== settings.specModeReasoningEffort
  ) {
    store.setSpecModeReasoningEffort(settings.specModeReasoningEffort);
    mutated = true;
  }
  if (
    settings.missionSettings !== undefined &&
    store.getMissionSettings() !== settings.missionSettings
  ) {
    store.setMissionSettings(settings.missionSettings);
    mutated = true;
  }
  if (
    settings.compactionThresholdCheckEnabled !== undefined &&
    store.getCompactionThresholdCheckEnabled() !==
      settings.compactionThresholdCheckEnabled
  ) {
    store.setCompactionThresholdCheckEnabled(
      settings.compactionThresholdCheckEnabled
    );
    mutated = true;
  }
  if (settings.availableModels !== undefined && store.setAvailableModels) {
    store.setAvailableModels(settings.availableModels);
    mutated = true;
  }

  if (mutated) {
    store.notify();
  }
}
