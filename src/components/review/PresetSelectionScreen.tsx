import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { REVIEW_PRESETS } from '@/components/review/constants';
import type { ReviewPreset } from '@/components/review/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

type Props = {
  width: number;
  onSelect: (preset: ReviewPreset) => void;
};

export function PresetSelectionScreen({ width, onSelect }: Props) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useKeypressHandler((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) =>
        prev > 0 ? prev - 1 : REVIEW_PRESETS.length - 1
      );
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) =>
        prev < REVIEW_PRESETS.length - 1 ? prev + 1 : 0
      );
      return;
    }

    if (key.return) {
      onSelect(REVIEW_PRESETS[selectedIndex]);
      return;
    }

    // Handle number keys for quick selection (1-4)
    const num = parseInt(input, 10);
    if (num >= 1 && num <= REVIEW_PRESETS.length) {
      onSelect(REVIEW_PRESETS[num - 1]);
    }
  });

  const renderPreset = (preset: ReviewPreset, index: number) => {
    const isSelected = index === selectedIndex;
    const indicator = isSelected ? '› ' : '  ';
    const number = `${index + 1}.`;
    const color = isSelected ? COLORS.primary : undefined;
    const descriptionColor = isSelected ? undefined : COLORS.text.muted;

    return (
      <Box
        key={preset.id}
        flexDirection="row"
        marginBottom={index < REVIEW_PRESETS.length - 1 ? 1 : 0}
      >
        <Text color={color}>
          {indicator}
          {number} {t(preset.name)}
        </Text>
        {preset.description && (
          <Text color={descriptionColor} dimColor={!isSelected}>
            {' '}
            ({t(preset.description)})
          </Text>
        )}
      </Box>
    );
  };

  return (
    <Box
      width={width}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="round"
      borderColor={COLORS.border}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{t('common:review.presetTitle')}</Text>
          <Text color={COLORS.text.muted}>
            {t('common:review.presetSubtitle')}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          {REVIEW_PRESETS.map((preset, index) => renderPreset(preset, index))}
        </Box>

        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:review.presetHelp', { count: REVIEW_PRESETS.length })}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
