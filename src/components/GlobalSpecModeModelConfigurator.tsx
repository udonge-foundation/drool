import { Text } from 'ink';
import { useCallback, useState } from 'react';

import { SpecModeModelConfigurator } from '@/components/SpecModeModelConfigurator';
import { useMountEffect } from '@/hooks/useMountEffect';
import { getI18n } from '@/i18n';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSettingsService } from '@/services/SettingsService';

import type { DaemonGetDefaultSettingsResult } from '@industry/common/daemon';
import type { Settings } from '@industry/common/settings';
import type { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

interface GlobalSpecModeModelConfiguratorProps {
  onClose: () => void;
  onSettingsChanged: (updated: Settings) => void;
}

type ResolvedDefaultSettings = DaemonGetDefaultSettingsResult & {
  modelId: string;
  reasoningEffort: ReasoningEffort;
};

export function GlobalSpecModeModelConfigurator({
  onClose,
  onSettingsChanged,
}: GlobalSpecModeModelConfiguratorProps) {
  const [defaultSettings, setDefaultSettings] =
    useState<ResolvedDefaultSettings | null>(null);

  const refreshDefaults = useCallback(async () => {
    const defaults = await getTuiDaemonAdapter().getDefaultSettings();
    const settingsService = getSettingsService();
    const resolvedDefaults = {
      ...defaults,
      modelId: defaults.modelId ?? settingsService.getModel(),
      reasoningEffort:
        defaults.reasoningEffort ?? settingsService.getReasoningEffort(),
    };
    setDefaultSettings(resolvedDefaults);
    const current = settingsService.getSettings();
    onSettingsChanged({
      ...current,
      general: {
        ...current.general,
        sessionDefaultSettings: {
          ...current.general?.sessionDefaultSettings,
          model: resolvedDefaults.modelId,
          reasoningEffort: resolvedDefaults.reasoningEffort,
          specModeModel: defaults.specModeModelId,
          specModeReasoningEffort: defaults.specModeReasoningEffort,
        },
      },
    });
  }, [onSettingsChanged]);

  useMountEffect(() => {
    void refreshDefaults();
  });

  if (!defaultSettings?.modelId || !defaultSettings.reasoningEffort) {
    return <Text>{getI18n().t('common:missionModelSelector.loading')}</Text>;
  }

  return (
    <SpecModeModelConfigurator
      currentMainModel={defaultSettings.modelId}
      currentSpecModel={defaultSettings.specModeModelId ?? null}
      currentMainReasoningEffort={defaultSettings.reasoningEffort}
      currentSpecReasoningEffort={
        defaultSettings.specModeReasoningEffort ??
        defaultSettings.reasoningEffort
      }
      onSetSpecModel={async (model, effort) => {
        await getTuiDaemonAdapter().updateDefaultSettings({
          specModeModelId: model,
          specModeReasoningEffort: effort,
        });
        await refreshDefaults();
      }}
      onClearSpecModel={async () => {
        await getTuiDaemonAdapter().updateDefaultSettings({
          specModeModelId: null,
          specModeReasoningEffort: null,
        });
        await refreshDefaults();
      }}
      onClose={onClose}
    />
  );
}
