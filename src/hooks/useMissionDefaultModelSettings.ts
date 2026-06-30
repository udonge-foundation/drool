import { useMemo, useSyncExternalStore } from 'react';

import { getSettingsService } from '@/services/SettingsService';

import type { MissionModelSettings } from '@industry/common/settings';

interface MissionDefaultSettings extends Required<MissionModelSettings> {
  orchestrator: string;
}

const subscribe = (onStoreChange: () => void): (() => void) =>
  getSettingsService().subscribeToMissionModels(onStoreChange);

export function useMissionDefaultModelSettings(): MissionDefaultSettings {
  const orchestrator = useSyncExternalStore(subscribe, () =>
    getSettingsService().getMissionOrchestratorModel()
  );
  const workerModel = useSyncExternalStore(subscribe, () =>
    getSettingsService().getMissionWorkerModel()
  );
  const workerReasoningEffort = useSyncExternalStore(subscribe, () =>
    getSettingsService().getMissionWorkerReasoningEffort()
  );
  const validationWorkerModel = useSyncExternalStore(subscribe, () =>
    getSettingsService().getMissionValidationWorkerModel()
  );
  const validationWorkerReasoningEffort = useSyncExternalStore(subscribe, () =>
    getSettingsService().getMissionValidationWorkerReasoningEffort()
  );
  const skipScrutiny = useSyncExternalStore(subscribe, () =>
    getSettingsService().getMissionSkipScrutiny()
  );
  const skipUserTesting = useSyncExternalStore(subscribe, () =>
    getSettingsService().getMissionSkipUserTesting()
  );

  return useMemo(
    () => ({
      orchestrator,
      workerModel,
      workerReasoningEffort,
      validationWorkerModel,
      validationWorkerReasoningEffort,
      skipScrutiny,
      skipUserTesting,
    }),
    [
      orchestrator,
      workerModel,
      workerReasoningEffort,
      validationWorkerModel,
      validationWorkerReasoningEffort,
      skipScrutiny,
      skipUserTesting,
    ]
  );
}
