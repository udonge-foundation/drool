import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { FailedMarketplaceActionsFlow } from '@/components/plugin/FailedMarketplaceActionsFlow';
import { MissingMarketplaceActionsFlow } from '@/components/plugin/MissingMarketplaceActionsFlow';
import { Spinner } from '@/components/Spinner';
import type { MarketplaceInfo, MissingMarketplaceInfo } from '@/hooks/types';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import {
  displayWidth as getDisplayWidth,
  padEndByDisplayWidth,
} from '@/utils/displayWidth';

import type {
  MarketplaceEntry,
  MarketplaceListItem,
  UnregisteredMarketplace,
} from '@industry/common/settings';
import type { FailedMarketplaceInstall } from '@industry/runtime/plugins';

interface MarketplacesTabProps {
  onAddMarketplace: () => void;
  onDeleteMarketplace: (marketplace: MarketplaceInfo) => void;
}

type MenuOption =
  | ({ type: 'marketplace' } & MarketplaceListItem)
  | ({ type: 'missing' } & UnregisteredMarketplace)
  | ({ type: 'failed' } & FailedMarketplaceInstall)
  | { type: 'action'; action: 'add' }
  | { type: 'header'; label: string };

type MarketplaceAction = 'update' | 'toggle-auto-update' | 'delete' | 'back';

interface MarketplaceActionOption {
  action: MarketplaceAction;
  label: string;
}

type ActionState = 'idle' | 'updating' | 'success' | 'error';

const VISIBLE_COUNT = 10;
const SCROLL_ANCHOR = 5;

export function MarketplacesTab({
  onAddMarketplace,
  onDeleteMarketplace,
}: MarketplacesTabProps) {
  const { t } = useTranslation();
  const [marketplaces, setMarketplaces] = useState<MarketplaceListItem[]>([]);
  const [missingMarketplaces, setMissingMarketplaces] = useState<
    UnregisteredMarketplace[]
  >([]);
  const [failedMarketplaces, setFailedMarketplaces] = useState<
    FailedMarketplaceInstall[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMarketplace, setSelectedMarketplace] =
    useState<MarketplaceInfo | null>(null);
  const [selectedMissingMarketplace, setSelectedMissingMarketplace] =
    useState<MissingMarketplaceInfo | null>(null);
  const [selectedFailedMarketplace, setSelectedFailedMarketplace] =
    useState<FailedMarketplaceInstall | null>(null);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [windowStart, setWindowStart] = useState(0);

  const loadMarketplaces = async () => {
    try {
      setLoading(true);
      setError(null);
      const manager = PluginMarketplaceManager.getInstance();
      const [list, missing] = await Promise.all([
        manager.listMarketplaces(),
        manager.getMissingExtraMarketplaces(),
      ]);
      const failed = manager.getFailedMarketplaceInstalls();

      // Filter out failed marketplaces from missing list (they'll show in failed section)
      const failedNames = new Set(failed.map((f) => f.name));
      const filteredMissing = missing.filter((m) => !failedNames.has(m.name));

      setMarketplaces(list);
      setMissingMarketplaces(filteredMissing);
      setFailedMarketplaces(failed);
    } catch (err) {
      logException(err, 'Failed to load marketplaces');
      setError(t('common:marketplace.failedToLoadMarketplaces'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMarketplaces();
  }, []);

  const menuOptions = useMemo(() => {
    const options: MenuOption[] = [];

    options.push({ type: 'action', action: 'add' });

    if (marketplaces.length > 0) {
      options.push({
        type: 'header',
        label: t('common:marketplace.registeredHeader'),
      });
      marketplaces.forEach(({ name, entry, pluginCount }) => {
        options.push({ type: 'marketplace', name, entry, pluginCount });
      });
    }

    if (missingMarketplaces.length > 0) {
      options.push({
        type: 'header',
        label: t('common:marketplace.fromSettingsHeader'),
      });
      missingMarketplaces.forEach(({ name, source, scope }) => {
        options.push({ type: 'missing', name, source, scope });
      });
    }

    if (failedMarketplaces.length > 0) {
      options.push({
        type: 'header',
        label: t('common:marketplace.failedToInstallHeader'),
      });
      failedMarketplaces.forEach((failed) => {
        options.push({ type: 'failed', ...failed });
      });
    }

    return options;
  }, [marketplaces, missingMarketplaces, failedMarketplaces]);

  const { selectedIndex: mainSelectedIndex } = useMenuNavigation({
    items: menuOptions,
    initialIndex: 0,
    isSelectable: (option) => option.type !== 'header',
    onSelect: (selected) => {
      if (selected.type === 'marketplace') {
        setSelectedMarketplace({
          name: selected.name,
          entry: selected.entry,
          pluginCount: selected.pluginCount,
        });
      } else if (selected.type === 'action' && selected.action === 'add') {
        onAddMarketplace();
      } else if (selected.type === 'missing') {
        setSelectedMissingMarketplace({
          name: selected.name,
          source: selected.source,
          scope: selected.scope,
        });
      } else if (selected.type === 'failed') {
        setSelectedFailedMarketplace(selected);
      }
    },
    onCancel: () => {
      // ESC is handled by parent PluginTabs component
    },
    isActive:
      !selectedMarketplace &&
      !selectedMissingMarketplace &&
      !selectedFailedMarketplace,
    onIndexChange: (newIndex) => {
      const idealStart = newIndex - SCROLL_ANCHOR;
      const maxStart = Math.max(0, menuOptions.length - VISIBLE_COUNT);
      setWindowStart(Math.max(0, Math.min(idealStart, maxStart)));
    },
  });

  useEffect(() => {
    const maxStart = Math.max(0, menuOptions.length - VISIBLE_COUNT);
    setWindowStart((prev) => Math.min(prev, maxStart));
  }, [menuOptions.length]);

  const marketplaceActionOptions: MarketplaceActionOption[] = useMemo(() => {
    const autoUpdateEnabled = selectedMarketplace?.entry.autoUpdate ?? true;
    return [
      { action: 'update', label: t('common:marketplace.updateMarketplace') },
      {
        action: 'toggle-auto-update',
        label: autoUpdateEnabled
          ? t('common:marketplace.disableAutoUpdate')
          : t('common:marketplace.enableAutoUpdate'),
      },
      { action: 'delete', label: t('common:marketplace.deleteMarketplace') },
      { action: 'back', label: t('common:marketplace.back') },
    ];
  }, [selectedMarketplace, t]);

  const { width: terminalWidth } = useTerminalDimensions();

  const maxMarketplaceNameWidth = useMemo(() => {
    let max = 0;
    for (const opt of menuOptions) {
      if (
        opt.type === 'marketplace' ||
        opt.type === 'missing' ||
        opt.type === 'failed'
      ) {
        const w = getDisplayWidth(opt.name);
        if (w > max) max = w;
      }
      if (opt.type === 'action') {
        const w = getDisplayWidth(t('common:marketplace.addNewMarketplace'));
        if (w > max) max = w;
      }
    }
    return max;
  }, [menuOptions, t]);

  const handleMarketplaceAction = async (action: MarketplaceAction) => {
    if (!selectedMarketplace) return;

    const manager = PluginMarketplaceManager.getInstance();

    switch (action) {
      case 'update':
        setActionState('updating');
        setActionMessage(t('common:marketplace.updatingMarketplace'));
        try {
          const results = await manager.updateMarketplace(
            selectedMarketplace.name
          );
          const result = results[0];
          if (result?.success) {
            setActionState('success');
            setActionMessage(t('common:marketplace.updateSuccess'));
            await loadMarketplaces();
          } else {
            setActionState('error');
            setActionMessage(
              result?.error ?? t('common:marketplace.updateFailed')
            );
          }
        } catch (err) {
          logException(err, 'Failed to update marketplace in settings');
          setActionState('error');
          setActionMessage(t('common:marketplace.updateFailed'));
        }
        // Reset state after a delay
        setTimeout(() => {
          setActionState('idle');
          setActionMessage(null);
        }, 2000);
        break;

      case 'toggle-auto-update': {
        const newValue = !(selectedMarketplace.entry.autoUpdate ?? true);
        try {
          await manager.setMarketplaceAutoUpdate(
            selectedMarketplace.name,
            newValue
          );
          // Update local state to reflect the change
          setSelectedMarketplace({
            ...selectedMarketplace,
            entry: { ...selectedMarketplace.entry, autoUpdate: newValue },
          });
          await loadMarketplaces();
        } catch (err) {
          logException(err, 'Failed to toggle auto-update');
        }
        break;
      }

      case 'delete':
        onDeleteMarketplace(selectedMarketplace);
        break;

      case 'back':
        setSelectedMarketplace(null);
        setActionState('idle');
        setActionMessage(null);
        break;

      default:
        break;
    }
  };

  const { selectedIndex: actionSelectedIndex } = useMenuNavigation({
    items: marketplaceActionOptions,
    initialIndex: 0,
    onSelect: (option) => {
      void handleMarketplaceAction(option.action);
    },
    onCancel: () => {
      setSelectedMarketplace(null);
      setActionState('idle');
      setActionMessage(null);
    },
    isActive: !!selectedMarketplace && actionState === 'idle',
  });

  const getSourceDisplay = (entry: MarketplaceEntry): string => {
    if (entry.source.source === 'github') {
      return `github:${entry.source.repo}`;
    }
    if (entry.source.source === 'local') {
      return `local:${entry.source.path}`;
    }
    return entry.source.url ?? 'unknown';
  };

  if (loading) {
    return (
      <Text color={COLORS.text.muted}>
        {t('common:marketplace.loadingMarketplaces')}
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

  // Show missing marketplace actions flow
  if (selectedMissingMarketplace) {
    return (
      <MissingMarketplaceActionsFlow
        missing={selectedMissingMarketplace}
        onComplete={() => {
          // Reload to pick up any changes (success or failure persisted to PluginMarketplaceManager)
          void loadMarketplaces();
          setSelectedMissingMarketplace(null);
        }}
        onCancel={() => setSelectedMissingMarketplace(null)}
      />
    );
  }

  // Show failed marketplace actions flow
  if (selectedFailedMarketplace) {
    return (
      <FailedMarketplaceActionsFlow
        failed={selectedFailedMarketplace}
        onComplete={() => {
          // Reload to pick up any changes (retry success or dismiss persisted to PluginMarketplaceManager)
          void loadMarketplaces();
          setSelectedFailedMarketplace(null);
        }}
        onCancel={() => setSelectedFailedMarketplace(null)}
      />
    );
  }

  const getOptionSourceDisplay = (
    option: MenuOption & { type: 'missing' | 'failed' }
  ): string => {
    if (option.source.source === 'github') {
      return `github:${option.source.repo}`;
    }
    if (option.source.source === 'local') {
      return `local:${option.source.path}`;
    }
    return option.source.url ?? 'unknown';
  };

  if (!selectedMarketplace) {
    const end = Math.min(windowStart + VISIBLE_COUNT, menuOptions.length);
    const visibleOptions = menuOptions.slice(windowStart, end);

    return (
      <>
        {marketplaces.length === 0 &&
          missingMarketplaces.length === 0 &&
          failedMarketplaces.length === 0 && (
            <Text color={COLORS.text.muted}>
              {t('common:marketplace.noMarketplacesRegistered')}
            </Text>
          )}
        {visibleOptions.map((option, index) => {
          const globalIndex = windowStart + index;
          const isSelected = globalIndex === mainSelectedIndex;

          if (option.type === 'header') {
            return (
              <Box key={`header-${index}`} marginTop={1}>
                <Text color={COLORS.text.muted}>{option.label}</Text>
              </Box>
            );
          }

          if (option.type === 'action') {
            return (
              <Box key="action-add">
                <Box width={2}>
                  <Text> </Text>
                </Box>
                <Text
                  bold={isSelected}
                  color={isSelected ? COLORS.text.primary : COLORS.text.muted}
                >
                  {t('common:marketplace.addNewMarketplace')}
                </Text>
              </Box>
            );
          }

          if (option.type === 'missing') {
            const sourceDisplay = getOptionSourceDisplay(option);
            const labelColor: string | undefined = isSelected
              ? COLORS.text.primary
              : COLORS.text.muted;
            return (
              <Box key={`missing-${option.name}`}>
                <Box width={2}>
                  <Text> </Text>
                </Box>
                <Box width={maxMarketplaceNameWidth}>
                  <Text
                    bold={isSelected}
                    color={labelColor}
                    wrap="truncate-end"
                  >
                    {padEndByDisplayWidth(option.name, maxMarketplaceNameWidth)}
                  </Text>
                </Box>
                <Box
                  width={Math.max(
                    0,
                    terminalWidth - 2 - maxMarketplaceNameWidth - 4
                  )}
                >
                  <Text color={COLORS.text.muted} wrap="truncate-end">
                    {'      '}({option.scope}) - {sourceDisplay}
                  </Text>
                </Box>
              </Box>
            );
          }

          if (option.type === 'failed') {
            const sourceDisplay = getOptionSourceDisplay(option);
            const labelColor: string | undefined = isSelected
              ? COLORS.text.primary
              : COLORS.warning;
            return (
              <Box key={`failed-${option.name}`}>
                <Box width={2}>
                  <Text> </Text>
                </Box>
                <Box width={maxMarketplaceNameWidth}>
                  <Text
                    bold={isSelected}
                    color={labelColor}
                    wrap="truncate-end"
                  >
                    {padEndByDisplayWidth(option.name, maxMarketplaceNameWidth)}
                  </Text>
                </Box>
                <Box
                  width={Math.max(
                    0,
                    terminalWidth - 2 - maxMarketplaceNameWidth - 4
                  )}
                >
                  <Text color={COLORS.text.muted} wrap="truncate-end">
                    {'      '}({option.scope}) - {sourceDisplay}
                  </Text>
                </Box>
              </Box>
            );
          }

          // option.type === 'marketplace'
          const labelColor: string | undefined = isSelected
            ? COLORS.text.primary
            : COLORS.text.muted;
          const meta = t('common:marketplace.pluginCountMeta', {
            count: option.pluginCount,
            source: getSourceDisplay(option.entry),
          });
          return (
            <Box key={`marketplace-${option.name}`}>
              <Box width={2}>
                <Text> </Text>
              </Box>
              <Box width={maxMarketplaceNameWidth}>
                <Text bold={isSelected} color={labelColor} wrap="truncate-end">
                  {padEndByDisplayWidth(option.name, maxMarketplaceNameWidth)}
                </Text>
              </Box>
              <Box
                width={Math.max(
                  0,
                  terminalWidth - 2 - maxMarketplaceNameWidth - 4
                )}
              >
                <Text color={COLORS.text.muted} wrap="truncate-end">
                  {'      '}
                  {meta}
                </Text>
              </Box>
            </Box>
          );
        })}
      </>
    );
  }

  // Show loading/status state for marketplace actions
  if (actionState !== 'idle' && selectedMarketplace) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={COLORS.text.muted}>
            {t('common:marketplace.selectedLabel')}
          </Text>
          {selectedMarketplace.name}
        </Text>
        <Box marginTop={1}>
          {actionState === 'updating' && (
            <Text color={COLORS.primary}>
              <Spinner /> {actionMessage}
            </Text>
          )}
          {actionState === 'success' && (
            <Text color={COLORS.success}>{actionMessage}</Text>
          )}
          {actionState === 'error' && (
            <Text color={COLORS.error}>{actionMessage}</Text>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={COLORS.text.muted}>
          {t('common:marketplace.selectedLabel')}
        </Text>
        {selectedMarketplace.name}
        {selectedMarketplace.entry.autoUpdate && (
          <Text color={COLORS.text.muted}>
            {t('common:marketplace.autoUpdateLabel')}
          </Text>
        )}
      </Text>
      <Box marginTop={1} />
      {marketplaceActionOptions.map((option, idx) => {
        const isSelected = idx === actionSelectedIndex;
        return (
          <Box key={option.label}>
            <Box width={2}>
              <Text> </Text>
            </Box>
            <Text
              bold={isSelected}
              color={isSelected ? COLORS.text.primary : COLORS.text.muted}
            >
              {option.label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
