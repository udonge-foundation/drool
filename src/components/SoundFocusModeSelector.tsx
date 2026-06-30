import { useTranslation } from 'react-i18next';

import { SoundFocusMode } from '@industry/common/settings/enums';

import { MenuContainer } from '@/components/common/MenuContainer';
import { MenuOptionRow } from '@/components/common/MenuOptionRow';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';

interface SoundFocusModeSelectorProps {
  currentMode: SoundFocusMode;
  onSelect: (mode: SoundFocusMode) => void;
  onCancel: () => void;
}

interface FocusModeOption {
  value: SoundFocusMode;
  labelKey: string;
  descriptionKey: string;
}

const FOCUS_MODE_OPTIONS: FocusModeOption[] = [
  {
    value: SoundFocusMode.Always,
    labelKey: 'common:soundFocusMode.always',
    descriptionKey: 'common:soundFocusMode.alwaysDescription',
  },
  {
    value: SoundFocusMode.Focused,
    labelKey: 'common:soundFocusMode.whenFocused',
    descriptionKey: 'common:soundFocusMode.whenFocusedDescription',
  },
  {
    value: SoundFocusMode.Unfocused,
    labelKey: 'common:soundFocusMode.whenUnfocused',
    descriptionKey: 'common:soundFocusMode.whenUnfocusedDescription',
  },
];

export function SoundFocusModeSelector({
  currentMode,
  onSelect,
  onCancel,
}: SoundFocusModeSelectorProps) {
  const { t } = useTranslation();
  const initialIndex = FOCUS_MODE_OPTIONS.findIndex(
    (opt) => opt.value === currentMode
  );

  const { selectedIndex } = useMenuNavigation({
    items: FOCUS_MODE_OPTIONS,
    initialIndex: initialIndex >= 0 ? initialIndex : 0,
    wrapAround: true,
    onSelect: (option) => {
      // If selecting the current option, go back to settings
      if (option.value === currentMode) {
        onCancel();
      } else {
        onSelect(option.value);
      }
    },
    onCancel,
  });

  return (
    <MenuContainer title={t('common:soundFocusMode.title')} paddingY={0}>
      {FOCUS_MODE_OPTIONS.map((option, index) => (
        <MenuOptionRow
          key={option.value}
          label={t(option.labelKey)}
          description={t(option.descriptionKey)}
          isSelected={index === selectedIndex}
          isCurrent={option.value === currentMode}
          currentLabel={t('common:soundFocusMode.current')}
        />
      ))}
    </MenuContainer>
  );
}
