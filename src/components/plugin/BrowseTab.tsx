import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { TextInput } from '@/components/common/TextInput';
import type { BrowsePluginInfo } from '@/hooks/types';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import {
  displayWidth as getDisplayWidth,
  padEndByDisplayWidth,
} from '@/utils/displayWidth';
import { cleanPastedText } from '@/utils/pasteHandler';

// Maximum number of rows to display at once
const VISIBLE_COUNT = 8;

interface BrowseTabProps {
  onSelectPlugin: (plugin: BrowsePluginInfo) => void;
}

interface AvailablePlugin {
  name: string;
  marketplace: string;
  description?: string;
}

export function BrowseTab({ onSelectPlugin }: BrowseTabProps) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<AvailablePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMarketplaces, setHasMarketplaces] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const loadPlugins = async () => {
    try {
      setLoading(true);
      setError(null);
      const manager = PluginMarketplaceManager.getInstance();

      const marketplaces = await manager.listMarketplaces();
      if (marketplaces.length === 0) {
        setHasMarketplaces(false);
        setPlugins([]);
        return;
      }

      setHasMarketplaces(true);
      const available = await manager.listAvailablePlugins();
      setPlugins(available);
    } catch (err) {
      logException(err, 'Failed to load available plugins');
      setError(t('common:plugins.failedToLoadPlugins'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPlugins();
  }, []);

  const filteredPlugins = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return plugins;
    return plugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(query) ||
        plugin.marketplace.toLowerCase().includes(query) ||
        plugin.description?.toLowerCase().includes(query)
    );
  }, [plugins, searchQuery]);

  const menuOptions = useMemo(
    () =>
      filteredPlugins.map((plugin) => ({
        type: 'plugin' as const,
        plugin,
      })),
    [filteredPlugins]
  );

  const { selectedIndex } = useMenuNavigation({
    items: menuOptions,
    initialIndex: 0,
    onSelect: (selected) => {
      onSelectPlugin({
        name: selected.plugin.name,
        marketplace: selected.plugin.marketplace,
        description: selected.plugin.description,
      });
    },
    onCancel: () => {
      // ESC is handled by parent PluginTabs component
    },
    isActive: plugins.length > 0,
    enableCharKeys: false,
  });

  const { width: terminalWidth } = useTerminalDimensions();

  const maxPluginNameWidth = useMemo(() => {
    let max = 0;
    for (const p of filteredPlugins) {
      const w = getDisplayWidth(`${p.name}@${p.marketplace}`);
      if (w > max) max = w;
    }
    return max;
  }, [filteredPlugins]);

  if (loading) {
    return (
      <Text color={COLORS.text.muted}>
        {t('common:plugins.loadingPlugins')}
      </Text>
    );
  }

  if (error) {
    return (
      <Text color={COLORS.error}>
        {t('common:plugins.errorPrefix', { error })}
      </Text>
    );
  }

  if (!hasMarketplaces) {
    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {t('common:plugins.addMarketplaceHint')}
        </Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:plugins.useMarketplacesTab')}
          </Text>
        </Box>
      </Box>
    );
  }

  if (plugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {t('common:plugins.allInstalled')}
        </Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:plugins.checkInstalledTab')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Calculate visible slice
  const { windowStart, visibleItems: visibleSlice } = getWindowedListSlice({
    items: menuOptions,
    selectedIndex,
    visibleCount: VISIBLE_COUNT,
    anchorRow: 2,
  });
  const end = Math.min(
    windowStart + visibleSlice.length,
    filteredPlugins.length
  );
  const showNoResults =
    searchQuery.trim().length > 0 && filteredPlugins.length === 0;

  return (
    <Box flexDirection="column">
      {/* Search input */}
      <Box marginBottom={1}>
        <TextInput
          value={searchQuery}
          onChange={(value) => {
            setSearchQuery(cleanPastedText(value));
          }}
          placeholder={t('common:plugins.filterPlaceholder')}
        />
      </Box>

      {/* Pagination indicator */}
      {filteredPlugins.length > 0 && (
        <Box marginBottom={1}>
          <Text color={COLORS.text.muted}>
            {t('common:plugins.pluginRange', {
              start: windowStart + 1,
              end,
              total: filteredPlugins.length,
            })}
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        {/* No results message */}
        {showNoResults && (
          <Text color={COLORS.text.muted}>
            {t('common:plugins.noPluginsMatch', { query: searchQuery })}
          </Text>
        )}

        {visibleSlice.map((option, index) => {
          const globalIndex = windowStart + index;
          const isSelected = globalIndex === selectedIndex;
          const { plugin } = option;
          const pluginLabel = `${plugin.name}@${plugin.marketplace}`;
          const labelColor: string | undefined = isSelected
            ? COLORS.text.primary
            : COLORS.text.muted;
          const gap = 6;
          const fixedWidth = 2 + maxPluginNameWidth + gap;
          const descWidth = Math.max(0, terminalWidth - fixedWidth - 4);
          return (
            <Box key={`${plugin.marketplace}-${plugin.name}`}>
              <Box width={2}>
                <Text> </Text>
              </Box>
              <Box width={maxPluginNameWidth}>
                <Text bold={isSelected} color={labelColor} wrap="truncate-end">
                  {padEndByDisplayWidth(pluginLabel, maxPluginNameWidth)}
                </Text>
              </Box>
              {plugin.description && (
                <Box width={descWidth + gap}>
                  <Text color={COLORS.text.muted} wrap="truncate-end">
                    {'      '}
                    {plugin.description}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
