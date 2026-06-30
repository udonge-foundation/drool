import { Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { getReasoningEffortDisplayName } from '@/models/config';

interface ReasoningEffortSelectorProps {
  currentEffort: ReasoningEffort;
  supportedEfforts: ReasoningEffort[];
  onSelect: (effort: ReasoningEffort) => void;
  onCancel: () => void;
  title?: string;
}

export function ReasoningEffortSelector({
  currentEffort,
  supportedEfforts,
  onSelect,
  onCancel,
  title,
}: ReasoningEffortSelectorProps) {
  const { t } = useTranslation();
  const initialIndex = supportedEfforts.findIndex(
    (effort) => effort === currentEffort
  );

  const { selectedIndex } = useMenuNavigation({
    items: supportedEfforts,
    initialIndex: initialIndex >= 0 ? initialIndex : 0,
    onSelect: (effort) => onSelect(effort),
    onCancel,
  });

  return (
    <MenuContainer title={title ?? t('common:reasoningEffort.title')}>
      {supportedEfforts.map((effort, index) => {
        const isSelected = index === selectedIndex;
        const isCurrent = effort === currentEffort;
        const color: string | undefined = isSelected
          ? COLORS.primary
          : undefined;

        return (
          <Text key={effort} color={color}>
            {isSelected ? '> ' : '  '}
            {getReasoningEffortDisplayName(effort)}
            {isCurrent && (
              <Text color={COLORS.text.secondary}>
                {' '}
                {t('common:reasoningEffort.current')}
              </Text>
            )}
          </Text>
        );
      })}
    </MenuContainer>
  );
}
