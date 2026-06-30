import { SubagentSoundMode } from '@industry/common/settings/enums';

import { MenuContainer } from '@/components/common/MenuContainer';
import { MenuOptionRow } from '@/components/common/MenuOptionRow';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { getI18n } from '@/i18n';

interface SubagentSoundSelectorProps {
  currentMode: SubagentSoundMode;
  onSelect: (mode: SubagentSoundMode) => void;
  onCancel: () => void;
}

interface SubagentSoundOption {
  value: SubagentSoundMode;
  labelKey: string;
  descriptionKey: string;
}

const SUBAGENT_SOUND_OPTIONS: SubagentSoundOption[] = [
  {
    value: SubagentSoundMode.Off,
    labelKey: 'common:subagentSoundSelector.offLabel',
    descriptionKey: 'common:subagentSoundSelector.offDescription',
  },
  {
    value: SubagentSoundMode.Quiet,
    labelKey: 'common:subagentSoundSelector.quietLabel',
    descriptionKey: 'common:subagentSoundSelector.quietDescription',
  },
  {
    value: SubagentSoundMode.Inherit,
    labelKey: 'common:subagentSoundSelector.inheritLabel',
    descriptionKey: 'common:subagentSoundSelector.inheritDescription',
  },
];

export function SubagentSoundSelector({
  currentMode,
  onSelect,
  onCancel,
}: SubagentSoundSelectorProps) {
  const initialIndex = SUBAGENT_SOUND_OPTIONS.findIndex(
    (opt) => opt.value === currentMode
  );

  const { selectedIndex } = useMenuNavigation({
    items: SUBAGENT_SOUND_OPTIONS,
    initialIndex: initialIndex >= 0 ? initialIndex : 0,
    wrapAround: true,
    onSelect: (option) => {
      if (option.value === currentMode) {
        onCancel();
      } else {
        onSelect(option.value);
      }
    },
    onCancel,
  });

  const { t } = getI18n();

  return (
    <MenuContainer title={t('common:subagentSoundSelector.title')} paddingY={0}>
      {SUBAGENT_SOUND_OPTIONS.map((option, index) => (
        <MenuOptionRow
          key={option.value}
          label={t(option.labelKey)}
          description={t(option.descriptionKey)}
          isSelected={index === selectedIndex}
          isCurrent={option.value === currentMode}
          currentLabel={t('common:subagentSoundSelector.current')}
        />
      ))}
    </MenuContainer>
  );
}
