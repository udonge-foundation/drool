import { Box, Text } from 'ink';
import { useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ANSI } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import type { KeyEvent } from '@/contexts/types';
import { ESC_27U } from '@/hooks/constants';
import { HookEventName, HookMatcherType } from '@/hooks/enums';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { getI18n } from '@/i18n';
import { getSettingsService } from '@/services/SettingsService';

import type { HookConfig } from '@industry/common/cli';

interface HookMatcherSelectorProps {
  hookType: HookEventName;
  onBack: () => void;
  onSelectMatcher: (config: HookConfig | null, isNew: boolean) => void;
}

type MenuOption =
  | { type: HookMatcherType.New }
  | { type: HookMatcherType.Matcher; config: HookConfig; index: number };

export function HookMatcherSelector({
  hookType,
  onBack,
  onSelectMatcher,
}: HookMatcherSelectorProps) {
  const { t } = useTranslation();
  const settingsService = getSettingsService();
  const settings = settingsService.getSettings();

  const menuOptions = useMemo(() => {
    const options: MenuOption[] = [{ type: HookMatcherType.New }];

    const configs = settings.hooks?.[hookType] || [];
    configs.forEach((config, index) => {
      options.push({ type: HookMatcherType.Matcher, config, index });
    });

    return options;
  }, [settings.hooks, hookType]);

  const { selectedIndex } = useMenuNavigation({
    items: menuOptions,
    initialIndex: 0,
    onSelect: (option) => {
      if (option.type === HookMatcherType.New) {
        onSelectMatcher(null, true);
      } else {
        onSelectMatcher(option.config, false);
      }
    },
    onCancel: onBack,
  });

  // Handle ESC_KITTY and ESC_27U sequences
  let keypressProvider = null;
  try {
    keypressProvider = useKeypressProvider();
  } catch {
    // Not available
  }

  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      const seq = event.key?.sequence as string | undefined;
      if (seq === ANSI.ESC_KITTY || seq === ESC_27U) {
        onBack();
      }
    };

    keypressProvider.subscribe(handler);
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [keypressProvider, onBack]);

  return (
    <MenuContainer title={t('common:hookMatcherSelector.title', { hookType })}>
      {menuOptions.map((option, index) => {
        const isSelected = index === selectedIndex;
        const color = isSelected ? COLORS.primary : COLORS.text.primary;

        if (option.type === HookMatcherType.New) {
          return (
            <Text key="new" color={color}>
              {isSelected ? '> ' : '  '}
              {t('common:hookMatcherSelector.addNewMatcher')}
            </Text>
          );
        }

        const matcher = option.config.matcher || '*';
        const commandRegex = option.config.commandRegex;
        const count = option.config.hooks.length;

        return (
          <Text key={`matcher-${index}`} color={color}>
            {isSelected ? '> ' : '  '}
            {matcher}
            {commandRegex && (
              <Text color={COLORS.text.muted}>
                {' '}
                {getI18n().t('common:hookMatcherSelector.commandRegexLabel', {
                  regex: commandRegex,
                })}
              </Text>
            )}
            <Text color={COLORS.text.muted}>
              {' '}
              ({getI18n().t('common:hooks.hookCount', { count })})
            </Text>
          </Text>
        );
      })}

      {menuOptions.length === 1 && (
        <Box marginTop={1}>
          <Text color={COLORS.text.muted} dimColor>
            {t('common:hookMatcherSelector.emptyState')}
          </Text>
        </Box>
      )}
    </MenuContainer>
  );
}
