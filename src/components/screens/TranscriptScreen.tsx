import { Box } from 'ink';

import type { ReactNode } from 'react';

interface TranscriptScreenProps {
  transcript: ReactNode;
  footer: ReactNode;
}

export function TranscriptScreen({
  transcript,
  footer,
}: TranscriptScreenProps) {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexGrow={1} flexDirection="column" width="100%">
        {transcript}
      </Box>
      <Box flexShrink={0} width="100%">
        {footer}
      </Box>
    </Box>
  );
}
