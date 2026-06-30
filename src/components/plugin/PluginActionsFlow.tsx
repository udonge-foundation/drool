import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { PluginMarketplaceManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { PluginDroolModelFixFlow } from '@/components/drools/PluginDroolModelFixFlow';
import { PLUGIN_CONTENT_HEIGHT } from '@/components/plugin/constants';
import type { InstalledPluginInfo } from '@/hooks/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { getI18n } from '@/i18n';

import type { PluginLoadWarning } from '@industry/runtime/plugins';

interface PluginActionsFlowProps {
  plugin: InstalledPluginInfo;
  onComplete: () => void;
  onCancel: () => void;
}

type Step =
  | 'menu'
  | 'info'
  | 'confirm-uninstall'
  | 'processing'
  | 'fix-drools'
  | 'result';
type Action = 'info' | 'update' | 'uninstall' | 'back';

interface ActionOption {
  action: Action;
  label: string;
}

const ACTION_OPTIONS: ActionOption[] = [
  { action: 'info', label: 'Info' },
  { action: 'update', label: 'Update' },
  { action: 'uninstall', label: 'Uninstall' },
  { action: 'back', label: 'Back' },
];

const CONFIRM_OPTIONS = [
  { confirm: true, label: 'Yes, uninstall' },
  { confirm: false, label: 'No, cancel' },
];

function formatDate(isoString: string): string {
  try {
    const locale = getI18n().language;
    return new Date(isoString).toLocaleDateString(locale);
  } catch {
    return isoString;
  }
}

function formatVersion(version: string): string {
  return version.substring(0, 7);
}

export function PluginActionsFlow({
  plugin,
  onComplete,
  onCancel,
}: PluginActionsFlowProps) {
  const { t } = useTranslation();

  const actionLabelMap: Record<Action, string> = {
    info: t('common:plugins.info'),
    update: t('common:plugins.update'),
    uninstall: t('common:plugins.uninstall'),
    back: t('common:drools.back'),
  };

  const confirmLabelMap: Record<string, string> = {
    'Yes, uninstall': t('common:plugins.yesUninstall'),
    'No, cancel': t('common:plugins.noCancel'),
  };

  const [step, setStep] = useState<Step>('menu');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [actionLabel, setActionLabel] = useState<string>('');
  const [warnings, setWarnings] = useState<PluginLoadWarning[]>([]);

  useEffect(() => {
    const manager = PluginMarketplaceManager.getInstance();
    const warningsByPlugin = manager.getPluginLoadWarningsByPlugin();
    setWarnings(warningsByPlugin.get(plugin.id) ?? []);
  }, [plugin.id]);

  const handleUpdate = async () => {
    setStep('processing');
    setActionLabel(t('common:plugins.actionUpdating'));
    setError(null);

    try {
      const manager = PluginMarketplaceManager.getInstance();
      const results = await manager.updatePlugin(plugin.id);
      const result = results[0];

      if (result?.success) {
        setSuccess(true);
        setActionLabel(t('common:plugins.actionUpdated'));
        // Resolve any plugin drools tied to a model the org blocks.
        setStep('fix-drools');
        return;
      }
      setError(result?.error ?? t('common:plugins.unknownError'));
      setStep('result');
    } catch (err) {
      logException(err, 'Failed to update plugin');
      setError(t('common:plugins.failedToUpdatePlugin'));
      setStep('result');
    }
  };

  const handleUninstall = async () => {
    setStep('processing');
    setActionLabel(t('common:plugins.actionUninstalling'));
    setError(null);

    try {
      const manager = PluginMarketplaceManager.getInstance();
      const uninstallSuccess = await manager.uninstallPlugin(
        plugin.id,
        plugin.scope
      );

      if (uninstallSuccess) {
        setSuccess(true);
        setActionLabel(t('common:plugins.actionUninstalled'));
      } else {
        setError(t('common:plugins.couldNotUninstallMayBeRemoved'));
      }
    } catch (err) {
      logException(err, 'Failed to uninstall plugin');
      setError(t('common:plugins.couldNotUninstallRetry'));
    } finally {
      setStep('result');
    }
  };

  const { selectedIndex: menuIndex } = useMenuNavigation({
    items: ACTION_OPTIONS,
    initialIndex: 0,
    onSelect: (selected) => {
      switch (selected.action) {
        case 'info':
          setStep('info');
          break;
        case 'update':
          void handleUpdate();
          break;
        case 'uninstall':
          setStep('confirm-uninstall');
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

  const { selectedIndex: confirmIndex } = useMenuNavigation({
    items: CONFIRM_OPTIONS,
    initialIndex: 1,
    onSelect: (selected) => {
      if (selected.confirm) {
        void handleUninstall();
      } else {
        setStep('menu');
      }
    },
    onCancel: () => setStep('menu'),
    isActive: step === 'confirm-uninstall',
  });

  useKeypressHandler(
    (input, key) => {
      if (key.return || key.escape || input.toLowerCase() === 'q') {
        if (step === 'info') {
          setStep('menu');
        } else if (step === 'result') {
          onComplete();
        }
      }
    },
    { isActive: step === 'info' || step === 'result' }
  );

  if (step === 'menu') {
    return (
      <MenuContainer
        title={plugin.id}
        helpText={t('common:plugins.helpNavigateSelect')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Box flexDirection="column">
          {ACTION_OPTIONS.map((option, index) => {
            const isSelected = index === menuIndex;
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

  if (step === 'info') {
    return (
      <MenuContainer
        title={t('common:plugins.pluginInfoTitle', { id: plugin.id })}
        helpText={t('common:plugins.helpBack')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Box flexDirection="column">
          <Text>
            <Text color={COLORS.text.muted}>{t('common:plugins.idLabel')}</Text>
            {plugin.id}
          </Text>
          <Text>
            <Text color={COLORS.text.muted}>
              {t('common:plugins.scopeLabel')}
            </Text>
            {plugin.scope}
          </Text>
          <Text>
            <Text color={COLORS.text.muted}>
              {t('common:plugins.versionLabel')}
            </Text>
            {formatVersion(plugin.version)}
          </Text>
          <Text>
            <Text color={COLORS.text.muted}>
              {t('common:plugins.sourceLabel')}
            </Text>
            {plugin.source}
          </Text>
          <Text>
            <Text color={COLORS.text.muted}>
              {t('common:plugins.installedLabel')}
            </Text>
            {formatDate(plugin.installedAt)}
          </Text>
          <Text>
            <Text color={COLORS.text.muted}>
              {t('common:plugins.lastUpdatedLabel')}
            </Text>
            {formatDate(plugin.lastUpdated)}
          </Text>
          <Text>
            <Text color={COLORS.text.muted}>
              {t('common:plugins.pathLabel')}
            </Text>
            {plugin.installPath}
          </Text>
          {warnings.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color={COLORS.warning}>
                {t('common:plugins.loadWarning')}
              </Text>
            </Box>
          )}
        </Box>
      </MenuContainer>
    );
  }

  if (step === 'confirm-uninstall') {
    return (
      <MenuContainer
        title={t('common:plugins.confirmUninstallTitle', { id: plugin.id })}
        helpText={t('common:plugins.helpNavigate')}
        minContentHeight={PLUGIN_CONTENT_HEIGHT}
      >
        <Box flexDirection="column">
          <Text color={COLORS.warning}>
            {t('common:plugins.confirmUninstall', { id: plugin.id })}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {CONFIRM_OPTIONS.map((option, index) => {
              const isSelected = index === confirmIndex;
              return (
                <Box key={option.label}>
                  <Box width={2}>
                    <Text> </Text>
                  </Box>
                  <Text
                    bold={isSelected}
                    color={isSelected ? COLORS.text.primary : COLORS.text.muted}
                  >
                    {confirmLabelMap[option.label] || option.label}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      </MenuContainer>
    );
  }

  if (step === 'processing') {
    return (
      <MenuContainer title={plugin.id} minContentHeight={PLUGIN_CONTENT_HEIGHT}>
        <Text color={COLORS.text.muted}>
          {t('common:plugins.processing', {
            action: actionLabel,
            id: plugin.id,
          })}
        </Text>
      </MenuContainer>
    );
  }

  if (step === 'fix-drools') {
    return (
      <PluginDroolModelFixFlow
        pluginId={plugin.id}
        onComplete={() => setStep('result')}
      />
    );
  }

  return (
    <MenuContainer
      title={plugin.id}
      helpText={t('common:plugins.helpContinue')}
      minContentHeight={PLUGIN_CONTENT_HEIGHT}
    >
      {success ? (
        <Text color={COLORS.success}>
          {t('common:plugins.successAction', {
            action: actionLabel.toLowerCase(),
            id: plugin.id,
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
