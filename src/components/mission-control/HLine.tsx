/**
 * Horizontal line component for Mission Control frame borders.
 *
 * Renders horizontal dividers with junction character support:
 *   HLine({ width, left: '├', right: '┤' })           → ├──────────┤
 *   HLine({ width, left: '├', right: '┤', mid: '┬', midPos: 60 }) → ├──────┬───┤
 */

import { Box, Text } from 'ink';

import { MC_COLORS } from '@/components/mission-control/constants';

interface HLineProps {
  /** Total width of the line (including left and right characters) */
  width: number;
  /** Left junction character (e.g., '├', '┌', '└') */
  left?: string;
  /** Right junction character (e.g., '┤', '┐', '┘') */
  right?: string;
  /** Optional middle junction character (e.g., '┬', '┴') */
  mid?: string;
  /** Position of the middle junction (column index from left) */
  midPos?: number;
}

export function HLine({
  width,
  left = '├',
  right = '┤',
  mid,
  midPos,
}: HLineProps) {
  if (mid && midPos !== undefined && width >= 3) {
    // Keep existing semantics where midPos includes border columns (0..width-1).
    // midPos=0 is treated as the first interior split position.
    const safeMidPos = Math.max(1, Math.min(width - 2, midPos));
    const leftW = Math.max(0, safeMidPos - 1);
    const rightW = Math.max(0, width - safeMidPos - 2);
    return (
      <Box>
        <Text color={MC_COLORS.border}>
          {left}
          {'─'.repeat(leftW)}
          {mid}
          {'─'.repeat(rightW)}
          {right}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color={MC_COLORS.border}>
        {left}
        {'─'.repeat(Math.max(0, width - 2))}
        {right}
      </Text>
    </Box>
  );
}
