import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import {
  PluginMarketplaceManager,
  SettingsManager,
} from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import type { MissingMarketplaceInfo } from '@/hooks/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

import type { MarketplaceSource } from '@industry/common/settings';

interface MissingMarketplaceActionsFlowProps {
  missing: MissingMarketplaceInfo;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'menu' | 'installing' | 'result';
type Action = 'install' | 'back';

interface ActionOption {
  action: Action;
  label: string;
}

const ACTION_OPTIONS: ActionOption[] = [
  { action: 'install', label: 'Install' },
  { action: 'back', label: 'Back' },
];

function formatSource(source: MarketplaceSource): string {
  if (source.source === 'github') {
    return `github:${source.repo}`;
  }
  if (source.source === 'local') {
    return `local:${source.path}`;
  }
  return source.url ?? 'unknown';
}

export function MissingMarketplaceActionsFlow({
  missing,
  onComplete,
  onCancel,
}: MissingMarketplaceActionsFlowProps) {
  const { t } = useTranslation();

  const actionLabelMap: Record<Action, string> = {
    install: t('common:plugins.missingInstall'),
    back: t('common:drools.back'),
  };

  const [step, setStep] = useState<Step>('menu');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleInstall = async () => {
    setStep('installing');
    setError(null);

    try {
      const manager = PluginMarketplaceManager.getInstance();
      const result = await manager.addMarketplace(missing.source);

      if (result.success) {
        setSuccess(true);
        // Clear any previous failure for this marketplace
        manager.clearFailedMarketplaceInstall(missing.name);
        SettingsManager.getInstance().refresh();
        await manager.autoInstallMissingPlugins();
      } else {
        const errorMsg =
          result.error ?? t('common:marketplace.couldNotInstall');
        setError(errorMsg);
        // Persist failure to PluginMarketplaceManager
        manager.addFailedMarketplaceInstall({
          name: missing.name,
          source: missing.source,
          scope: missing.scope,
          error: errorMsg,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      logException(err, 'Failed to install marketplace');
      const errorMsg = t('common:marketplace.couldNotInstallRetry');
      setError(errorMsg);
      // Persist failure to PluginMarketplaceManager
      const manager = PluginMarketplaceManager.getInstance();
      manager.addFailedMarketplaceInstall({
        name: missing.name,
        source: missing.source,
        scope: missing.scope,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setStep('result');
    }
  };

  const { selectedIndex } = useMenuNavigation({
    items: ACTION_OPTIONS,
    initialIndex: 0,
    onSelect: (selected) => {
      switch (selected.action) {
        case 'install':
          void handleInstall();
          break;
        case 'back':
          onCancel();
          break;
        default:
          break;
      }
    },
    onCancel,
    isActive: step === 'menu',
  });

  useKeypressHandler(
    (input, key) => {
      if (key.return || key.escape || input.toLowerCase() === 'q') {
        onComplete();
      }
    },
    { isActive: step === 'result' }
  );

  if (step === 'menu') {
    return (
      <MenuContainer
        title={missing.name}
        helpText={t('common:plugins.helpNavigateSelect')}
      >
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text>
              <Text color={COLORS.text.muted}>
                {t('common:plugins.marketplaceSourceLabel')}
              </Text>
              {formatSource(missing.source)}
            </Text>
            <Text>
              <Text color={COLORS.text.muted}>
                {t('common:plugins.marketplaceScopeLabel')}
              </Text>
              {missing.scope}
            </Text>
          </Box>
          {ACTION_OPTIONS.map((option, index) => {
            const isSelected = index === selectedIndex;
            return (
              <Box key={option.action}>
                <Box width={2}>
                  <Text> </Text>
                </Box>
                <Text
                  bold={isSelected}
                  color={isSelected ? COLORS.text.primary : COLORS.text.muted}
                >
                  {actionLabelMap[option.action] || option.label}
                </Text>
              </Box>
            );
          })}
        </Box>
      </MenuContainer>
    );
  }

  if (step === 'installing') {
    return (
      <MenuContainer title={missing.name}>
        <Text color={COLORS.text.muted}>
          {t('common:plugins.installingMarketplace', { name: missing.name })}
        </Text>
      </MenuContainer>
    );
  }

  return (
    <MenuContainer
      title={missing.name}
      helpText={t('common:plugins.helpContinue')}
    >
      {success ? (
        <Text color={COLORS.success}>
          {t('common:plugins.successInstalledMarketplace', {
            name: missing.name,
          })}
        </Text>
      ) : (
        <Text color={COLORS.error}>
          {t('common:plugins.failedAction', { error })}
        </Text>
      )}
    </MenuContainer>
  );
}
