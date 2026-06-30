import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { BuiltInSound } from '@industry/common/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import type { SoundOption } from '@/utils/types';

interface AwaitingInputSoundSelectorProps {
  currentSound: SoundOption;
  onSelect: (sound: SoundOption) => void;
  onCancel: () => void;
}

interface SoundOptionItem {
  value: SoundOption;
  labelKey: string;
  descriptionKey: string;
  selectable?: boolean;
}

const BASE_SOUND_OPTIONS: SoundOptionItem[] = [
  {
    value: 'off',
    labelKey: 'common:awaitingInputSoundSelector.off',
    descriptionKey: 'common:awaitingInputSoundSelector.offDescription',
  },
  {
    value: 'bell',
    labelKey: 'common:awaitingInputSoundSelector.terminalBell',
    descriptionKey: 'common:awaitingInputSoundSelector.terminalBellDescription',
  },
  {
    value: BuiltInSound.FX_OK01,
    labelKey: 'common:awaitingInputSoundSelector.fxOk01Label',
    descriptionKey: 'common:awaitingInputSoundSelector.fxOk01Description',
  },
  {
    value: BuiltInSound.FX_ACK01,
    labelKey: 'common:awaitingInputSoundSelector.fxAck01Label',
    descriptionKey: 'common:awaitingInputSoundSelector.fxAck01Description',
  },
  {
    value: '',
    labelKey: 'common:awaitingInputSoundSelector.customSound',
    descriptionKey:
      'common:awaitingInputSoundSelector.customSoundSetDescription',
    selectable: false,
  },
];

/**
 * Checks if a sound option is a custom file path
 */
function isCustomSoundPath(sound: SoundOption): boolean {
  return (
    sound !== 'off' &&
    sound !== 'bell' &&
    !Object.values(BuiltInSound).includes(sound as BuiltInSound)
  );
}

export function AwaitingInputSoundSelector({
  currentSound,
  onSelect,
  onCancel,
}: AwaitingInputSoundSelectorProps) {
  const { t } = useTranslation();

  // Build options list, replacing placeholder with actual custom sound if present
  const soundOptions: SoundOptionItem[] = BASE_SOUND_OPTIONS.map((opt) => {
    // Replace the custom sound placeholder (identified by empty value) with actual custom sound
    if (opt.value === '' && isCustomSoundPath(currentSound)) {
      return {
        value: currentSound,
        labelKey: 'common:awaitingInputSoundSelector.customSound',
        descriptionKey:
          'common:awaitingInputSoundSelector.customSoundFileDescription',
        selectable: true,
      };
    }
    return opt;
  });

  const initialIndex = soundOptions.findIndex(
    (opt) => opt.value === currentSound
  );

  const { selectedIndex } = useMenuNavigation({
    items: soundOptions,
    initialIndex: initialIndex >= 0 ? initialIndex : 0,
    wrapAround: true,
    isSelectable: (item) => item.selectable !== false,
    onSelect: (option) => {
      // If selecting the current option, go back to settings
      if (option.value === currentSound) {
        onCancel();
      } else {
        onSelect(option.value);
      }
    },
    onCancel,
  });

  return (
    <MenuContainer
      title={t('common:awaitingInputSoundSelector.title')}
      paddingY={0}
    >
      {soundOptions.map((option, index) => {
        const isSelected = index === selectedIndex;
        const isCurrent = option.value === currentSound;
        const isUnselectable = option.selectable === false;
        const displayLabel = t(option.labelKey);
        const displayDescription = isCustomSoundPath(option.value)
          ? t(option.descriptionKey, { path: option.value })
          : t(option.descriptionKey);

        return (
          <Box key={option.value || 'custom-placeholder'} marginBottom={0}>
            <Box width={2}>
              <Text color={isSelected ? COLORS.success : undefined}>
                {isSelected ? '>' : ' '}
              </Text>
            </Box>
            <Box flexDirection="column">
              <Box>
                <Text
                  bold={isSelected}
                  dimColor={isUnselectable}
                  color={isSelected ? COLORS.success : undefined}
                >
                  {displayLabel}
                  {isCurrent && (
                    <Text dimColor color={COLORS.text.muted}>
                      {' '}
                      {t('common:awaitingInputSoundSelector.current')}
                    </Text>
                  )}
                </Text>
              </Box>
              <Box paddingLeft={2}>
                <Text dimColor>{displayDescription}</Text>
              </Box>
            </Box>
          </Box>
        );
      })}
    </MenuContainer>
  );
}
