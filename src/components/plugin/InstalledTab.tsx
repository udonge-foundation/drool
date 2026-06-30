import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { parsePluginId } from '@industry/runtime/plugins';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import type { InstalledPluginInfo } from '@/hooks/types';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import {
  displayWidth as getDisplayWidth,
  padEndByDisplayWidth,
} from '@/utils/displayWidth';

import type { InstalledPluginEntry } from '@industry/common/settings';
import type {
  FailedPluginInstall,
  PluginLoadWarning,
} from '@industry/runtime/plugins';

// Maximum number of rows to display at once
const VISIBLE_COUNT = 10;
const SCROLL_ANCHOR = 5;

type MenuOption =
  | {
      type: 'plugin';
      id: string;
      entry: InstalledPluginEntry;
      hasWarnings: boolean;
    }
  | { type: 'header'; label: string }
  | { type: 'failed'; failed: FailedPluginInstall };

interface InstalledTabProps {
  onSelectPlugin: (plugin: InstalledPluginInfo) => void;
  onSelectFailedPlugin: (failed: FailedPluginInstall) => void;
}

function parseInstalledPluginId(id: string): {
  name: string;
  marketplace: string;
} {
  const parsed = parsePluginId(id);
  if (parsed) {
    return { name: parsed.pluginName, marketplace: parsed.marketplace };
  }
  return { name: id, marketplace: 'unknown' };
}

function formatVersion(version: string): string {
  return version.substring(0, 7);
}

export function InstalledTab({
  onSelectPlugin,
  onSelectFailedPlugin,
}: InstalledTabProps) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<
    Array<{ id: string; entry: InstalledPluginEntry }>
  >([]);
  const [failedPlugins, setFailedPlugins] = useState<FailedPluginInstall[]>([]);
  const [pluginWarnings, setPluginWarnings] = useState<
    Map<string, PluginLoadWarning[]>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowStart, setWindowStart] = useState(0);

  const loadPlugins = async () => {
    try {
      setLoading(true);
      setError(null);
      const manager = PluginMarketplaceManager.getInstance();
      const installed = (await manager.listInstalledPluginStatuses()).map(
        ({ id, entry }) => ({ id, entry })
      );
      const failed = manager.getFailedPluginInstalls();
      const warnings = manager.getPluginLoadWarningsByPlugin();
      setPlugins(installed);
      setFailedPlugins(failed);
      setPluginWarnings(warnings);
    } catch (err) {
      logException(err, 'Failed to load installed plugins');
      setError(t('common:plugins.failedToLoadPlugins'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPlugins();
  }, []);

  const menuOptions = useMemo(() => {
    const options: MenuOption[] = [];

    // Add installed plugins
    if (plugins.length > 0) {
      plugins.forEach(({ id, entry }) => {
        const hasWarnings = pluginWarnings.has(id);
        options.push({ type: 'plugin', id, entry, hasWarnings });
      });
    }

    // Add failed plugins section if any
    if (failedPlugins.length > 0) {
      options.push({
        type: 'header',
        label: t('common:plugins.failedToInstallHeader'),
      });
      failedPlugins.forEach((failed) => {
        options.push({ type: 'failed', failed });
      });
    }

    return options;
  }, [plugins, failedPlugins, pluginWarnings]);

  const { selectedIndex } = useMenuNavigation({
    items: menuOptions,
    initialIndex: 0,
    isSelectable: (option) => option.type !== 'header',
    onSelect: (selected) => {
      if (selected.type === 'plugin') {
        const { name, marketplace } = parseInstalledPluginId(selected.id);
        onSelectPlugin({
          id: selected.id,
          name,
          marketplace,
          scope: selected.entry.scope,
          version: selected.entry.version,
          installPath: selected.entry.installPath,
          installedAt: selected.entry.installedAt,
          lastUpdated: selected.entry.lastUpdated,
          source: selected.entry.source,
        });
      } else if (selected.type === 'failed') {
        onSelectFailedPlugin(selected.failed);
      }
    },
    onCancel: () => {
      // ESC is handled by parent PluginTabs component
    },
    isActive:
      menuOptions.length > 0 && menuOptions.some((o) => o.type !== 'header'),
    onIndexChange: (newIndex) => {
      const idealStart = newIndex - SCROLL_ANCHOR;
      const maxStart = Math.max(0, menuOptions.length - VISIBLE_COUNT);
      setWindowStart(Math.max(0, Math.min(idealStart, maxStart)));
    },
  });

  const { width: terminalWidth } = useTerminalDimensions();

  const maxPluginIdWidth = useMemo(() => {
    let max = 0;
    for (const opt of menuOptions) {
      if (opt.type === 'plugin') {
        const w = getDisplayWidth(opt.id);
        if (w > max) max = w;
      } else if (opt.type === 'failed') {
        const w = getDisplayWidth(opt.failed.pluginId);
        if (w > max) max = w;
      }
    }
    return max;
  }, [menuOptions]);

  if (loading) {
    return (
      <Text color={COLORS.text.muted}>
        {t('common:plugins.loadingInstalledPlugins')}
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

  if (plugins.length === 0 && failedPlugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {t('common:plugins.noPluginsInstalled')}
        </Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:plugins.browseHint')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Calculate visible slice
  const end = Math.min(windowStart + VISIBLE_COUNT, menuOptions.length);
  const visibleSlice = menuOptions.slice(windowStart, end);

  return (
    <Box flexDirection="column">
      {visibleSlice.map((option, index) => {
        const globalIndex = windowStart + index;
        const isSelected = globalIndex === selectedIndex;

        if (option.type === 'header') {
          return (
            <Box key={`header-${index}`} marginTop={1}>
              <Text color={COLORS.text.muted}>{option.label}</Text>
            </Box>
          );
        }

        if (option.type === 'failed') {
          const labelColor: string | undefined = isSelected
            ? COLORS.text.primary
            : COLORS.warning;
          const gap = 6;
          const fixedWidth = 2 + maxPluginIdWidth + gap;
          const detailWidth = Math.max(0, terminalWidth - fixedWidth - 4);
          return (
            <Box
              key={`failed-${option.failed.pluginId}:${option.failed.scope}`}
            >
              <Box width={2}>
                <Text> </Text>
              </Box>
              <Box width={maxPluginIdWidth}>
                <Text bold={isSelected} color={labelColor} wrap="truncate-end">
                  {padEndByDisplayWidth(
                    option.failed.pluginId,
                    maxPluginIdWidth
                  )}
                </Text>
              </Box>
              <Box width={detailWidth + gap}>
                <Text color={COLORS.text.muted} wrap="truncate-end">
                  {'      '}[{option.failed.scope}] - {option.failed.error}
                </Text>
              </Box>
            </Box>
          );
        }

        const labelColor: string | undefined = isSelected
          ? COLORS.text.primary
          : COLORS.text.muted;
        const meta = t('common:plugins.scopeVersionFormat', {
          scope: option.entry.scope,
          version: formatVersion(option.entry.version),
        });
        const warningPrefix = option.hasWarnings ? 2 : 0;
        const gap = 6;
        const fixedWidth = 2 + warningPrefix + maxPluginIdWidth + gap;
        const detailWidth = Math.max(0, terminalWidth - fixedWidth - 4);
        return (
          <Box key={`${option.id}:${option.entry.scope}`}>
            <Box width={2}>
              <Text> </Text>
            </Box>
            {option.hasWarnings && <Text color={COLORS.warning}>! </Text>}
            <Box width={maxPluginIdWidth}>
              <Text bold={isSelected} color={labelColor} wrap="truncate-end">
                {padEndByDisplayWidth(option.id, maxPluginIdWidth)}
              </Text>
            </Box>
            <Box width={detailWidth + gap}>
              <Text color={COLORS.text.muted} wrap="truncate-end">
                {'      '}
                {meta}
                {option.hasWarnings && t('common:plugins.partiallyLoaded')}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
