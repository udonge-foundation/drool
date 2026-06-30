import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';

interface MenuOptionRowProps {
  label: string;
  description: string;
  isSelected: boolean;
  isCurrent: boolean;
  currentLabel: string;
  unselectable?: boolean;
}

export function MenuOptionRow({
  label,
  description,
  isSelected,
  isCurrent,
  currentLabel,
  unselectable = false,
}: MenuOptionRowProps) {
  return (
    <Box marginBottom={0}>
      <Box width={2}>
        <Text color={isSelected ? COLORS.success : undefined}>
          {isSelected ? '>' : ' '}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text
            bold={isSelected}
            dimColor={unselectable}
            color={isSelected ? COLORS.success : undefined}
          >
            {label}
            {isCurrent && (
              <Text dimColor color={COLORS.text.muted}>
                {' '}
                {currentLabel}
              </Text>
            )}
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor>{description}</Text>
        </Box>
      </Box>
    </Box>
  );
}
