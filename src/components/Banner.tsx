import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';

interface BannerProps {
  variant: 'header' | 'footer';
  title: string;
  body: string;
  width: number;
}

export function Banner({ variant, title, body, width }: BannerProps) {
  const color = variant === 'header' ? COLORS.warning : COLORS.error;
  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={color} bold>
        {title}
      </Text>
      <Text color={COLORS.text.primary}>{body}</Text>
    </Box>
  );
}
