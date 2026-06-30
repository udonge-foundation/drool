import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import type { RewindMenuProps } from '@/components/types';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

const VISIBLE_COUNT = 10;

export function RewindMenu({ options, onSelect, onCancel }: RewindMenuProps) {
  const { t } = useTranslation();
  const [windowStart, setWindowStart] = useState(0);

  const { selectedIndex } = useMenuNavigation({
    items: options,
    initialIndex: 0,
    wrapAround: true,
    onSelect: (option) => {
      if (options.length > 0) {
        onSelect(option);
      }
    },
    onCancel,
  });

  useEffect(() => {
    if (selectedIndex < windowStart) {
      setWindowStart(selectedIndex);
    } else if (selectedIndex >= windowStart + VISIBLE_COUNT) {
      setWindowStart(selectedIndex - VISIBLE_COUNT + 1);
    }
  }, [selectedIndex, windowStart]);

  const visibleSlice = useMemo(() => {
    const end = Math.min(windowStart + VISIBLE_COUNT, options.length);
    return options.slice(windowStart, end);
  }, [options, windowStart]);

  if (options.length === 0) {
    return (
      <MenuContainer title={t('common:rewindMenu.title')}>
        <Text color={COLORS.warning}>{t('common:rewindMenu.noMessages')}</Text>
      </MenuContainer>
    );
  }

  const startDisplay = options.length === 0 ? 0 : windowStart + 1;
  const endDisplay = Math.min(windowStart + VISIBLE_COUNT, options.length);

  return (
    <MenuContainer
      title={t('common:rewindMenu.title')}
      helpText={t('common:rewindMenu.helpText', {
        start: startDisplay,
        end: endDisplay,
        total: options.length,
      })}
      showDefaultHelp={false}
    >
      <Box marginTop={1} marginBottom={1} flexDirection="row">
        <Box width={6}>
          <Text color={COLORS.text.muted}>
            {t('common:rewindMenu.columnNumber')}
          </Text>
        </Box>
        <Text color={COLORS.text.muted}>
          {t('common:rewindMenu.columnPreview')}
        </Text>
      </Box>
      {visibleSlice.map((option, index) => {
        const globalIndex = windowStart + index;
        const isSelected = globalIndex === selectedIndex;
        const color = isSelected ? COLORS.primary : undefined;

        return (
          <Box key={option.messageId} flexDirection="row">
            <Box width={6}>
              <Text color={color}>{isSelected ? '> ' : '  '}</Text>
              <Text color={color}>{option.historyIndex + 1}</Text>
            </Box>
            <Text color={color}> {option.preview}</Text>
          </Box>
        );
      })}
    </MenuContainer>
  );
}
