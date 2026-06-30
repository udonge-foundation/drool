import { Box, Text } from 'ink';
import React from 'react';

import { hasJsonRenderTags } from '@industry/utils/jsonRender';

import {
  BashResultDisplay,
  isBashResult,
} from '@/components/BashResultDisplay';
import {
  getAbortNoticeDisplayText,
  isAbortNoticeText,
} from '@/components/chat/abortNotice';
import { COLORS } from '@/components/chat/themedColors';
import { HookDisplay } from '@/components/HookDisplay';
import {
  getVisibleHookIndicesForChatView,
  shouldHideHookMessageFromChatView,
} from '@/components/hookDisplayUtils';
import { JsonRenderContent } from '@/components/JsonRenderContent';
import { MarkdownText } from '@/components/MarkdownText';
import { ParallelHooksDisplay } from '@/components/ParallelHooksDisplay';
import { ThinkingDisplay } from '@/components/ThinkingDisplay';
import { HookExecutionStatus, MessageRole, MessageType } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { getI18n } from '@/i18n';
import { getSettingsService } from '@/services/SettingsService';
import { SPEC_APPROVAL_NOTIFICATION_ID_SUFFIX } from '@/utils/constants';

interface MessageItemProps {
  message: HistoryMessage;
  contentWidth: number;
  showThinking?: boolean; // Default false
  isDetailedView?: boolean;
}

/**
 * Highlight backtick-delimited slash commands (e.g. `` `/limits` ``) in
 * text with a given color. Only renders the inner slash-command text
 * highlighted; the surrounding backticks are stripped.
 *
 * Authors must explicitly opt in by wrapping the command in backticks
 * in source/locale strings — bare `/limits` is left as plain text on
 * purpose so we never bold an arbitrary path-shaped substring.
 */
function highlightSlashCommands(text: string, color: string): React.ReactNode {
  const pattern = /`(\/[a-z][\w-]*)`/g;
  if (!pattern.test(text)) return text;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <Text key={match.index} color={color} bold>
        {match[1]}
      </Text>
    );
    lastIndex = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

const APPROVAL_COMMENT_LABEL_KEY =
  'common:toolDisplay.permission.commentPrefix';

function getHookStatusForResult(
  result: NonNullable<HistoryMessage['hookResults']>[number] | undefined,
  fallbackStatus: HookExecutionStatus
): HookExecutionStatus {
  if (result) {
    return result.exitCode === 0
      ? HookExecutionStatus.Completed
      : HookExecutionStatus.Error;
  }
  return fallbackStatus;
}

export function MessageItem({
  message,
  contentWidth,
  showThinking = false,
  isDetailedView = false,
}: MessageItemProps) {
  // Handle hook execution messages
  if (message.messageType === MessageType.HookExecution) {
    if (
      !message.hookEventName ||
      !message.hookCommands ||
      !message.hookStatus
    ) {
      return null;
    }

    if (!getSettingsService().getShowHookOutput()) {
      return null;
    }

    // Hide from chat, keep in transcript: noisy built-in hooks (e.g. the Git AI
    // checkpoint hook) are suppressed in the chat view but still rendered in the
    // Ctrl+O detailed transcript, which passes isDetailedView.
    if (!isDetailedView && shouldHideHookMessageFromChatView(message)) {
      return null;
    }

    // For partially-visible batches in the chat view, filter out the
    // individually-hideable hooks (e.g. successful suppressOutput hooks running
    // alongside a failing sibling) so users only see the hooks that need their
    // attention. The detailed transcript keeps everything.
    const visibleHookCommands = message.hookCommands;
    const visibleHookResults = message.hookResults;
    let visibleCommands = visibleHookCommands;
    let visibleResults = visibleHookResults;
    if (!isDetailedView) {
      const indices = getVisibleHookIndicesForChatView(message);
      if (indices.length !== visibleHookCommands.length) {
        visibleCommands = indices.map((i) => visibleHookCommands[i]!);
        visibleResults = visibleHookResults
          ? indices.map((i) => visibleHookResults[i]!)
          : visibleHookResults;
      }
    }

    // Use parallel display if multiple hooks are executing
    if (message.isParallelExecution && visibleCommands.length > 1) {
      const fallbackStatus =
        message.hookStatus || HookExecutionStatus.Executing;
      const hooks = visibleCommands.map((cmd, index) => ({
        id: `${message.id}-${index}`,
        command: cmd.command,
        timeout: cmd.timeout,
        status: getHookStatusForResult(visibleResults?.[index], fallbackStatus),
        result: visibleResults?.[index],
        startTime: message.startTime,
        endTime: message.endTime,
      }));

      return (
        <ParallelHooksDisplay
          hookEventName={message.hookEventName}
          hookMatcher={message.hookMatcher}
          hooks={hooks}
          contentWidth={contentWidth}
          isDetailedView={isDetailedView}
        />
      );
    }

    // Use standard single hook display
    return (
      <HookDisplay
        hookEventName={message.hookEventName}
        hookMatcher={message.hookMatcher}
        hookCommands={visibleCommands}
        hookStatus={message.hookStatus}
        hookResults={visibleResults}
        contentWidth={contentWidth}
        isDetailedView={isDetailedView}
      />
    );
  }

  // Handle thinking messages (first-class thinking blocks)
  if (message.messageType === MessageType.Thinking && message.thinkingBlock) {
    // Only render when thinking is enabled for this view.
    if (!showThinking) {
      return null;
    }
    return (
      <ThinkingDisplay
        thinking={{ thinkingBlocks: [message.thinkingBlock] }}
        contentWidth={contentWidth}
      />
    );
  }

  const isSystemError =
    message.role === MessageRole.System &&
    typeof message.content === 'string' &&
    (message.content.startsWith('Error:') ||
      message.content.startsWith('API Validation Error:'));

  const isAbortNotice =
    typeof message.content === 'string' && isAbortNoticeText(message.content);

  const isSystemWarning =
    message.role === MessageRole.System &&
    typeof message.content === 'string' &&
    message.content.startsWith('Warning:');

  const systemWarningPrefix = isSystemWarning ? 'Warning:' : null;
  const bodyCopyColor = isAbortNotice
    ? COLORS.text.muted
    : isSystemError
      ? COLORS.error
      : COLORS.text.primary;

  // Trim leading whitespace for assistant messages
  // Trim trailing whitespace for user messages (prevents double newlines in UI)
  const baseContent =
    message.role === MessageRole.Assistant &&
    typeof message.content === 'string'
      ? message.content.trimStart()
      : message.role === MessageRole.User && typeof message.content === 'string'
        ? message.content.trimEnd()
        : message.content;

  // Image count indicator for user messages (compact format, prepended to content)
  const imageCount = message.images?.length || 0;
  const imagePrefix =
    message.role === MessageRole.User && imageCount > 0
      ? `[${imageCount} ${imageCount === 1 ? 'image' : 'images'}] `
      : '';
  const displayContent =
    typeof baseContent === 'string'
      ? imagePrefix + getAbortNoticeDisplayText(baseContent)
      : imagePrefix + baseContent;
  const isBashResultMessage =
    typeof displayContent === 'string' && isBashResult(displayContent);

  const isUser = message.role === MessageRole.User && !isAbortNotice;

  // User messages: colored left bar + bg highlight + near-white text (Variation G)
  // Uses a background-colored column instead of Ink border so the bar copies as
  // spaces rather than ┃ box-drawing characters.
  if (isUser && !isBashResultMessage) {
    return (
      <Box flexDirection="column" width="100%">
        <Box flexDirection="row" width="100%">
          <Box backgroundColor={COLORS.text.userSymbol} flexShrink={0}>
            <Text backgroundColor={COLORS.text.userSymbol}> </Text>
          </Box>
          <Box
            paddingLeft={2}
            backgroundColor={COLORS.text.userBg}
            flexGrow={1}
          >
            <Text
              wrap="wrap"
              color={COLORS.text.userText}
              backgroundColor={COLORS.text.userBg}
            >
              {displayContent}{' '}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (message.messageType === MessageType.ApprovalComment) {
    return (
      <Box flexDirection="column" width="100%" paddingLeft={3}>
        <Box width={contentWidth - 3} flexWrap="wrap">
          <Text color={COLORS.primary}>
            {getI18n().t(APPROVAL_COMMENT_LABEL_KEY)}{' '}
          </Text>
          <Text color={COLORS.success} wrap="wrap">
            {displayContent}
          </Text>
        </Box>
      </Box>
    );
  }

  if (
    message.messageType === MessageType.SystemNotification &&
    message.id.endsWith(SPEC_APPROVAL_NOTIFICATION_ID_SUFFIX)
  ) {
    return (
      <Box flexDirection="column" width="100%">
        <Box width={contentWidth}>
          <Text color={COLORS.spec} wrap="wrap">
            {displayContent}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      {/* Main message content */}
      <Box flexDirection="row" width="100%">
        <Box marginRight={1.5}>
          <Text
            color={
              isAbortNotice
                ? COLORS.text.muted
                : isBashResultMessage
                  ? COLORS.text.primary
                  : message.role === MessageRole.User
                    ? COLORS.text.userText
                    : message.role === MessageRole.Assistant
                      ? COLORS.primary
                      : message.role === MessageRole.Tool
                        ? COLORS.text.primary
                        : message.role === MessageRole.System
                          ? COLORS.text.muted
                          : COLORS.error
            }
            bold
          >
            {isAbortNotice
              ? ' '
              : isBashResultMessage
                ? '●'
                : message.role === MessageRole.User
                  ? '>'
                  : message.role === MessageRole.Assistant
                    ? '🔱'
                    : message.role === MessageRole.Tool
                      ? '●'
                      : '●'}
          </Text>
        </Box>
        <Box width={contentWidth}>
          {/* Check if this is a bash result */}
          {isBashResult(displayContent) ? (
            <BashResultDisplay
              content={displayContent}
              maxWidth={contentWidth}
              isDetailedView={isDetailedView}
            />
          ) : message.messageType === MessageType.Markdown &&
            message.role === MessageRole.Assistant &&
            typeof displayContent === 'string' &&
            hasJsonRenderTags(displayContent) ? (
            <JsonRenderContent
              color={COLORS.markdown.heading}
              maxWidth={contentWidth}
            >
              {displayContent}
            </JsonRenderContent>
          ) : message.messageType === MessageType.Markdown ? (
            <MarkdownText
              maxWidth={contentWidth}
              color={
                message.role === MessageRole.Assistant
                  ? COLORS.markdown.heading
                  : message.role === MessageRole.Tool
                    ? COLORS.toolName
                    : bodyCopyColor
              }
            >
              {displayContent}
            </MarkdownText>
          ) : (
            <Text wrap="wrap" color={bodyCopyColor}>
              {systemWarningPrefix && typeof displayContent === 'string' ? (
                <>
                  <Text color={COLORS.warning}>{systemWarningPrefix}</Text>
                  {highlightSlashCommands(
                    displayContent.slice(systemWarningPrefix.length),
                    COLORS.toolName
                  )}
                </>
              ) : message.role === MessageRole.System &&
                typeof displayContent === 'string' ? (
                highlightSlashCommands(displayContent, COLORS.toolName)
              ) : (
                displayContent
              )}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
