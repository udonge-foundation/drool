import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

interface CompactionLimitSelectorProps {
  currentLimit: number;
  onSelect: (limit: number) => void;
  onCancel: () => void;
  title?: string;
}

interface CompactionLimitOption {
  value: number;
  label: string;
  recommended?: boolean;
  warning?: boolean;
}

const RECOMMENDED_VALUE = 250_000;

const COMPACTION_LIMIT_OPTIONS: CompactionLimitOption[] = [
  { value: 100_000, label: '100K' },
  { value: 200_000, label: '200K' },
  { value: RECOMMENDED_VALUE, label: '250K', recommended: true },
  { value: 300_000, label: '300K' },
  { value: 400_000, label: '400K', warning: true },
  { value: 500_000, label: '500K', warning: true },
  { value: 600_000, label: '600K', warning: true },
  { value: 700_000, label: '700K', warning: true },
  { value: 800_000, label: '800K', warning: true },
  { value: 900_000, label: '900K', warning: true },
  { value: 1_000_000, label: '1M', warning: true },
];

function formatLimit(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  return `${value / 1_000}K`;
}

export function CompactionLimitSelector({
  currentLimit,
  onSelect,
  onCancel,
  title,
}: CompactionLimitSelectorProps) {
  const { t } = useTranslation();

  const options = COMPACTION_LIMIT_OPTIONS;
  const knownIndex = options.findIndex((opt) => opt.value === currentLimit);
  const isCurrentKnown = knownIndex >= 0;
  const recommendedIndex = options.findIndex((opt) => opt.recommended);
  const initialIndex = isCurrentKnown ? knownIndex : recommendedIndex;

  const { selectedIndex } = useMenuNavigation({
    items: options,
    initialIndex,
    wrapAround: true,
    onSelect: (option) => {
      if (option.value === currentLimit) {
        onCancel();
      } else {
        onSelect(option.value);
      }
    },
    onCancel,
  });

  return (
    <MenuContainer
      title={title ?? t('common:compactionLimitSelector.title')}
      paddingY={0}
    >
      {!isCurrentKnown && (
        <Box paddingLeft={2} marginBottom={0}>
          <Text dimColor color={COLORS.text.muted}>
            {t('common:compactionLimitSelector.currentCustom', {
              value: formatLimit(currentLimit),
            })}
          </Text>
        </Box>
      )}
      {options.map((option, index) => {
        const isSelected = index === selectedIndex;
        const isCurrent = option.value === currentLimit;

        return (
          <Box key={option.value} flexDirection="column" marginBottom={0}>
            <Box>
              <Box width={2}>
                <Text color={isSelected ? COLORS.primary : undefined}>
                  {isSelected ? '>' : ' '}
                </Text>
              </Box>
              <Text
                bold={isSelected}
                color={isSelected ? COLORS.primary : undefined}
              >
                {option.label}
                {option.recommended && (
                  <Text dimColor color={COLORS.text.muted}>
                    {' '}
                    {t('common:compactionLimitSelector.recommended')}
                  </Text>
                )}
                {isCurrent && (
                  <Text dimColor color={COLORS.text.muted}>
                    {' '}
                    {t('common:compactionLimitSelector.current')}
                  </Text>
                )}
              </Text>
            </Box>
            {isSelected && option.warning && (
              <Box paddingLeft={4}>
                <Text dimColor color={COLORS.warning}>
                  {t('common:compactionLimitSelector.warning')}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
      <Box marginTop={1} paddingLeft={2}>
        <Text dimColor>
          {t('common:compactionLimitSelector.modelLimitNote')}
        </Text>
      </Box>
    </MenuContainer>
  );
}
