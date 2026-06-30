import { useTranslation } from 'react-i18next';

import { BuiltInSound } from '@industry/common/settings';

import { MenuContainer } from '@/components/common/MenuContainer';
import { MenuOptionRow } from '@/components/common/MenuOptionRow';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import type { SoundOption } from '@/utils/types';

interface SoundSelectorProps {
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
    labelKey: 'common:soundSelector.off',
    descriptionKey: 'common:soundSelector.offDescription',
  },
  {
    value: 'bell',
    labelKey: 'common:soundSelector.terminalBell',
    descriptionKey: 'common:soundSelector.terminalBellDescription',
  },
  {
    value: BuiltInSound.FX_OK01,
    labelKey: 'common:soundSelector.fxOk01Label',
    descriptionKey: 'common:soundSelector.fxOk01Description',
  },
  {
    value: BuiltInSound.FX_ACK01,
    labelKey: 'common:soundSelector.fxAck01Label',
    descriptionKey: 'common:soundSelector.fxAck01Description',
  },
  {
    value: '',
    labelKey: 'common:soundSelector.customSound',
    descriptionKey: 'common:soundSelector.customSoundSetDescription',
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

export function SoundSelector({
  currentSound,
  onSelect,
  onCancel,
}: SoundSelectorProps) {
  const { t } = useTranslation();

  // Build options list, replacing placeholder with actual custom sound if present
  const soundOptions: SoundOptionItem[] = BASE_SOUND_OPTIONS.map((opt) => {
    // Replace the unselectable placeholder with the actual custom sound
    if (opt.value === '' && isCustomSoundPath(currentSound)) {
      return {
        value: currentSound,
        labelKey: 'common:soundSelector.customSound',
        descriptionKey: 'common:soundSelector.customSoundFileDescription',
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
    <MenuContainer title={t('common:soundSelector.title')} paddingY={0}>
      {soundOptions.map((option, index) => {
        const displayDescription = isCustomSoundPath(option.value)
          ? t(option.descriptionKey, { path: option.value })
          : t(option.descriptionKey);

        return (
          <MenuOptionRow
            key={option.value || 'custom-placeholder'}
            label={t(option.labelKey)}
            description={displayDescription}
            isSelected={index === selectedIndex}
            isCurrent={option.value === currentSound}
            currentLabel={t('common:soundSelector.current')}
            unselectable={option.selectable === false}
          />
        );
      })}
    </MenuContainer>
  );
}
