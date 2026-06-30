import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';

interface CadenceChipsProps {
  chips: ReadonlyArray<{ readonly label: string }>;
  selectedIndex: number;
  isFocused: boolean;
}

export function CadenceChips({
  chips,
  selectedIndex,
  isFocused,
}: CadenceChipsProps) {
  return (
    <Box flexDirection="column">
      <Box flexWrap="wrap">
        {chips.map((chip, index) => {
          const isSelected = index === selectedIndex;
          const focusedAndSelected = isFocused && isSelected;
          const left = focusedAndSelected ? '▸' : ' ';
          const right = focusedAndSelected ? '◂' : ' ';
          const color = isSelected
            ? focusedAndSelected
              ? COLORS.primary
              : COLORS.text.secondary
            : COLORS.text.muted;
          return (
            <Box key={chip.label} marginRight={1}>
              <Text color={color} bold={focusedAndSelected}>
                {`${left}[${chip.label}]${right}`}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
