import { Box } from 'ink';

import type { ReactNode } from 'react';

interface ChatScreenProps {
  messages: ReactNode;
  inputArea: ReactNode;
}

export function ChatScreen({ messages, inputArea }: ChatScreenProps) {
  return (
    <Box flexDirection="column" width="100%">
      {messages}
      <Box flexShrink={0} width="100%" marginTop={0}>
        {inputArea}
      </Box>
    </Box>
  );
}
