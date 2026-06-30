import { Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { McpSettingsManager } from '@industry/runtime/settings';

import { getRegistryServers } from '@/commands/mcp/registry/servers';
import { McpMenuList } from '@/commands/mcp/views/McpMenuList';
import { COLORS } from '@/components/chat/themedColors';
import { TextInput } from '@/components/common/TextInput';
import { KeypressLayer } from '@/contexts/enums';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { cleanPastedText } from '@/utils/pasteHandler';

import type { RegistryServer, McpPolicy } from '@industry/common/settings';

interface RegistryListViewProps {
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  onSelect: (server: RegistryServer) => void;
  mcpPolicy?: McpPolicy;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function RegistryListView({
  selectedIndex,
  setSelectedIndex,
  onSelect,
  mcpPolicy,
}: RegistryListViewProps) {
  const { t } = useTranslation('common');
  const registryServers = getRegistryServers();
  const [searchQuery, setSearchQuery] = useState('');

  const policyEnabled = mcpPolicy?.enabled === true;

  const allowedServers = useMemo(() => {
    if (!policyEnabled) return registryServers;
    return registryServers.filter((server) =>
      McpSettingsManager.isServerAllowedByPolicy(server, mcpPolicy)
    );
  }, [registryServers, policyEnabled, mcpPolicy]);

  const filteredServers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return allowedServers;
    }

    return allowedServers.filter((server) =>
      server.name.toLowerCase().includes(query)
    );
  }, [allowedServers, searchQuery]);

  const maxSelectableIndex = Math.max(filteredServers.length - 1, 0);

  const setClampedSelectedIndex = (
    next: number | ((prev: number) => number)
  ) => {
    setSelectedIndex((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      return clamp(resolved, 0, maxSelectableIndex);
    });
  };

  const clampedSelectedIndex = clamp(selectedIndex, 0, maxSelectableIndex);

  // Handle navigation
  useKeypressHandler(
    (_input, key) => {
      if (key.upArrow) {
        setClampedSelectedIndex((prev) => prev - 1);
        return true;
      }

      if (key.downArrow) {
        setClampedSelectedIndex((prev) => prev + 1);
        return true;
      }

      if (key.return) {
        if (
          clampedSelectedIndex >= 0 &&
          clampedSelectedIndex < filteredServers.length
        ) {
          onSelect(filteredServers[clampedSelectedIndex]);
          return true;
        }
        return false;
      }

      return false;
    },
    { layer: KeypressLayer.Navigation }
  );

  const items = filteredServers.map((server) => ({
    key: `registry-${server.name}`,
    label: server.name,
    value: server.name,
    suffix: ` - ${server.description}`,
    suffixColor: COLORS.text.muted,
  }));

  const showNoResults = searchQuery.trim().length > 0 && items.length === 0;

  return (
    <McpMenuList
      title={t('mcpViews.registryList.title')}
      items={items}
      selectedIndex={selectedIndex}
      helpText={t('mcpViews.registryList.hint')}
    >
      <Box marginBottom={1}>
        <Text color={COLORS.primary}>
          {t('mcpViews.registryList.searchLabel')}
        </Text>
        <TextInput
          value={searchQuery}
          onChange={(value) => {
            setSearchQuery(cleanPastedText(value));
            setClampedSelectedIndex(0);
          }}
          placeholder={t('mcpViews.registryList.searchPlaceholder')}
        />
      </Box>
      {policyEnabled ? (
        <Text color={COLORS.text.muted}>
          {t('mcpViews.registryList.policyNote')}
        </Text>
      ) : null}
      {showNoResults && !policyEnabled && (
        <Text color={COLORS.text.muted}>
          {t('mcpViews.registryList.noMatch', { query: searchQuery })}
        </Text>
      )}
      {policyEnabled && allowedServers.length === 0 ? (
        <Text color={COLORS.warning}>
          {t('mcpViews.registryList.policyEmpty')}
        </Text>
      ) : null}
      {showNoResults && policyEnabled && allowedServers.length > 0 ? (
        <Text color={COLORS.text.muted}>
          {t('mcpViews.registryList.noMatch', { query: searchQuery })}
        </Text>
      ) : null}
    </McpMenuList>
  );
}
