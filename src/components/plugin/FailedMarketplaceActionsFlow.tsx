import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { type FailedMarketplaceInstall } from '@industry/runtime/plugins';
import {
  PluginMarketplaceManager,
  SettingsManager,
} from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { PLUGIN_CONTENT_HEIGHT } from '@/components/plugin/constants';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

import type { MarketplaceSource } from '@industry/common/settings';

interface FailedMarketplaceActionsFlowProps {
  failed: FailedMarketplaceInstall;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'menu' | 'retrying' | 'result';
type Action = 'retry' | 'dismiss' | 'back';

interface ActionOption {
  action: Action;
  label: string;
}

const ACTION_OPTIONS: ActionOption[] = [
  { action: 'retry', label: 'Retry installation' },
  { action: 'dismiss', label: 'Dismiss' },
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

export function FailedMarketplaceActionsFlow({
  failed,
  onComplete,
  onCancel,
}: FailedMarketplaceActionsFlowProps) {
  const { t } = useTranslation();

  const actionLabelMap: Record<Action, string> = {
    retry: t('common:plugins.retryInstallation'),
    dismiss: t('common:plugins.dismiss'),
    back: t('common:drools.back'),
  };

  const [step, setStep] = useState<Step>('menu');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleRetry = async () => {
    setStep('retrying');
    setError(null);

    try {
      const manager = PluginMarketplaceManager.getInstance();
      const result = await manager.addMarketplace(failed.source);

      if (result.success) {
        setSuccess(true);
        // Clear from failed list on success
        manager.clearFailedMarketplaceInstall(failed.name);
        SettingsManager.getInstance().refresh();
        await manager.autoInstallMissingPlugins();
      } else {
        setError(result.error ?? t('common:marketplace.couldNotInstall'));
      }
    } catch (err) {
      logException(err, 'Failed to retry marketplace installation');
      setError(t('common:marketplace.couldNotInstallRetry'));
    } finally {
      setStep('result');
    }
  };

  const handleDismiss = () => {
    const manager = PluginMarketplaceManager.getInstance();
    manager.dismissFailedMarketplaceInstall(failed.name);
    onComplete();
  };

  const { selectedIndex } = useMenuNavigation({
    items: ACTION_OPTIONS,
    initialIndex: 0,
    onSelect: (selected) => {
      switch (selected.action) {
        case 'retry':
          void handleRetry();
          break;
        case 'dismiss':
          handleDismiss();
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
        title={t('common:plugins.failedMarketplaceTitle', {
          name: failed.name,
        })}
        helpText={t('common:plugins.helpNavigateSelect')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text>
              <Text color={COLORS.text.muted}>
                {t('common:plugins.marketplaceSourceLabel')}
              </Text>
              {formatSource(failed.source)}
            </Text>
            <Text>
              <Text color={COLORS.text.muted}>
                {t('common:plugins.marketplaceScopeLabel')}
              </Text>
              {failed.scope}
            </Text>
            <Text>
              <Text color={COLORS.text.muted}>
                {t('common:plugins.marketplaceErrorLabel')}
              </Text>
              <Text color={COLORS.error}>{failed.error}</Text>
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

  if (step === 'retrying') {
    return (
      <MenuContainer
        title={failed.name}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Text color={COLORS.text.muted}>
          {t('common:plugins.retryingMarketplace', { name: failed.name })}
        </Text>
      </MenuContainer>
    );
  }

  return (
    <MenuContainer
      title={failed.name}
      helpText={t('common:plugins.helpContinue')}
      minContentHeight={PLUGIN_CONTENT_HEIGHT}
    >
      {success ? (
        <Text color={COLORS.success}>
          {t('common:plugins.successMarketplace', { name: failed.name })}
        </Text>
      ) : (
        <Text color={COLORS.error}>
          {t('common:plugins.failedAction', { error })}
        </Text>
      )}
    </MenuContainer>
  );
}
