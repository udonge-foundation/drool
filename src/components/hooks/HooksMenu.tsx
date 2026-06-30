import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ANSI } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import type { KeyEvent } from '@/contexts/types';
import { ESC_27U } from '@/hooks/constants';
import { HookEventName } from '@/hooks/enums';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { getSettingsService } from '@/services/SettingsService';

interface HooksMenuProps {
  onClose: () => void;
  onSelectHookType: (hookType: HookEventName) => void;
}

type HookTypeItem = {
  itemType: 'hookType';
  type: HookEventName;
  labelKey: string;
  descriptionKey: string;
};

type ToggleItem = {
  itemType: 'toggle';
  id: string;
  labelKey: string;
  descriptionKey: string;
};

type MenuItem = HookTypeItem | ToggleItem;

const HOOK_TYPES: HookTypeItem[] = [
  {
    itemType: 'hookType',
    type: HookEventName.PreToolUse,
    labelKey: 'common:hooksMenu.preToolUse',
    descriptionKey: 'common:hooksMenu.preToolUseDescription',
  },
  {
    itemType: 'hookType',
    type: HookEventName.PostToolUse,
    labelKey: 'common:hooksMenu.postToolUse',
    descriptionKey: 'common:hooksMenu.postToolUseDescription',
  },
  {
    itemType: 'hookType',
    type: HookEventName.UserPromptSubmit,
    labelKey: 'common:hooksMenu.userPromptSubmit',
    descriptionKey: 'common:hooksMenu.userPromptSubmitDescription',
  },
  {
    itemType: 'hookType',
    type: HookEventName.Notification,
    labelKey: 'common:hooksMenu.notification',
    descriptionKey: 'common:hooksMenu.notificationDescription',
  },
  {
    itemType: 'hookType',
    type: HookEventName.Stop,
    labelKey: 'common:hooksMenu.stop',
    descriptionKey: 'common:hooksMenu.stopDescription',
  },
  {
    itemType: 'hookType',
    type: HookEventName.SubagentStop,
    labelKey: 'common:hooksMenu.subagentStop',
    descriptionKey: 'common:hooksMenu.subagentStopDescription',
  },
  {
    itemType: 'hookType',
    type: HookEventName.PreCompact,
    labelKey: 'common:hooksMenu.preCompact',
    descriptionKey: 'common:hooksMenu.preCompactDescription',
  },
  {
    itemType: 'hookType',
    type: HookEventName.SessionStart,
    labelKey: 'common:hooksMenu.sessionStart',
    descriptionKey: 'common:hooksMenu.sessionStartDescription',
  },
  {
    itemType: 'hookType',
    type: HookEventName.SessionEnd,
    labelKey: 'common:hooksMenu.sessionEnd',
    descriptionKey: 'common:hooksMenu.sessionEndDescription',
  },
];

const TOGGLE_ITEM: ToggleItem = {
  itemType: 'toggle',
  id: 'disable-hooks',
  labelKey: 'common:hooksMenu.allHooks',
  descriptionKey: 'common:hooksMenu.allHooksDescription',
};

export function HooksMenu({ onClose, onSelectHookType }: HooksMenuProps) {
  const { t } = useTranslation();
  const settingsService = getSettingsService();
  const settings = settingsService.getSettings();
  const [hooksDisabled, setHooksDisabled] = useState(
    settingsService.getHooksDisabled()
  );

  const menuItems: MenuItem[] = [...HOOK_TYPES, TOGGLE_ITEM];

  const handleSelect = (item: MenuItem) => {
    if (item.itemType === 'hookType') {
      onSelectHookType(item.type);
    } else if (item.itemType === 'toggle') {
      const newValue = !hooksDisabled;
      settingsService.setHooksDisabled(newValue);
      setHooksDisabled(newValue);
    }
  };

  const { selectedIndex } = useMenuNavigation({
    items: menuItems,
    initialIndex: 0,
    onSelect: handleSelect,
    onCancel: onClose,
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
        onClose();
      }
    };

    keypressProvider.subscribe(handler);
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [keypressProvider, onClose]);

  const getHookCount = (hookType: HookEventName): number => {
    const hooks = settings.hooks?.[hookType] || [];
    return hooks.reduce((acc, config) => acc + config.hooks.length, 0);
  };

  return (
    <MenuContainer title={t('common:hooksMenu.title')}>
      <Text color={COLORS.text.muted}>
        {t('common:hooksMenu.selectHookType')}
      </Text>
      <Box marginTop={1} />

      {menuItems.map((item, index) => {
        const isSelected = index === selectedIndex;

        if (item.itemType === 'hookType') {
          const count = getHookCount(item.type);
          const color = isSelected ? COLORS.primary : COLORS.text.primary;

          return (
            <Box key={item.type} flexDirection="column">
              <Text color={color}>
                {isSelected ? '> ' : '  '}
                {t(item.labelKey)}
                <Text color={COLORS.text.muted}>
                  {' '}
                  {t('common:hooksMenu.hookCount', { count })}
                </Text>
              </Text>
              {isSelected && (
                <Box paddingLeft={4}>
                  <Text color={COLORS.text.muted} dimColor>
                    {t(item.descriptionKey)}
                  </Text>
                </Box>
              )}
            </Box>
          );
        }

        // Toggle item
        const color = isSelected ? COLORS.primary : COLORS.text.primary;
        const statusColor = hooksDisabled ? COLORS.error : COLORS.success;
        const statusText = hooksDisabled
          ? t('common:hooksMenu.disabled')
          : t('common:hooksMenu.enabled');

        return (
          <Box key={item.id} flexDirection="column">
            <Box marginTop={1} />
            <Text color={color}>
              {isSelected ? '> ' : '  '}
              {t(item.labelKey)}: <Text color={statusColor}>{statusText}</Text>
            </Text>
            {isSelected && (
              <Box paddingLeft={4}>
                <Text color={COLORS.text.muted} dimColor>
                  {t(item.descriptionKey)}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
    </MenuContainer>
  );
}
