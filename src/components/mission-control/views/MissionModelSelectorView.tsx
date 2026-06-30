/**
 * Mission Control worker/validator model selector wrapper.
 */

import { Box } from 'ink';
import { useCallback, useState } from 'react';

import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

import { MissionModelTarget } from '@/components/mission-control/enums';
import type { MissionModelSelectorViewProps } from '@/components/mission-control/types';
import { ModelSelector } from '@/components/ModelSelector';
import { ReasoningEffortSelector } from '@/components/ReasoningEffortSelector';
import { useMissionDefaultModelSettings } from '@/hooks/useMissionDefaultModelSettings';
import { useSessionSettings } from '@/hooks/useSessionSettings';
import { getTuiModelConfig } from '@/models/config';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { resolveMissionSettingsSnapshot } from '@/services/mission/missionSettingsSnapshot';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';

type SelectorStep = 'model' | 'reasoning';

export function MissionModelSelectorView({
  target,
  sessionId,
  onDone,
  onCancel,
}: MissionModelSelectorViewProps) {
  const { missionSettings } = useSessionSettings(sessionId);

  const [step, setStep] = useState<SelectorStep>('model');
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const missionDefaults = useMissionDefaultModelSettings();

  const effectiveMissionSettings = resolveMissionSettingsSnapshot(
    missionDefaults,
    missionSettings
  );

  const currentModel =
    target === MissionModelTarget.Validation
      ? effectiveMissionSettings.validationWorkerModel
      : effectiveMissionSettings.workerModel;

  const currentReasoningEffort =
    target === MissionModelTarget.Validation
      ? effectiveMissionSettings.validationWorkerReasoningEffort
      : effectiveMissionSettings.workerReasoningEffort;

  const defaultModelId =
    target === MissionModelTarget.Validation
      ? missionDefaults.validationWorkerModel
      : missionDefaults.workerModel;

  const handleSetMissionDefault = useCallback(
    (modelId: string) => {
      const settingsService = getSettingsService();
      const effort = getTuiModelConfig(modelId).defaultReasoningEffort;
      if (target === MissionModelTarget.Validation) {
        settingsService.setMissionValidationWorkerModel(modelId);
        settingsService.setMissionValidationWorkerReasoningEffort(effort);
      } else {
        settingsService.setMissionWorkerModel(modelId);
        settingsService.setMissionWorkerReasoningEffort(effort);
      }
    },
    [target]
  );

  const applySettings = useCallback(
    async (model: string, effort: ReasoningEffort) => {
      const activeSessionId = getSessionService().getCurrentSessionId();
      if (!activeSessionId) {
        onDone();
        return;
      }

      await getTuiDaemonAdapter().updateSessionSettings({
        sessionId: activeSessionId,
        missionSettings:
          target === MissionModelTarget.Validation
            ? {
                validationWorkerModel: model,
                validationWorkerReasoningEffort: effort,
              }
            : {
                workerModel: model,
                workerReasoningEffort: effort,
              },
      });
      onDone();
    },
    [onDone, target]
  );

  const handleModelSelect = useCallback(
    (model: string) => {
      const modelConfig = getTuiModelConfig(model);
      const supportedEfforts = modelConfig.supportedReasoningEfforts;

      // If model only supports one reasoning effort, apply it directly
      if (supportedEfforts.length <= 1) {
        const effort = supportedEfforts[0] ?? ReasoningEffort.None;
        void applySettings(model, effort);
        return;
      }

      // Multiple reasoning efforts supported - show selector
      setPendingModel(model);
      setStep('reasoning');
    },
    [applySettings]
  );

  const handleReasoningSelect = useCallback(
    (effort: ReasoningEffort) => {
      if (pendingModel) {
        void applySettings(pendingModel, effort);
      } else {
        // Fallback - should not happen
        onDone();
      }
    },
    [applySettings, onDone, pendingModel]
  );

  const handleReasoningCancel = useCallback(() => {
    // Go back to model selection
    setPendingModel(null);
    setStep('model');
  }, []);

  if (step === 'reasoning' && pendingModel) {
    const modelConfig = getTuiModelConfig(pendingModel);
    return (
      <Box>
        <ReasoningEffortSelector
          currentEffort={currentReasoningEffort}
          supportedEfforts={modelConfig.supportedReasoningEfforts}
          onSelect={handleReasoningSelect}
          onCancel={handleReasoningCancel}
        />
      </Box>
    );
  }

  return (
    <Box>
      <ModelSelector
        currentModel={currentModel}
        currentReasoningEffort={currentReasoningEffort}
        defaultModelId={defaultModelId}
        onSetAsDefault={handleSetMissionDefault}
        onSelect={handleModelSelect}
        onCancel={onCancel ?? (() => {})}
        hideTabs
      />
    </Box>
  );
}
