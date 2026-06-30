import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsLevel } from '@industry/drool-sdk-ext/protocol/settings';
import { logException } from '@industry/logging';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { PluginDroolModelFixFlow } from '@/components/drools/PluginDroolModelFixFlow';
import { PLUGIN_CONTENT_HEIGHT } from '@/components/plugin/constants';
import type { BrowsePluginInfo } from '@/hooks/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

interface InstallPluginFlowProps {
  plugin: BrowsePluginInfo;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'scope' | 'installing' | 'fix-models' | 'result';

interface ScopeOption {
  scope: SettingsLevel;
  label: string;
}

const SCOPE_OPTIONS: ScopeOption[] = [
  { scope: SettingsLevel.User, label: 'User (~/.industry)' },
  { scope: SettingsLevel.Project, label: 'Project (.industry)' },
];

export function InstallPluginFlow({
  plugin,
  onComplete,
  onCancel,
}: InstallPluginFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('scope');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleInstall = async (scope: SettingsLevel) => {
    setStep('installing');
    setError(null);

    try {
      const manager = PluginMarketplaceManager.getInstance();
      const result = await manager.installPlugin(
        plugin.marketplace,
        plugin.name,
        scope
      );

      if (result.success) {
        setSuccess(true);
        // Resolve any plugin drools tied to a model the org blocks before
        // returning to the plugin tabs.
        setStep('fix-models');
        return;
      }
      setError(result.error ?? t('common:plugins.unknownError'));
      setStep('result');
    } catch (err) {
      logException(err, 'Failed to install plugin');
      setError(t('common:plugins.couldNotInstall'));
      setStep('result');
    }
  };

  const pluginId = `${plugin.name}@${plugin.marketplace}`;

  const { selectedIndex } = useMenuNavigation({
    items: SCOPE_OPTIONS,
    initialIndex: 0,
    onSelect: (selected) => {
      void handleInstall(selected.scope);
    },
    onCancel,
    isActive: step === 'scope',
  });

  // Auto-return to tabs after showing result for 1 second
  useEffect(() => {
    if (step === 'result') {
      const timer = setTimeout(onComplete, 1000);
      return () => clearTimeout(timer);
    }
  }, [step, onComplete]);

  // Also allow manual dismissal with Enter/Escape/q
  useKeypressHandler(
    (input, key) => {
      if (key.return || key.escape || input.toLowerCase() === 'q') {
        onComplete();
      }
    },
    { isActive: step === 'result' }
  );

  if (step === 'scope') {
    return (
      <MenuContainer
        title={t('common:plugins.installTitle', { name: plugin.name })}
        helpText={t('common:plugins.helpNavigate')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            {t('common:plugins.installFrom', {
              name: plugin.name,
              marketplace: plugin.marketplace,
            })}
          </Text>
          <Box marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('common:plugins.selectScope')}
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {SCOPE_OPTIONS.map((option, index) => {
              const isSelected = index === selectedIndex;
              const scopeLabel =
                option.scope === SettingsLevel.User
                  ? t('common:plugins.scopeUser')
                  : t('common:plugins.scopeProject');
              return (
                <Box key={option.scope}>
                  <Box width={2}>
                    <Text> </Text>
                  </Box>
                  <Text
                    bold={isSelected}
                    color={isSelected ? COLORS.text.primary : COLORS.text.muted}
                  >
                    {scopeLabel}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      </MenuContainer>
    );
  }

  if (step === 'installing') {
    return (
      <MenuContainer
        title={t('common:plugins.installTitle', { name: plugin.name })}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Text color={COLORS.text.muted}>
          {t('common:plugins.installing', {
            name: plugin.name,
            marketplace: plugin.marketplace,
          })}
        </Text>
      </MenuContainer>
    );
  }

  if (step === 'fix-models') {
    return (
      <PluginDroolModelFixFlow
        pluginId={pluginId}
        onComplete={() => setStep('result')}
      />
    );
  }

  return (
    <MenuContainer
      title={t('common:plugins.installTitle', { name: plugin.name })}
      helpText={t('common:plugins.helpContinue')}
      minContentHeight={PLUGIN_CONTENT_HEIGHT}
    >
      {success ? (
        <Text color={COLORS.success}>
          {t('common:plugins.successInstall', {
            name: plugin.name,
            marketplace: plugin.marketplace,
          })}
        </Text>
      ) : (
        <Text color={COLORS.error}>
          {t('common:plugins.failedInstall', { error })}
        </Text>
      )}
    </MenuContainer>
  );
}
