import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Computer } from '@industry/common/api/v0/computers';

import { COLORS } from '@/components/chat/themedColors';
import { FilterableMenuContainer } from '@/components/common/FilterableMenuContainer';
import { MenuContainer } from '@/components/common/MenuContainer';
import { SelectableList } from '@/components/SelectableList';
import type { SelectableListItem } from '@/components/types';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

interface ComputerStepProps {
  computers: Computer[];
  onSelect: (computer: Computer) => void;
}

const VISIBLE_COUNT = 10;

export function ComputerStep({ computers, onSelect }: ComputerStepProps) {
  const { t } = useTranslation('commands');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return computers;
    return computers.filter((c) => c.name.toLowerCase().includes(q));
  }, [computers, search]);

  const items: SelectableListItem[] = useMemo(
    () =>
      filtered.map((c) => ({
        label: c.name,
        value: c.id,
      })),
    [filtered]
  );

  // `enableCharKeys: false` so typing in the search input doesn't get
  // intercepted as menu nav (j/k/q). Escape is owned by the parent
  // `useEscapeHandler` in the orchestrator, so onCancel is a noop.
  const { selectedIndex, setSelectedIndex } = useMenuNavigation({
    items: filtered,
    onSelect: (computer) => onSelect(computer),
    onCancel: () => {},
    enableCharKeys: false,
    wrapAround: false,
    isActive: computers.length > 0,
  });

  // Reset the cursor to the top whenever the search query changes so the
  // first match is always visible immediately after typing/clearing.
  useEffect(() => {
    setSelectedIndex(0);
  }, [search, setSelectedIndex]);

  // Empty-org has its own dedicated UX (warning + recovery hint), so it
  // doesn't fit the generic list's empty-message slot.
  if (computers.length === 0) {
    return (
      <MenuContainer
        title={t('slashMessages.setupIncidentResponse.computerStep.title')}
        helpText={t(
          'slashMessages.setupIncidentResponse.computerStep.helpEmpty'
        )}
        showDefaultHelp={false}
      >
        <Box flexDirection="column">
          <Text color={COLORS.warning}>
            {t('slashMessages.setupIncidentResponse.computerStep.empty')}
          </Text>
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('slashMessages.setupIncidentResponse.computerStep.emptyHint')}
            </Text>
          </Box>
        </Box>
      </MenuContainer>
    );
  }

  const trimmed = search.trim();
  const noMatches = filtered.length === 0;

  return (
    <FilterableMenuContainer
      title={t('slashMessages.setupIncidentResponse.computerStep.title')}
      helpText={t('slashMessages.setupIncidentResponse.computerStep.help')}
      searchValue={search}
      onSearchChange={setSearch}
      searchPlaceholder={t(
        'slashMessages.setupIncidentResponse.computerStep.searchPlaceholder'
      )}
    >
      {noMatches ? (
        <Box height={VISIBLE_COUNT}>
          <Text color={COLORS.text.muted}>
            {t('slashMessages.setupIncidentResponse.computerStep.noMatches', {
              query: trimmed,
            })}
          </Text>
        </Box>
      ) : (
        <SelectableList
          items={items}
          selectedIndex={selectedIndex}
          visibleCount={VISIBLE_COUNT}
          minVisibleCount={VISIBLE_COUNT}
          marginTop={0}
          noBorder
        />
      )}
    </FilterableMenuContainer>
  );
}
