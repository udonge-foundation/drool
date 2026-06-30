import { Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BuiltInThemeName } from '@industry/common/settings/enums';

import { MenuContainer } from '@/components/common/MenuContainer';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { getSettingsService } from '@/services/SettingsService';
import { applyOverrideTerminalColors } from '@/theme/applyThemeChange';
import { getThemeEngine } from '@/theme/ThemeEngine';

interface ThemeSelectorProps {
  onThemeSelect: (themeName: string) => boolean;
  onCancel: () => void;
  onThemeChanged?: () => void;
}

type ThemeMenuItem =
  | { kind: 'auto'; resolvedName: string }
  | { kind: 'theme'; name: string; appearance: string; isUserTheme: boolean }
  | { kind: 'toggle'; id: string };

export function ThemeSelector({
  onThemeSelect,
  onCancel,
  onThemeChanged,
}: ThemeSelectorProps) {
  const { t } = useTranslation();
  const engine = getThemeEngine();
  const currentTheme = engine.getActiveThemeName();
  const isAutoActive = engine.isResolvedFromAuto();
  const savedTheme = getSettingsService().getSettings().general?.theme;
  const themes = useMemo(() => engine.getAvailableThemes(), [engine]);

  const [overrideColors, setOverrideColors] = useState(
    getSettingsService().getOverrideTerminalColors()
  );

  const menuItems: ThemeMenuItem[] = [
    { kind: 'auto', resolvedName: engine.resolveAutoTheme() },
    ...themes.map((th) => ({ kind: 'theme' as const, ...th })),
    { kind: 'toggle', id: 'override-terminal-colors' },
  ];

  const findCurrentIndex = (): number => {
    if (savedTheme === BuiltInThemeName.Auto || (!savedTheme && isAutoActive)) {
      return 0;
    }
    const idx = menuItems.findIndex(
      (item) => item.kind === 'theme' && item.name === currentTheme
    );
    return idx >= 0 ? idx : 0;
  };
  const initialIndex = findCurrentIndex();

  const { selectedIndex } = useMenuNavigation<ThemeMenuItem>({
    items: menuItems,
    initialIndex,
    wrapAround: true,
    onSelect: (option) => {
      if (option.kind === 'toggle') {
        const nextValue = !overrideColors;
        setOverrideColors(nextValue);
        applyOverrideTerminalColors(nextValue);
        onThemeChanged?.();
        return;
      }
      if (option.kind === 'auto') {
        if (savedTheme === BuiltInThemeName.Auto) {
          onCancel();
          return;
        }
        if (onThemeSelect(BuiltInThemeName.Auto)) {
          onThemeChanged?.();
        }
        return;
      }
      if (option.name === currentTheme && !isAutoActive) {
        onCancel();
        return;
      }
      if (onThemeSelect(option.name)) {
        onThemeChanged?.();
      }
    },
    onCancel,
  });

  const accentColor = engine.getColors().primary;

  return (
    <MenuContainer title="Theme" paddingY={0} helpText="Esc cancel">
      {menuItems.map((item, index) => {
        const isSelected = index === selectedIndex;

        if (item.kind === 'auto') {
          const isCurrent =
            savedTheme === BuiltInThemeName.Auto ||
            (!savedTheme && isAutoActive);
          return (
            <Box key="auto" marginBottom={0}>
              <Box width={2}>
                <Text color={isCurrent ? accentColor : undefined}>
                  {isCurrent ? '●' : ' '}
                </Text>
              </Box>
              <Box flexDirection="column">
                <Box>
                  <Text
                    bold={isSelected}
                    color={isSelected ? accentColor : undefined}
                  >
                    {t('common:settings.themeAutoLabel')}
                  </Text>
                  <Text dimColor>
                    {' '}
                    {t('common:settings.themeAutoHint', {
                      resolved: item.resolvedName,
                    })}
                  </Text>
                </Box>
              </Box>
            </Box>
          );
        }

        if (item.kind === 'toggle') {
          return (
            <Box key={item.id} marginTop={1} marginBottom={0}>
              <Box width={2}>
                <Text> </Text>
              </Box>
              <Text
                bold={isSelected}
                color={isSelected ? accentColor : undefined}
              >
                {t('common:settings.overrideTerminalColors')}:{' '}
                {overrideColors
                  ? t('common:settings.on')
                  : t('common:settings.off')}
              </Text>
              <Text dimColor>
                {' '}
                {t('common:settings.overrideTerminalColorsHint')}
              </Text>
            </Box>
          );
        }

        const isCurrent = item.name === currentTheme && !isAutoActive;

        return (
          <Box key={item.name} marginBottom={0}>
            <Box width={2}>
              <Text color={isCurrent ? accentColor : undefined}>
                {isCurrent ? '●' : ' '}
              </Text>
            </Box>
            <Box flexDirection="column">
              <Box>
                <Text
                  bold={isSelected}
                  color={isSelected ? accentColor : undefined}
                >
                  {item.name}
                </Text>
                <Text dimColor>
                  {' '}
                  {item.appearance}
                  {item.isUserTheme ? ' · custom' : ''}
                </Text>
              </Box>
            </Box>
          </Box>
        );
      })}
    </MenuContainer>
  );
}
