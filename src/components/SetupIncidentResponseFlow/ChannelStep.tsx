import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SlackChannel } from '@industry/common/integrations';

import { COLORS } from '@/components/chat/themedColors';
import { FilterableMenuContainer } from '@/components/common/FilterableMenuContainer';
import { SelectableList } from '@/components/SelectableList';
import type { SelectableListItem } from '@/components/types';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

interface ChannelStepProps {
  channels: SlackChannel[];
  listeningChannelIds: Set<string>;
  onSelect: (channel: SlackChannel) => void;
}

const VISIBLE_COUNT = 10;

export function ChannelStep({
  channels,
  listeningChannelIds,
  onSelect,
}: ChannelStepProps) {
  const { t } = useTranslation('commands');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((c) => c.name.toLowerCase().includes(q));
  }, [channels, search]);

  const items: SelectableListItem[] = useMemo(
    () =>
      filtered.map((c) => ({
        label: `#${c.name}`,
        value: c.id,
        suffix: listeningChannelIds.has(c.id)
          ? `  ${t('slashMessages.setupIncidentResponse.channelStep.alreadyConfigured')}`
          : undefined,
        suffixColor: COLORS.text.muted,
      })),
    [filtered, listeningChannelIds, t]
  );

  // `enableCharKeys: false` so typing in the search input doesn't get
  // intercepted as menu nav (j/k/q). Escape is owned by the parent
  // `useEscapeHandler` in the orchestrator, so onCancel is a noop.
  const { selectedIndex, setSelectedIndex } = useMenuNavigation({
    items: filtered,
    onSelect: (channel) => onSelect(channel),
    onCancel: () => {},
    enableCharKeys: false,
    wrapAround: false,
  });

  // Reset the cursor to the top whenever the search query changes so the
  // first match is always visible immediately after typing/clearing.
  useEffect(() => {
    setSelectedIndex(0);
  }, [search, setSelectedIndex]);

  const trimmed = search.trim();
  const isEmpty = filtered.length === 0;

  return (
    <FilterableMenuContainer
      title={t('slashMessages.setupIncidentResponse.channelStep.title')}
      description={t(
        'slashMessages.setupIncidentResponse.channelStep.description'
      )}
      helpText={t('slashMessages.setupIncidentResponse.channelStep.help')}
      searchValue={search}
      onSearchChange={setSearch}
      searchPlaceholder={t(
        'slashMessages.setupIncidentResponse.channelStep.searchPlaceholder'
      )}
    >
      {isEmpty ? (
        <Box height={VISIBLE_COUNT}>
          <Text color={COLORS.text.muted}>
            {channels.length === 0
              ? t('slashMessages.setupIncidentResponse.channelStep.empty')
              : t('slashMessages.setupIncidentResponse.channelStep.noMatches', {
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
