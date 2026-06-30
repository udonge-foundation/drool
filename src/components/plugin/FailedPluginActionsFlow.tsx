import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { PLUGIN_CONTENT_HEIGHT } from '@/components/plugin/constants';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

import type { FailedPluginInstall } from '@industry/runtime/plugins';

interface FailedPluginActionsFlowProps {
  failed: FailedPluginInstall;
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

export function FailedPluginActionsFlow({
  failed,
  onComplete,
  onCancel,
}: FailedPluginActionsFlowProps) {
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
      const result = await manager.retryFailedPluginInstall(failed.pluginId);

      if (result.success) {
        setSuccess(true);
      } else {
        setError(result.error ?? t('common:plugins.couldNotInstall'));
      }
    } catch (err) {
      logException(err, 'Failed to retry plugin installation');
      setError(t('common:plugins.couldNotInstallRetry'));
    } finally {
      setStep('result');
    }
  };

  const handleDismiss = () => {
    const manager = PluginMarketplaceManager.getInstance();
    manager.dismissFailedPluginInstall(failed.pluginId);
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
        title={t('common:plugins.failedTitle', { id: failed.pluginId })}
        helpText={t('common:plugins.helpNavigateSelect')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={COLORS.text.muted}>
              {t('common:plugins.errorPrefix', { error: failed.error })}
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
        title={failed.pluginId}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Text color={COLORS.text.muted}>
          {t('common:plugins.retrying', { id: failed.pluginId })}
        </Text>
      </MenuContainer>
    );
  }

  return (
    <MenuContainer
      title={failed.pluginId}
      helpText={t('common:plugins.helpContinue')}
      minContentHeight={PLUGIN_CONTENT_HEIGHT}
    >
      {success ? (
        <Text color={COLORS.success}>
          {t('common:plugins.successInstalled', { id: failed.pluginId })}
        </Text>
      ) : (
        <Text color={COLORS.error}>
          {t('common:plugins.failedAction', { error })}
        </Text>
      )}
    </MenuContainer>
  );
}
