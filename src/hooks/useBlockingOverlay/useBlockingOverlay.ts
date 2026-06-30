import { useMemo } from 'react';

import type {
  BlockingOverlayFlags,
  BlockingOverlayState,
} from '@/hooks/useBlockingOverlay/types';

/**
 * Selector for "is any overlay blocking the transcript-scroll shortcuts".
 *
 * Scope: consumed only by the transcript-scroll handler (Alt+Up/Down,
 * Alt+PgUp/PgDn). Other gated shortcuts (Ctrl+O, Ctrl+T, rewind)
 * keep their own inline OR-chains because each has product-specified
 * exclusions that should not be shared across handlers.
 */
export function useBlockingOverlay(
  flags: BlockingOverlayFlags
): BlockingOverlayState {
  // Enumerate flag fields explicitly rather than keying off object identity
  // so the memo remains stable when callers pass a new object literal every
  // render with the same field values.
  const {
    detailedTranscript,
    approvalDetails,
    loginSelector,
    diagnosticsMenu,
    droolsMenu,
    skillsMenu,
    pluginMenu,
    hooksManager,
    reviewManager,
    settingsSelector,
    themeSelector,
    commandsManager,
    mcpManager,
    bgProcessManager,
    squadMode,
    missionControl,
    missionOnboarding,
    inlineModelPicker,
    modelSelector,
    missionModelSelector,
    pendingMissionModelTarget,
    specModeConfigurator,
    compactConfirm,
    createSkillFlow,
    setupIncidentResponseFlow,
    reasoningEffortSelector,
    sessionSelector,
    missionsMenu,
    rewindOptions,
    fileRestore,
    pendingConfirmation,
    pendingAskUser,
    tokenLimitChoice,
  } = flags;

  return useMemo(() => {
    const resolved: BlockingOverlayFlags = {
      detailedTranscript,
      approvalDetails,
      loginSelector,
      diagnosticsMenu,
      droolsMenu,
      skillsMenu,
      pluginMenu,
      hooksManager,
      reviewManager,
      settingsSelector,
      themeSelector,
      commandsManager,
      mcpManager,
      bgProcessManager,
      squadMode,
      missionControl,
      missionOnboarding,
      inlineModelPicker,
      modelSelector,
      missionModelSelector,
      pendingMissionModelTarget,
      specModeConfigurator,
      compactConfirm,
      createSkillFlow,
      setupIncidentResponseFlow,
      reasoningEffortSelector,
      sessionSelector,
      missionsMenu,
      rewindOptions,
      fileRestore,
      pendingConfirmation,
      pendingAskUser,
      tokenLimitChoice,
    };
    const isActive = Object.values(resolved).some(Boolean);
    return { isActive, flags: resolved };
  }, [
    detailedTranscript,
    approvalDetails,
    loginSelector,
    diagnosticsMenu,
    droolsMenu,
    skillsMenu,
    pluginMenu,
    hooksManager,
    reviewManager,
    settingsSelector,
    themeSelector,
    commandsManager,
    mcpManager,
    bgProcessManager,
    squadMode,
    missionControl,
    missionOnboarding,
    inlineModelPicker,
    modelSelector,
    missionModelSelector,
    pendingMissionModelTarget,
    specModeConfigurator,
    compactConfirm,
    createSkillFlow,
    setupIncidentResponseFlow,
    reasoningEffortSelector,
    sessionSelector,
    missionsMenu,
    rewindOptions,
    fileRestore,
    pendingConfirmation,
    pendingAskUser,
    tokenLimitChoice,
  ]);
}
