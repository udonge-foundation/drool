import { useTranslation } from 'react-i18next';

import { getLocalizedCommandDescription } from '@/commands/commandDescriptions';
import { SlashCommand } from '@/commands/types';
import { COLORS } from '@/components/chat/themedColors';
import { SelectableList } from '@/components/SelectableList';

interface CommandSuggestionsProps {
  commands: SlashCommand[];
  selectedIndex: number;
  width?: number;
}

export function CommandSuggestions({
  commands,
  selectedIndex,
  width = 60,
}: CommandSuggestionsProps) {
  const { t } = useTranslation('common');

  const formatDescription = (description: string): string => {
    if (!description) return t('chatInput.noDescription');
    return description.replace(/\s+/g, ' ').trim();
  };

  // Calculate the maximum command name length for alignment
  const maxCommandLength = Math.max(...commands.map((c) => c.name.length));

  const prefixWidth = 2; // "> " or "  "
  const slashWidth = 1;
  const minPadding = 2;
  const borderOverhead = 2; // left margin indent
  const availableForDesc =
    width -
    prefixWidth -
    slashWidth -
    maxCommandLength -
    minPadding -
    borderOverhead;

  return (
    <SelectableList
      items={commands.map((cmd) => {
        const padding = ' '.repeat(
          Math.max(1, maxCommandLength - cmd.name.length + minPadding)
        );
        let description = formatDescription(
          getLocalizedCommandDescription(cmd.name, cmd.description)
        );
        if (description.length > availableForDesc && availableForDesc > 3) {
          description = `${description.slice(0, availableForDesc - 3)}...`;
        } else if (availableForDesc <= 3) {
          description = '';
        }
        return {
          label: `/${cmd.name}`,
          value: cmd.name,
          suffix: `${padding}${description}`,
          suffixColor: COLORS.text.muted,
          defaultColor: COLORS.text.muted,
          selectedColor: COLORS.text.primary,
          selectedPrefix: '  ',
        };
      })}
      selectedIndex={selectedIndex}
      width={width}
      noBorder
      marginTop={0}
      visibleCount={6}
      minVisibleCount={6}
    />
  );
}
