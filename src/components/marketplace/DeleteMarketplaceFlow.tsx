import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { PLUGIN_CONTENT_HEIGHT } from '@/components/plugin/constants';
import type { MarketplaceInfo } from '@/hooks/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

interface DeleteMarketplaceFlowProps {
  marketplace: MarketplaceInfo;
  onComplete: () => void;
  onCancel: () => void;
}

type FlowState = 'confirm' | 'deleting' | 'success' | 'error';

interface ConfirmOption {
  action: 'confirm' | 'cancel';
  label: string;
}

export function DeleteMarketplaceFlow({
  marketplace,
  onComplete,
  onCancel,
}: DeleteMarketplaceFlowProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<FlowState>('confirm');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const confirmOptions: ConfirmOption[] = [
    { action: 'confirm', label: t('common:marketplace.yesDelete') },
    { action: 'cancel', label: t('common:marketplace.noGoBack') },
  ];

  const handleDelete = async () => {
    setState('deleting');
    setErrorMessage(null);

    try {
      const manager = PluginMarketplaceManager.getInstance();
      const result = await manager.removeMarketplace(marketplace.name);

      if (result.success) {
        setState('success');
      } else {
        setErrorMessage(
          result.error ?? t('common:marketplace.failedRemoveFallback')
        );
        setState('error');
      }
    } catch (err) {
      logException(err, 'Failed to remove marketplace');
      setErrorMessage(
        err instanceof Error
          ? err.message
          : t('common:marketplace.unknownError')
      );
      setState('error');
    }
  };

  const { selectedIndex } = useMenuNavigation({
    items: confirmOptions,
    initialIndex: 1, // Default to "No, go back"
    onSelect: (option) => {
      if (option.action === 'confirm') {
        void handleDelete();
      } else {
        onCancel();
      }
    },
    onCancel,
    isActive: state === 'confirm',
  });

  useKeypressHandler(
    (_input, key) => {
      if (state === 'success' || state === 'error') {
        if (key.return || key.escape) {
          onComplete();
        }
      }
    },
    { isActive: state === 'success' || state === 'error' }
  );

  if (state === 'deleting') {
    return (
      <MenuContainer
        title={t('common:marketplace.deleteTitle')}
        showDefaultHelp={false}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Text color={COLORS.text.muted}>
          {t('common:marketplace.deleting', { name: marketplace.name })}
        </Text>
      </MenuContainer>
    );
  }

  if (state === 'success') {
    return (
      <MenuContainer
        title={t('common:marketplace.deleteTitle')}
        helpText={t('common:marketplace.helpContinue')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Text color={COLORS.success}>
          {t('common:marketplace.successDelete', { name: marketplace.name })}
        </Text>
      </MenuContainer>
    );
  }

  if (state === 'error') {
    return (
      <MenuContainer
        title={t('common:marketplace.deleteTitle')}
        helpText={t('common:marketplace.failedDeleteHelpBack')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Text color={COLORS.error}>{t('common:marketplace.failedDelete')}</Text>
        <Text color={COLORS.text.muted}>{errorMessage}</Text>
      </MenuContainer>
    );
  }

  return (
    <MenuContainer
      title={t('common:marketplace.deleteTitle')}
      minContentHeight={PLUGIN_CONTENT_HEIGHT}
    >
      <Box flexDirection="column">
        <Text>
          {t('common:marketplace.deleteConfirm', { name: marketplace.name })}
        </Text>
        <Text color={COLORS.text.muted}>
          {t('common:marketplace.deleteNote')}
        </Text>
        <Box marginTop={1} />
        {confirmOptions.map((option, idx) => {
          const isSelected = idx === selectedIndex;
          return (
            <Box key={option.action}>
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
    </MenuContainer>
  );
}
