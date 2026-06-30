import { Box, Text } from 'ink';
import { useState, useMemo, useCallback } from 'react';

import { parseUserModelSelection } from '@industry/utils/llm';

import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { getTuiModelConfig } from '@/models/config';
import { getSettingsService } from '@/services/SettingsService';

import type { UserModelSelection } from '@industry/common/llm';

function formatLabel(modelId: string): string {
  const cfg = getTuiModelConfig(modelId);
  const baseName = cfg.shortDisplayName || cfg.displayName || String(modelId);
  return baseName;
}

interface InlineModelCyclePickerProps {
  availableModels: string[];
  currentModel: string;
  onSelect: (modelId: UserModelSelection) => void;
  onCancel: () => void;
}

function getVisibleCycleRows(
  modelIds: string[],
  selectedIndex: number
): { model: string; index: number }[] {
  const length = modelIds.length;
  if (length === 0) return [];

  const normalize = (index: number) => ((index % length) + length) % length;
  const currentIndex = normalize(selectedIndex);

  if (length === 1) {
    return [{ model: modelIds[currentIndex], index: currentIndex }];
  }

  if (length === 2) {
    const nextIndex = normalize(currentIndex + 1);
    return [
      { model: modelIds[currentIndex], index: currentIndex },
      { model: modelIds[nextIndex], index: nextIndex },
    ];
  }

  const prevIndex = normalize(currentIndex - 1);
  const nextIndex = normalize(currentIndex + 1);
  return [
    { model: modelIds[prevIndex], index: prevIndex },
    { model: modelIds[currentIndex], index: currentIndex },
    { model: modelIds[nextIndex], index: nextIndex },
  ];
}

export function InlineModelCyclePicker({
  availableModels,
  currentModel,
  onSelect,
  onCancel,
}: InlineModelCyclePickerProps) {
  const settingsService = getSettingsService();

  const allowedModels = useMemo(
    () =>
      availableModels.filter(
        (id) => settingsService.validateModelAccess(id).allowed
      ),
    [availableModels, settingsService]
  );

  const currentIndex = allowedModels.indexOf(currentModel);
  const initialIndex = currentIndex >= 0 ? currentIndex : 0;
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  const getWrappedIndex = useCallback(
    (idx: number): number => {
      const len = allowedModels.length;
      if (len === 0) return 0;
      return ((idx % len) + len) % len;
    },
    [allowedModels.length]
  );

  const maxLabelWidth = useMemo(() => {
    let max = 0;
    for (const id of allowedModels) {
      const label = formatLabel(id);
      if (label.length > max) max = label.length;
    }
    return max;
  }, [allowedModels]);

  useKeypressHandler((input, key) => {
    if (matchKeyboardChord({ key, input }, 'escape')) {
      onCancel();
      return;
    }

    if (matchKeyboardChord({ key, input }, 'model-cycle')) {
      if (allowedModels.length > 0) {
        setSelectedIndex((prev) => getWrappedIndex(prev + 1));
      }
      return;
    }

    if (matchKeyboardChord({ key, input }, 'enter')) {
      const model = allowedModels[getWrappedIndex(selectedIndex)];
      if (model) {
        const parsed = parseUserModelSelection(model);
        if (parsed !== undefined) onSelect(parsed);
      }
      return;
    }

    if (matchKeyboardChord({ key, input }, 'up-arrow')) {
      setSelectedIndex((prev) => getWrappedIndex(prev - 1));
      return;
    }

    if (matchKeyboardChord({ key, input }, 'down-arrow')) {
      setSelectedIndex((prev) => getWrappedIndex(prev + 1));
    }
  });

  if (allowedModels.length === 0) {
    return null;
  }

  const normalizedSelectedIndex = getWrappedIndex(selectedIndex);

  const rows = getVisibleCycleRows(allowedModels, normalizedSelectedIndex).map(
    (row) => ({
      ...row,
      label: formatLabel(row.model),
    })
  );

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const isCurrent = row.model === currentModel;
        const isSelected = row.index === normalizedSelectedIndex;
        return (
          <Box key={`${row.model}-${row.index}-${i}`}>
            <Text>{' '.repeat(maxLabelWidth - row.label.length)}</Text>
            <Text
              bold={isSelected}
              color={isSelected ? COLORS.text.primary : COLORS.text.muted}
            >
              {row.label}
            </Text>
            <Text color={isCurrent ? COLORS.primary : undefined}>
              {isCurrent ? ' ●' : '  '}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
