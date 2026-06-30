import { Box } from 'ink';

import { logWarn } from '@industry/logging';

import { DynamicMessageList } from '@/components/DynamicMessageList';
import { StaticMessageList } from '@/components/StaticMessageList';
import type { HistoryMessage } from '@/hooks/types';
import { ProfiledRegion } from '@/profiling/ProfiledRegion';
import type { ToolExecution } from '@/types/types';
import { findStaticBoundary } from '@/utils/messageUtils';

interface MessageListProps {
  groupedMessages: Array<HistoryMessage | ToolExecution>;
  contentWidth: number;
  headerWidth?: number;
  staticKey: number;
  isConversationEmpty: boolean;
  showThinking?: boolean;
  isAgentRunning?: boolean;
  permissionToolIds?: ReadonlySet<string>;
  staticToolIds?: ReadonlySet<string>;
  pendingPermissionToolIds?: ReadonlySet<string>;
  toolInputOverridesById?: ReadonlyMap<string, Record<string, unknown>>;
}

export function applyPendingPermissionToolInputs(
  messages: Array<HistoryMessage | ToolExecution>,
  pendingPermissionToolInputsById?: ReadonlyMap<string, Record<string, unknown>>
): Array<HistoryMessage | ToolExecution> {
  if (!pendingPermissionToolInputsById?.size) {
    return messages;
  }

  let changed = false;
  const nextMessages = messages.map((item) => {
    if (!('toolName' in item && 'status' in item)) {
      return item;
    }

    const pendingInput = pendingPermissionToolInputsById.get(item.id);
    if (!pendingInput || item.toolInput === pendingInput) {
      return item;
    }

    changed = true;
    return {
      ...item,
      toolInput: pendingInput,
    };
  });

  return changed ? nextMessages : messages;
}

export function MessageList({
  groupedMessages,
  contentWidth,
  headerWidth,
  staticKey,
  isConversationEmpty,
  showThinking,
  isAgentRunning,
  permissionToolIds,
  staticToolIds,
  pendingPermissionToolIds,
  toolInputOverridesById,
}: MessageListProps) {
  const renderedMessages = applyPendingPermissionToolInputs(
    groupedMessages,
    toolInputOverridesById
  );

  // Find the boundary between static (completed) and dynamic (pending) messages
  const staticBoundaryIndex = findStaticBoundary(renderedMessages, {
    isAgentRunning,
    staticToolIds,
  });
  const staticMessages = renderedMessages.slice(0, staticBoundaryIndex);
  const dynamicMessages = renderedMessages.slice(staticBoundaryIndex);

  // Only log when there are many dynamic messages (potential rendering degradation)
  if (dynamicMessages.length > 50) {
    logWarn('High dynamic message count - potential rendering degradation', {
      index: staticBoundaryIndex,
      count: staticMessages.length,
      currentCount: dynamicMessages.length,
    });
  }

  return (
    <Box flexDirection="column" width="100%">
      <ProfiledRegion id="StaticMessageList">
        <StaticMessageList
          messages={staticMessages}
          contentWidth={contentWidth}
          headerWidth={headerWidth}
          staticKey={staticKey}
          isConversationEmpty={isConversationEmpty}
          showThinking={showThinking}
          permissionToolIds={permissionToolIds}
          pendingPermissionToolIds={pendingPermissionToolIds}
        />
      </ProfiledRegion>
      <ProfiledRegion id="DynamicMessageList">
        <DynamicMessageList
          messages={dynamicMessages}
          contentWidth={contentWidth}
          showThinking={showThinking}
          permissionToolIds={permissionToolIds}
          pendingPermissionToolIds={pendingPermissionToolIds}
        />
      </ProfiledRegion>
    </Box>
  );
}
