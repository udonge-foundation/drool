import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';

/**
 * Renders a horizontal line separator using box-drawing characters
 * @param width - The width of the line in characters
 * @param color - Optional color for the line (defaults to COLORS.border)
 */
export function HorizontalLine({
  width,
  color = COLORS.border,
}: {
  width: number;
  color?: string;
}) {
  return (
    <Box width={width}>
      <Text color={color}>{'─'.repeat(width)}</Text>
    </Box>
  );
}
