import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import type { ToolResultContent } from '@/hooks/types';
import { getTextContent } from '@/utils/tool-result-helpers';

interface InputOnlyDetailedToolOutputProps {
  result: ToolResultContent | undefined;
  isError?: boolean;
  errorPrefix?: string;
}

export function renderInputOnlyDetailedToolOutput({
  result,
  isError,
  errorPrefix,
}: InputOnlyDetailedToolOutputProps) {
  if (!isError) {
    return null;
  }

  const resultText = getTextContent(result);
  const errorText = errorPrefix ? `${errorPrefix} ${resultText}` : resultText;

  return (
    <Box flexDirection="column">
      <Text color={COLORS.error}>{errorText}</Text>
    </Box>
  );
}
