import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getDroolLoaderSingleton } from '@/services/drools/CustomDroolRegistry';
import { DroolStorageService } from '@/services/drools/DroolStorageService';
import { DroolConfig } from '@/services/drools/types';

interface DeleteDroolFlowProps {
  drool?: DroolConfig;
  onComplete: () => void;
  onCancel: () => void;
}

type DeleteStep = 'select' | 'confirm';

export function DeleteDroolFlow({
  drool,
  onComplete,
  onCancel,
}: DeleteDroolFlowProps) {
  const { t } = useTranslation('common');
  const [drools, setDrools] = useState<DroolConfig[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedDrool, setSelectedDrool] = useState<DroolConfig | null>(
    drool || null
  );
  const [currentStep, setCurrentStep] = useState<DeleteStep>(
    drool ? 'confirm' : 'select'
  );
  const [loading, setLoading] = useState(!drool);
  const [error, setError] = useState<string | null>(null);

  const loadDrools = async () => {
    try {
      const loader = getDroolLoaderSingleton();
      const loadedDrools = await loader.loadAllDrools();
      setDrools(loadedDrools);
      setLoading(false);
    } catch (err) {
      logException(err, 'Failed to load drools for deletion');
      onCancel();
    }
  };

  const handleDeleteDrool = async () => {
    if (!selectedDrool) return;

    try {
      const storage = new DroolStorageService();
      await storage.deleteDrool(
        selectedDrool.metadata.name,
        selectedDrool.location
      );
      onComplete();
    } catch (err) {
      logException(err, 'Failed to delete drool');
      setError(t('deleteDrool.failedToDelete'));
    }
  };

  useEffect(() => {
    if (!drool) {
      void loadDrools();
    }
  }, [drool]);

  useKeypressHandler(
    (_input, key) => {
      if (key.escape) {
        if (currentStep === 'confirm' && !drool) {
          // Go back to selection
          setCurrentStep('select');
          setSelectedDrool(null);
          setSelectedIndex(0);
        } else {
          onCancel();
        }
        return;
      }

      if (currentStep === 'select') {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }

        if (key.downArrow) {
          setSelectedIndex((prev) => Math.min(drools.length - 1, prev + 1));
          return;
        }

        if (key.return) {
          setSelectedDrool(drools[selectedIndex]);
          setCurrentStep('confirm');
          setSelectedIndex(0); // Reset for Yes/No selection
        }
      } else if (currentStep === 'confirm') {
        if (key.upArrow || key.downArrow) {
          setSelectedIndex((prev) => (prev === 0 ? 1 : 0));
          return;
        }

        if (key.return) {
          if (selectedIndex === 0) {
            // Yes, delete
            void handleDeleteDrool();
          } else if (drool) {
            // Cancel
            onCancel();
          } else {
            setCurrentStep('select');
            setSelectedDrool(null);
            setSelectedIndex(0);
          }
        }
      }
    },
    { isActive: true }
  );

  if (loading) {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Text color={COLORS.text.muted}>{t('deleteDrool.loadingDrools')}</Text>
      </Box>
    );
  }

  if (currentStep === 'select' && drools.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('deleteDrool.title')}</Text>
          <Text color={COLORS.text.muted}>
            {t('deleteDrool.noDroolsAvailable')}
          </Text>
        </Box>
      </Box>
    );
  }

  if (currentStep === 'select') {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('deleteDrool.title')}</Text>
          <Text color={COLORS.text.muted}>
            {t('deleteDrool.selectToDelete')}
          </Text>
          <Box marginTop={1} />

          <Box flexDirection="column">
            {drools.map((d, index) => {
              const isSelected = index === selectedIndex;
              const color = isSelected ? COLORS.primary : COLORS.text.primary;
              const locationBadge =
                d.location === 'project'
                  ? t('deleteDrool.projectBadge')
                  : t('deleteDrool.personalBadge');

              return (
                <Text key={d.metadata.name} color={color}>
                  {isSelected ? '> ' : '  '}
                  {d.metadata.name} {locationBadge}
                </Text>
              );
            })}
          </Box>

          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('deleteDrool.navigationHint')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Confirmation step
  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.border}
      paddingX={2}
      paddingY={1}
    >
      <Box flexDirection="column">
        <Text bold>{t('deleteDrool.title')}</Text>
        <Text color={COLORS.text.muted}>{t('deleteDrool.confirmTitle')}</Text>
        <Box marginTop={1} />

        <Text>
          {t('deleteDrool.confirmPrompt', {
            name: selectedDrool?.metadata.name,
          })}
        </Text>
        <Text color={COLORS.text.muted}>{t('deleteDrool.cannotBeUndone')}</Text>
        <Box marginTop={1} />

        <Box flexDirection="column">
          <Text
            color={selectedIndex === 0 ? COLORS.error : COLORS.text.primary}
          >
            {selectedIndex === 0 ? '> ' : '  '}
            {t('deleteDrool.yesDelete')}
          </Text>
          <Text
            color={selectedIndex === 1 ? COLORS.primary : COLORS.text.primary}
          >
            {selectedIndex === 1 ? '> ' : '  '}
            {t('deleteDrool.cancel')}
          </Text>
        </Box>

        {error && (
          <Box marginTop={1}>
            <Text color={COLORS.error}>
              {t('deleteDrool.errorPrefix', { error })}
            </Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('deleteDrool.navigationHint')}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
