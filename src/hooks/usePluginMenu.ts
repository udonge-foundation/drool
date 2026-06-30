import { useCallback, useState } from 'react';

import { PluginFlow, PluginTab } from '@/hooks/enums';
import type {
  BrowsePluginInfo,
  FailedPluginInfo,
  InstalledPluginInfo,
  MarketplaceInfo,
  UsePluginMenu,
} from '@/hooks/types';

export function usePluginMenu(): UsePluginMenu {
  const [show, setShow] = useState(false);
  const [activeTab, setActiveTabState] = useState<PluginTab>(PluginTab.Browse);
  const [flow, setFlowState] = useState<PluginFlow>(PluginFlow.Tabs);
  const [selectedMarketplace, setSelectedMarketplace] =
    useState<MarketplaceInfo | null>(null);
  const [selectedBrowsePlugin, setSelectedBrowsePlugin] =
    useState<BrowsePluginInfo | null>(null);
  const [selectedInstalledPlugin, setSelectedInstalledPlugin] =
    useState<InstalledPluginInfo | null>(null);
  const [selectedFailedPlugin, setSelectedFailedPlugin] =
    useState<FailedPluginInfo | null>(null);

  const open = useCallback((initialTab?: PluginTab) => {
    setShow(true);
    setActiveTabState(initialTab ?? PluginTab.Browse);
    setFlowState(PluginFlow.Tabs);
  }, []);

  const close = useCallback(() => {
    setShow(false);
    setFlowState(PluginFlow.Tabs);
    setSelectedMarketplace(null);
    setSelectedBrowsePlugin(null);
    setSelectedInstalledPlugin(null);
    setSelectedFailedPlugin(null);
  }, []);

  const setActiveTab = useCallback((tab: PluginTab) => {
    setActiveTabState(tab);
  }, []);

  const setFlow = useCallback((next: PluginFlow) => {
    setFlowState(next);
  }, []);

  return {
    show,
    open,
    close,
    activeTab,
    setActiveTab,
    flow,
    setFlow,
    selectedMarketplace,
    setSelectedMarketplace,
    selectedBrowsePlugin,
    setSelectedBrowsePlugin,
    selectedInstalledPlugin,
    setSelectedInstalledPlugin,
    selectedFailedPlugin,
    setSelectedFailedPlugin,
  };
}
