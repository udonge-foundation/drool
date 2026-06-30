import { Box, Text } from 'ink';

import { MC_COLORS } from '@/components/mission-control/constants';

import type { ReactNode } from 'react';

export function FrameContentRow({
  width,
  children,
}: {
  width: number;
  children?: ReactNode;
}) {
  return (
    <Box height={1}>
      <Text color={MC_COLORS.border}>│</Text>
      <Box width={width} height={1} overflow="hidden">
        {children}
      </Box>
      <Text color={MC_COLORS.border}>│</Text>
    </Box>
  );
}
