import { Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import {
  DroolLocation,
  SettingsLevel,
} from '@industry/drool-sdk-ext/protocol/settings';
import { logException } from '@industry/logging';
import { isRouterModel } from '@industry/utils/llm';

import { COLORS } from '@/components/chat/themedColors';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { getAllowedModelIds } from '@/models/availability';
import { listCustomModelIds } from '@/models/modelRegistry';
import { getSettingsService } from '@/services/SettingsService';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

const VISIBLE_COUNT = 10;
const ANCHOR_ROW = 7;

function locationToSettingsLevel(location: DroolLocation): SettingsLevel {
  return location === 'project' ? SettingsLevel.Project : SettingsLevel.User;
}

interface DroolModelFallbackPickerProps {
  droolNames: string[];
  originalModelId: string;
  droolLocation: DroolLocation;
  onComplete: () => void;
  onCancel: () => void;
}

/**
 * Map invalid drool model to a fallback model.
 */
export function DroolModelFallbackPicker({
  droolNames: rawDroolNames,
  originalModelId: rawOriginalModelId,
  droolLocation,
  onComplete,
  onCancel,
}: DroolModelFallbackPickerProps) {
  const { t } = useTranslation('common');
  const [error, setError] = useState(false);

  const droolName = rawDroolNames
    .map((n) => sanitizeTerminalDisplayText(n, { stripSgr: true }))
    .join(', ');
  const originalModelId = sanitizeTerminalDisplayText(rawOriginalModelId, {
    stripSgr: true,
  });

  // The router ("auto") is excluded: a drool fallback should resolve to a
  // concrete model rather than re-routing. Custom models are filtered through
  // validateModelAccess so only org-permitted models are offered.
  const models = useMemo(() => {
    const settings = getSettingsService();
    const allowedCustom = listCustomModelIds().filter(
      (id) => settings.validateModelAccess(id).allowed
    );
    return [...getAllowedModelIds(), ...allowedCustom].filter(
      (modelId) => !isRouterModel(modelId)
    );
  }, []);

  // Surface any existing fallback so the user sees the current replacement and
  // can keep or change it.
  const currentFallback = useMemo(
    () => getSettingsService().getModelFallbacks()[rawOriginalModelId],
    [rawOriginalModelId]
  );
  const initialIndex = useMemo(() => {
    const idx = currentFallback ? models.indexOf(currentFallback) : -1;
    return idx >= 0 ? idx : 0;
  }, [currentFallback, models]);

  const { selectedIndex } = useMenuNavigation({
    items: models,
    initialIndex,
    onSelect: (modelId) => {
      setError(false);
      void getSettingsService()
        .setModelFallback(
          rawOriginalModelId,
          modelId,
          locationToSettingsLevel(droolLocation)
        )
        .then(() => onComplete())
        .catch((err) => {
          logException(err, 'Failed to persist model fallback');
          setError(true);
        });
    },
    onCancel,
  });

  const { windowStart, visibleItems } = getWindowedListSlice({
    items: models,
    selectedIndex,
    visibleCount: VISIBLE_COUNT,
    anchorRow: ANCHOR_ROW,
  });

  return (
    <MenuContainer
      title={t('drools.modelFallbackPickerTitle', { name: droolName })}
      helpText={t('drools.helpNavigateSelect')}
      helpRight={
        models.length === 0
          ? undefined
          : `${windowStart + 1}-${Math.min(windowStart + visibleItems.length, models.length)} of ${models.length}`
      }
    >
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color={COLORS.text.muted}>
            <Trans
              i18nKey="drools.modelFallbackDescription"
              t={t}
              components={{
                name: <Text color={COLORS.text.primary} />,
                model: <Text color={COLORS.text.primary} />,
                model2: <Text color={COLORS.text.primary} />,
              }}
              values={{ name: droolName, model: originalModelId }}
            />
          </Text>
          {currentFallback && (
            <Box marginTop={1}>
              <Text color={COLORS.text.muted}>
                {t('drools.modelFallbackCurrent', { modelId: currentFallback })}
              </Text>
            </Box>
          )}
          {error && (
            <Box marginTop={1}>
              <Text color={COLORS.error}>
                {t('drools.modelFallbackWriteError')}
              </Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column" height={VISIBLE_COUNT}>
          {models.length === 0 ? (
            <Text color={COLORS.error}>{t('drools.noModelsAvailable')}</Text>
          ) : (
            visibleItems.map((modelId, index) => {
              const globalIndex = windowStart + index;
              const isSelected = globalIndex === selectedIndex;
              const isCurrent = modelId === currentFallback;
              return (
                <Text
                  key={modelId}
                  color={isSelected ? COLORS.primary : COLORS.text.primary}
                >
                  {isSelected ? '> ' : '  '}
                  {modelId}
                  {isCurrent && (
                    <Text color={COLORS.text.muted}>
                      {' '}
                      {t('drools.modelFallbackCurrentTag')}
                    </Text>
                  )}
                </Text>
              );
            })
          )}
        </Box>
      </Box>
    </MenuContainer>
  );
}
