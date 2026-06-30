import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import type { MarketplaceError } from '@/hooks/types';

interface MarketplaceErrorDisplayProps {
  title: string;
  errors: MarketplaceError[];
}

export function MarketplaceErrorDisplay({
  title,
  errors,
}: MarketplaceErrorDisplayProps) {
  return (
    <Box flexDirection="column">
      <Text color={COLORS.error}>{title}</Text>
      {errors.map((err, i) => (
        <Box key={i} flexDirection="column">
          <Text color={COLORS.text.muted}>
            {err.name ? `${err.name} (${err.source})` : err.source}
          </Text>
          <Text color={COLORS.text.muted}> {err.error}</Text>
        </Box>
      ))}
    </Box>
  );
}
