import { Box } from 'ink';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { McpNavigator } from '@/commands/mcp/views/McpNavigator';
import { MessageType } from '@/hooks/enums';
import type { McpAuthRequiredInfo } from '@/services/mcp/types';

interface McpManagerProps {
  sessionId: string;
  mcpAuthPending?: McpAuthRequiredInfo | null;
  onClose: () => void;
  addEphemeralSystemMessage: (
    content: string,
    options?: {
      messageType?: MessageType;
      visibility?: MessageVisibility;
    }
  ) => void;
}

export function McpManager({
  sessionId,
  mcpAuthPending,
  onClose,
  addEphemeralSystemMessage,
}: McpManagerProps) {
  return (
    <Box flexDirection="column">
      <McpNavigator
        sessionId={sessionId}
        mcpAuthPending={mcpAuthPending}
        onExit={onClose}
        addEphemeralSystemMessage={addEphemeralSystemMessage}
      />
    </Box>
  );
}
