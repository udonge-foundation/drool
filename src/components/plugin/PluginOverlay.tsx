import { Box } from 'ink';
import { useState } from 'react';

import { AddMarketplaceFlow } from '@/components/marketplace/AddMarketplaceFlow';
import { DeleteMarketplaceFlow } from '@/components/marketplace/DeleteMarketplaceFlow';
import { FailedPluginActionsFlow } from '@/components/plugin/FailedPluginActionsFlow';
import { InstallPluginFlow } from '@/components/plugin/InstallPluginFlow';
import { PluginActionsFlow } from '@/components/plugin/PluginActionsFlow';
import { PluginTabs } from '@/components/plugin/PluginTabs';
import { PluginFlow, PluginTab } from '@/hooks/enums';
import type { UsePluginMenu } from '@/hooks/types';

interface PluginOverlayProps {
  width: number;
  controller: UsePluginMenu;
}

export function PluginOverlay({ width, controller }: PluginOverlayProps) {
  const {
    flow,
    setFlow,
    activeTab,
    setActiveTab,
    selectedMarketplace,
    setSelectedMarketplace,
    selectedBrowsePlugin,
    setSelectedBrowsePlugin,
    selectedInstalledPlugin,
    setSelectedInstalledPlugin,
    selectedFailedPlugin,
    setSelectedFailedPlugin,
    close,
  } = controller;

  // Key to force PluginTabs remount after add/delete/install operations
  const [tabsKey, setTabsKey] = useState(0);

  return (
    <Box width={width}>
      {flow === PluginFlow.Tabs && (
        <PluginTabs
          key={tabsKey}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onClose={close}
          onAddMarketplace={() => {
            setFlow(PluginFlow.AddMarketplace);
          }}
          onDeleteMarketplace={(marketplace) => {
            setSelectedMarketplace(marketplace);
            setFlow(PluginFlow.DeleteMarketplace);
          }}
          onSelectBrowsePlugin={(plugin) => {
            setSelectedBrowsePlugin(plugin);
            setFlow(PluginFlow.InstallPlugin);
          }}
          onSelectInstalledPlugin={(plugin) => {
            setSelectedInstalledPlugin(plugin);
            setFlow(PluginFlow.PluginActions);
          }}
          onSelectFailedPlugin={(failed) => {
            setSelectedFailedPlugin(failed);
            setFlow(PluginFlow.FailedPluginActions);
          }}
        />
      )}
      {flow === PluginFlow.AddMarketplace && (
        <AddMarketplaceFlow
          onComplete={() => {
            setTabsKey((k) => k + 1);
            setActiveTab(PluginTab.Marketplaces);
            setFlow(PluginFlow.Tabs);
          }}
          onCancel={() => {
            setFlow(PluginFlow.Tabs);
          }}
        />
      )}
      {flow === PluginFlow.DeleteMarketplace && selectedMarketplace && (
        <DeleteMarketplaceFlow
          marketplace={selectedMarketplace}
          onComplete={() => {
            setTabsKey((k) => k + 1);
            setFlow(PluginFlow.Tabs);
            setSelectedMarketplace(null);
          }}
          onCancel={() => {
            setFlow(PluginFlow.Tabs);
            setSelectedMarketplace(null);
          }}
        />
      )}
      {flow === PluginFlow.InstallPlugin && selectedBrowsePlugin && (
        <InstallPluginFlow
          plugin={selectedBrowsePlugin}
          onComplete={() => {
            setTabsKey((k) => k + 1);
            setActiveTab(PluginTab.Browse);
            setFlow(PluginFlow.Tabs);
            setSelectedBrowsePlugin(null);
          }}
          onCancel={() => {
            setFlow(PluginFlow.Tabs);
            setSelectedBrowsePlugin(null);
          }}
        />
      )}
      {flow === PluginFlow.PluginActions && selectedInstalledPlugin && (
        <PluginActionsFlow
          plugin={selectedInstalledPlugin}
          onComplete={() => {
            setTabsKey((k) => k + 1);
            setFlow(PluginFlow.Tabs);
            setSelectedInstalledPlugin(null);
          }}
          onCancel={() => {
            setFlow(PluginFlow.Tabs);
            setSelectedInstalledPlugin(null);
          }}
        />
      )}
      {flow === PluginFlow.FailedPluginActions && selectedFailedPlugin && (
        <FailedPluginActionsFlow
          failed={selectedFailedPlugin}
          onComplete={() => {
            setTabsKey((k) => k + 1);
            setFlow(PluginFlow.Tabs);
            setSelectedFailedPlugin(null);
          }}
          onCancel={() => {
            setFlow(PluginFlow.Tabs);
            setSelectedFailedPlugin(null);
          }}
        />
      )}
    </Box>
  );
}
