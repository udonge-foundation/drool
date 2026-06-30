import { Box } from 'ink';
import React from 'react';

import { isAbortNoticeText } from '@/components/chat/abortNotice';
import { CollapsedToolGroupComponent } from '@/components/CollapsedToolGroup';
import { shouldHideHookMessageFromChatView } from '@/components/hookDisplayUtils';
import { MessageItem } from '@/components/MessageItem';
import { ToolExecutionItem } from '@/components/ToolExecutionItem';
import { MessageRole, MessageType } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { getSettingsService } from '@/services/SettingsService';
import type { GroupedItem, ToolExecution } from '@/types/types';
import { SPEC_APPROVAL_NOTIFICATION_ID_SUFFIX } from '@/utils/constants';
import { isCollapsedGroup } from '@/utils/toolGrouping';

interface MessageRenderOptions {
  showThinking?: boolean;
  permissionToolIds?: ReadonlySet<string>;
  pendingPermissionToolIds?: ReadonlySet<string>;
  compact?: boolean;
  renderRegion?: 'static' | 'dynamic';
}

/**
 * Renders a single message or tool execution item.
 */
export function renderMessageItem(
  item: HistoryMessage | ToolExecution,
  contentWidth: number,
  key?: string,
  showThinking?: boolean,
  permissionToolIds?: ReadonlySet<string>,
  pendingPermissionToolIds?: ReadonlySet<string>,
  renderRegion?: 'static' | 'dynamic'
): React.JSX.Element | null {
  if ('toolName' in item && 'status' in item) {
    const toolExec = item as ToolExecution;
    const finalKey = key || toolExec.id;
    const isPendingPermission =
      pendingPermissionToolIds?.has(toolExec.id) === true;
    const wasPermissionTool = permissionToolIds?.has(toolExec.id) === true;
    const hideHeader =
      toolExec.toolName === 'Execute'
        ? false
        : wasPermissionTool && !isPendingPermission;
    return (
      <Box key={finalKey} width="100%" marginTop={1}>
        <ToolExecutionItem
          toolExecution={toolExec}
          contentWidth={contentWidth}
          isAwaitingPermission={isPendingPermission}
          hideHeader={hideHeader}
          renderRegion={renderRegion}
        />
      </Box>
    );
  }

  const msg = item as HistoryMessage;
  if (msg.role === MessageRole.Assistant && !msg.content.trim()) {
    return null;
  }

  if (
    msg.messageType === MessageType.Thinking &&
    msg.thinkingBlock &&
    !showThinking
  ) {
    return null;
  }
  if (msg.messageType === MessageType.HookExecution) {
    if (!msg.hookEventName || !msg.hookCommands || !msg.hookStatus) {
      return null;
    }
    if (!getSettingsService().getShowHookOutput()) {
      return null;
    }
    // Hide from chat, keep in transcript: noisy built-in hooks (e.g. the Git AI
    // checkpoint hook) are omitted here. The Ctrl+O detailed transcript renders
    // them via StaticDetailedTranscriptPanel, which does not use this path.
    if (shouldHideHookMessageFromChatView(msg)) {
      return null;
    }
  }

  const isAbortNotice =
    typeof msg.content === 'string' && isAbortNoticeText(msg.content);
  const isSpecApprovalNotification =
    msg.messageType === MessageType.SystemNotification &&
    msg.id.endsWith(SPEC_APPROVAL_NOTIFICATION_ID_SUFFIX);

  const finalKey = key || msg.id;
  return (
    <Box
      key={finalKey}
      marginLeft={isSpecApprovalNotification ? 3 : 0}
      marginTop={isAbortNotice || isSpecApprovalNotification ? 0 : 1}
    >
      <MessageItem
        message={msg}
        contentWidth={contentWidth}
        showThinking={showThinking}
      />
    </Box>
  );
}

/**
 * Renders a grouped item — a message, tool execution, or collapsed tool group.
 */
export function renderGroupedItem(
  item: GroupedItem,
  contentWidth: number,
  showThinkingOrOptions?: boolean | MessageRenderOptions,
  compact?: boolean
): React.JSX.Element | null {
  const renderOptions: MessageRenderOptions =
    typeof showThinkingOrOptions === 'object' && showThinkingOrOptions !== null
      ? showThinkingOrOptions
      : { showThinking: showThinkingOrOptions, compact };

  if (isCollapsedGroup(item)) {
    return (
      <Box key={`collapsed-${item.tools[0]?.id}`} width="100%" marginTop={1}>
        <CollapsedToolGroupComponent
          group={item}
          compact={renderOptions.compact}
        />
      </Box>
    );
  }
  return renderMessageItem(
    item,
    contentWidth,
    undefined,
    renderOptions.showThinking,
    renderOptions.permissionToolIds,
    renderOptions.pendingPermissionToolIds,
    renderOptions.renderRegion
  );
}
