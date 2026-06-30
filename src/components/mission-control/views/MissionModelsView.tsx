/**
 * Mission Control mission model selection view.
 */

import { Box, Text } from 'ink';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MC_COLORS } from '@/components/mission-control/constants';
import {
  MissionControlView,
  MissionModelTarget,
} from '@/components/mission-control/enums';
import type { MissionModelsViewProps } from '@/components/mission-control/types';
import { shouldProcessMissionControlScroll } from '@/components/mission-control/utils/scrollInputGuard';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMissionDefaultModelSettings } from '@/hooks/useMissionDefaultModelSettings';
import { useSessionSettings } from '@/hooks/useSessionSettings';
import {
  getReasoningEffortDisplayName,
  getTuiModelConfig,
} from '@/models/config';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { resolveMissionSettingsSnapshot } from '@/services/mission/missionSettingsSnapshot';
import { getSessionService } from '@/services/SessionService';

type ListItem =
  | {
      type: 'model';
      id: MissionModelTarget;
      label: string;
      description: string;
    }
  | {
      type: 'toggle';
      id: 'skipScrutiny' | 'skipUserTesting';
      label: string;
      description: string;
    };

function ToggleRow({
  item,
  selected,
  color,
  enabled,
}: {
  item: Extract<ListItem, { type: 'toggle' }>;
  selected: boolean;
  color: string | undefined;
  enabled: boolean;
}) {
  const { t } = useTranslation('common');

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color ?? MC_COLORS.primary}>
        {selected ? '> ' : '  '}
        {item.label}:{' '}
        <Text color={enabled ? MC_COLORS.fail : MC_COLORS.tertiary}>
          {enabled ? t('common:settings.on') : t('common:settings.off')}
        </Text>
      </Text>
      <Box paddingLeft={4}>
        <Text color={MC_COLORS.tertiary}>{item.description}</Text>
      </Box>
    </Box>
  );
}

export function MissionModelsView({
  onNavigate,
  viewport,
  sessionId,
}: MissionModelsViewProps) {
  const { t } = useTranslation('common');
  const { width } = viewport;
  const { missionSettings } = useSessionSettings(sessionId);

  const items: ListItem[] = useMemo(
    () => [
      {
        type: 'model' as const,
        id: MissionModelTarget.Worker,
        label: t('common:missionModels.workerModel'),
        description: t('common:missionModels.workerDescription'),
      },
      {
        type: 'model' as const,
        id: MissionModelTarget.Validation,
        label: t('common:missionModels.validatorModel'),
        description: t('common:missionModels.validatorDescription'),
      },
      {
        type: 'toggle' as const,
        id: 'skipScrutiny' as const,
        label: t('common:missionModels.skipScrutiny'),
        description: t('common:missionModels.skipScrutinyDescription'),
      },
      {
        type: 'toggle' as const,
        id: 'skipUserTesting' as const,
        label: t('common:missionModels.skipUserTesting'),
        description: t('common:missionModels.skipUserTestingDescription'),
      },
    ],
    [t]
  );

  const [selectedIndex, setSelectedIndex] = useState(0);
  const missionDefaults = useMissionDefaultModelSettings();

  const effectiveMissionSettings = resolveMissionSettingsSnapshot(
    missionDefaults,
    missionSettings
  );
  const workerModel = effectiveMissionSettings.workerModel;
  const workerReasoningEffort = effectiveMissionSettings.workerReasoningEffort;
  const validationModel = effectiveMissionSettings.validationWorkerModel;
  const validationReasoningEffort =
    effectiveMissionSettings.validationWorkerReasoningEffort;
  const skipScrutiny = effectiveMissionSettings.skipScrutiny;
  const skipUserTesting = effectiveMissionSettings.skipUserTesting;

  const handleSelect = useCallback(() => {
    const item = items[selectedIndex];
    if (!item) return;

    if (item.type === 'model') {
      onNavigate(MissionControlView.MissionModelSelector, { target: item.id });
      return;
    }

    const activeSessionId = getSessionService().getCurrentSessionId();
    if (!activeSessionId) return;

    void getTuiDaemonAdapter().updateSessionSettings({
      sessionId: activeSessionId,
      missionSettings:
        item.id === 'skipScrutiny'
          ? { skipScrutiny: !skipScrutiny }
          : { skipUserTesting: !skipUserTesting },
    });
  }, [onNavigate, items, selectedIndex, skipScrutiny, skipUserTesting]);

  useKeypressHandler((input, key) => {
    if (key.upArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (input === 'k') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      if (!shouldProcessMissionControlScroll()) {
        return;
      }
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
      return;
    }
    if (input === 'j') {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
      return;
    }
    if (key.return) {
      handleSelect();
    }
  });

  // Keyboard hints removed — handled by overlay footer
  if (!workerModel || !validationModel) {
    return (
      <Box flexDirection="column">
        <Text bold color={MC_COLORS.emphasis}>
          {t('common:missionModels.title')}
        </Text>
        <Text color={MC_COLORS.border}>
          {'─'.repeat(Math.max(0, width - 4))}
        </Text>
        <Box marginTop={1}>
          <Text color={MC_COLORS.tertiary}>
            {t('common:missionModels.loading')}
          </Text>
        </Box>
      </Box>
    );
  }

  const workerCfg = getTuiModelConfig(workerModel);
  const validationCfg = getTuiModelConfig(validationModel);

  return (
    <Box flexDirection="column">
      <Text bold color={MC_COLORS.emphasis}>
        {t('common:missionModels.title')}
      </Text>
      <Text color={MC_COLORS.border}>{'─'.repeat(Math.max(0, width - 4))}</Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((item, index) => {
          const selected = index === selectedIndex;
          const color = selected ? MC_COLORS.active : MC_COLORS.primary;

          // Render separator before first toggle item
          if (
            item.type === 'toggle' &&
            (index === 0 || items[index - 1]?.type !== 'toggle')
          ) {
            return (
              <Box key={item.id} flexDirection="column">
                <Box marginTop={1} marginBottom={1}>
                  <Text bold color={MC_COLORS.tertiary}>
                    {t('common:missionModels.experimentalSection')}
                  </Text>
                </Box>
                <ToggleRow
                  item={item}
                  selected={selected}
                  color={color}
                  enabled={
                    item.id === 'skipScrutiny' ? skipScrutiny : skipUserTesting
                  }
                />
              </Box>
            );
          }

          if (item.type === 'toggle') {
            return (
              <ToggleRow
                key={item.id}
                item={item}
                selected={selected}
                color={color}
                enabled={
                  item.id === 'skipScrutiny' ? skipScrutiny : skipUserTesting
                }
              />
            );
          }

          // Model row
          const cfg =
            item.id === MissionModelTarget.Worker ? workerCfg : validationCfg;
          const reasoningEffort =
            item.id === MissionModelTarget.Worker
              ? workerReasoningEffort
              : validationReasoningEffort;
          const name = cfg.shortDisplayName || cfg.displayName || cfg.id;
          const effortDisplay = reasoningEffort
            ? getReasoningEffortDisplayName(reasoningEffort)
            : '(Off)';
          const displayText = `${name} (${effortDisplay})`;

          return (
            <Box key={item.id} flexDirection="column" marginBottom={1}>
              <Text color={color}>
                {selected ? '> ' : '  '}
                {item.label}:{' '}
                <Text color={MC_COLORS.active}>{displayText}</Text>
              </Text>
              <Box paddingLeft={4}>
                <Text color={MC_COLORS.tertiary}>{item.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
