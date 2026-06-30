import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MarkdownText } from '@/components/MarkdownText';

interface ProposeMissionDisplayProps {
  toolInput: Record<string, unknown>;
  contentWidth?: number;
}

export function ProposeMissionDisplay({
  toolInput,
  contentWidth,
}: ProposeMissionDisplayProps) {
  const { t } = useTranslation('common');

  if (typeof toolInput.proposal !== 'string' || !toolInput.proposal) {
    return null;
  }

  const title =
    typeof toolInput.title === 'string' ? toolInput.title : undefined;

  return (
    <Box flexDirection="column" marginTop={1} width="95%">
      <Box paddingX={1} flexDirection="column">
        <Text bold color={COLORS.agi}>
          {t('toolDisplay.proposeMissionDisplay.heading')}
        </Text>
        {title && <Text color={COLORS.text.muted}>{title}</Text>}
      </Box>

      <Box
        borderBottom
        borderTop
        borderRight={false}
        borderLeft={false}
        borderStyle="round"
        borderColor={COLORS.agi}
        padding={1}
      >
        <MarkdownText maxWidth={contentWidth ? contentWidth - 4 : undefined}>
          {toolInput.proposal}
        </MarkdownText>
      </Box>
    </Box>
  );
}
