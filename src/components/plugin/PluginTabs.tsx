import { Box, Text } from 'ink';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { BrowseTab } from '@/components/plugin/BrowseTab';
import { PLUGIN_CONTENT_HEIGHT } from '@/components/plugin/constants';
import { InstalledTab } from '@/components/plugin/InstalledTab';
import { MarketplacesTab } from '@/components/plugin/MarketplacesTab';
import { PluginTab } from '@/hooks/enums';
import type {
  BrowsePluginInfo,
  InstalledPluginInfo,
  MarketplaceInfo,
} from '@/hooks/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';

import type { FailedPluginInstall } from '@industry/runtime/plugins';

const TABS: PluginTab[] = [
  PluginTab.Browse,
  PluginTab.Installed,
  PluginTab.Marketplaces,
];
const TAB_LABEL_KEYS: Record<PluginTab, string> = {
  [PluginTab.Browse]: 'common:plugins.tabBrowse',
  [PluginTab.Installed]: 'common:plugins.tabInstalled',
  [PluginTab.Marketplaces]: 'common:plugins.tabMarketplaces',
};

interface PluginTabsProps {
  activeTab: PluginTab;
  onTabChange: (tab: PluginTab) => void;
  onClose: () => void;
  onAddMarketplace: () => void;
  onDeleteMarketplace: (marketplace: MarketplaceInfo) => void;
  onSelectBrowsePlugin: (plugin: BrowsePluginInfo) => void;
  onSelectInstalledPlugin: (plugin: InstalledPluginInfo) => void;
  onSelectFailedPlugin: (failed: FailedPluginInstall) => void;
}

export function PluginTabs({
  activeTab,
  onTabChange,
  onClose,
  onAddMarketplace,
  onDeleteMarketplace,
  onSelectBrowsePlugin,
  onSelectInstalledPlugin,
  onSelectFailedPlugin,
}: PluginTabsProps) {
  const { t } = useTranslation();
  const { width: terminalWidth } = useTerminalDimensions();
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  useKeypressHandler((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    const currentTab = activeTabRef.current;

    if (key.tab) {
      const currentIndex = TABS.indexOf(currentTab);
      const newIndex = currentIndex < TABS.length - 1 ? currentIndex + 1 : 0;
      const nextTab = TABS[newIndex];
      activeTabRef.current = nextTab;
      onTabChange(nextTab);
    }
  });

  return (
    <MenuContainer
      title={t('common:plugins.title')}
      titleBold={false}
      width={terminalWidth}
      headerRight={
        <Box>
          {TABS.map((tab, index) => {
            const isActive = tab === activeTab;
            return (
              <Box key={tab}>
                {index > 0 && <Text color={COLORS.text.muted}> | </Text>}
                <Text color={isActive ? COLORS.primary : COLORS.text.muted}>
                  {isActive ? '◉' : '○'} {t(TAB_LABEL_KEYS[tab])}
                </Text>
              </Box>
            );
          })}
        </Box>
      }
      helpText="↑↓ navigate · Enter select · Tab switch tab · Esc cancel"
      showDefaultHelp={false}
    >
      <Box flexDirection="column" minHeight={PLUGIN_CONTENT_HEIGHT}>
        {activeTab === PluginTab.Browse && (
          <BrowseTab onSelectPlugin={onSelectBrowsePlugin} />
        )}
        {activeTab === PluginTab.Installed && (
          <InstalledTab
            onSelectPlugin={onSelectInstalledPlugin}
            onSelectFailedPlugin={onSelectFailedPlugin}
          />
        )}
        {activeTab === PluginTab.Marketplaces && (
          <MarketplacesTab
            onAddMarketplace={onAddMarketplace}
            onDeleteMarketplace={onDeleteMarketplace}
          />
        )}
      </Box>
    </MenuContainer>
  );
}
