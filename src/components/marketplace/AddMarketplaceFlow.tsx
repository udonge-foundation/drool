import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { parseMarketplaceSource } from '@industry/runtime/plugins';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { MarketplaceErrorDisplay } from '@/components/marketplace/MarketplaceErrorDisplay';
import { PLUGIN_CONTENT_HEIGHT } from '@/components/plugin/constants';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { cleanPastedText } from '@/utils/pasteHandler';

interface AddMarketplaceFlowProps {
  onComplete: () => void;
  onCancel: () => void;
}

type FlowState = 'input' | 'adding' | 'success' | 'error';

export function AddMarketplaceFlow({
  onComplete,
  onCancel,
}: AddMarketplaceFlowProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [state, setState] = useState<FlowState>('input');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [addedName, setAddedName] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!url.trim()) return;

    setState('adding');
    setErrorMessage(null);

    try {
      const manager = PluginMarketplaceManager.getInstance();
      const source = parseMarketplaceSource(url.trim());
      const result = await manager.addMarketplace(source);

      if (result.success) {
        setAddedName(
          result.name ?? t('common:marketplace.marketplaceFallback')
        );
        setState('success');
      } else {
        setErrorMessage(
          result.error ?? t('common:marketplace.failedAddFallback')
        );
        setState('error');
      }
    } catch (err) {
      logException(err, 'Failed to add marketplace');
      setErrorMessage(
        err instanceof Error
          ? err.message
          : t('common:marketplace.unknownError')
      );
      setState('error');
    }
  };

  // Auto-return to tabs after showing success for 1 second (errors require manual dismissal)
  useEffect(() => {
    if (state === 'success') {
      const timer = setTimeout(onComplete, 1000);
      return () => clearTimeout(timer);
    }
  }, [state, onComplete]);

  // Also allow manual dismissal and handle input state
  useKeypressHandler(
    (input, key) => {
      if (state === 'input') {
        if (key.escape) {
          onCancel();
          return;
        }
        if (key.return && url.trim()) {
          void handleSubmit();
        }
      } else if (state === 'success' || state === 'error') {
        if (key.return || key.escape) {
          onComplete();
        }
      }
    },
    { isActive: state !== 'adding' }
  );

  if (state === 'adding') {
    return (
      <MenuContainer
        title={t('common:marketplace.addTitle')}
        showDefaultHelp={false}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Text color={COLORS.text.muted}>
          {t('common:marketplace.adding', { url })}
        </Text>
        <Text color={COLORS.text.muted}>
          {t('common:marketplace.addingCloneNote')}
        </Text>
      </MenuContainer>
    );
  }

  if (state === 'success') {
    return (
      <MenuContainer
        title={t('common:marketplace.addTitle')}
        helpText={t('common:marketplace.helpContinue')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Text color={COLORS.success}>
          {t('common:marketplace.successAdd', { name: addedName })}
        </Text>
      </MenuContainer>
    );
  }

  if (state === 'error') {
    return (
      <MenuContainer
        title={t('common:marketplace.addTitle')}
        helpText={t('common:marketplace.helpGoBack')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <MarketplaceErrorDisplay
          title={t('common:marketplace.failedAddTitle')}
          errors={[
            {
              source: url,
              error: errorMessage ?? t('common:unknownError'),
            },
          ]}
        />
      </MenuContainer>
    );
  }

  return (
    <MenuContainer
      title={t('common:marketplace.addTitle')}
      helpText={t('common:marketplace.addHelpText')}
      minContentHeight={PLUGIN_CONTENT_HEIGHT}
    >
      <Box>
        <Text color={COLORS.primary}>
          {t('common:marketplace.sourceLabel')}
        </Text>
        <TextInput
          value={url}
          onChange={(value) => setUrl(cleanPastedText(value))}
          placeholder={t('common:marketplace.sourcePlaceholder')}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {t('common:marketplace.sourceHint')}
        </Text>
      </Box>
    </MenuContainer>
  );
}
