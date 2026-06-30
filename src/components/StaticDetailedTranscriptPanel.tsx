import { Box, Static } from 'ink';
import React from 'react';

import { Header } from '@/components/Header';
import { MessageItem } from '@/components/MessageItem';
import { UnifiedToolDisplay } from '@/components/UnifiedToolDisplay';
import type { HistoryMessage } from '@/hooks/types';
import { getThemeEngine } from '@/theme/ThemeEngine';
import type { ToolExecution } from '@/types/types';
import { getOrComputeStaticRenderCache } from '@/utils/staticRenderCache';
import {
  estimateStaticRenderItemsSize,
  getStaticRenderItemsFingerprint,
} from '@/utils/staticRenderCache/staticItemFingerprint';
import { StaticRenderCacheProvider } from '@/utils/staticRenderCacheContext';

interface StaticDetailedTranscriptPanelProps {
  messages: Array<HistoryMessage | ToolExecution>;
  contentWidth: number;
  isConversationEmpty?: boolean;
  staticKey: number;
}

export const StaticDetailedTranscriptPanel = React.memo(
  ({
    messages,
    contentWidth,
    isConversationEmpty = false,
    staticKey,
  }: StaticDetailedTranscriptPanelProps) => {
    const cacheScopeKey = [
      'static-detailed-transcript',
      `width=${contentWidth}`,
      `theme=${getThemeEngine().getActiveThemeName()}`,
      `showThinking=1`,
    ].join('|');
    const staticItems = getOrComputeStaticRenderCache(
      [
        cacheScopeKey,
        `empty=${isConversationEmpty ? 1 : 0}`,
        getStaticRenderItemsFingerprint(messages),
      ].join('|'),
      estimateStaticRenderItemsSize(messages),
      () => {
        // Build the static items once per render; Ink <Static> will append new ones when the array grows
        // This shows a snapshot of all messages at the time Ctrl+O was pressed
        const items: React.ReactElement[] = [];

        if (isConversationEmpty && messages.length === 0) {
          items.push(
            <Box flexDirection="column" key="static-detailed-header">
              <Header width={contentWidth + 6} />
            </Box>
          );
        }

        messages.forEach((item, index) => {
          const itemKey = item.id
            ? `detailed-static-${item.id}`
            : `detailed-static-${index}`;

          if ('toolName' in item && 'status' in item) {
            const toolExec = item as ToolExecution;
            items.push(
              <Box key={itemKey} width="100%" marginBottom={1}>
                <UnifiedToolDisplay
                  toolUseId={toolExec.id}
                  toolName={toolExec.toolName}
                  toolInput={toolExec.toolInput}
                  status={toolExec.status}
                  result={toolExec.detailedContent || toolExec.result}
                  isError={toolExec.isError}
                  _startTime={toolExec.startTime}
                  _endTime={toolExec.endTime}
                  contentWidth={contentWidth}
                  progressUpdates={toolExec.progressUpdates}
                  isDetailedView
                />
              </Box>
            );
            return;
          }

          const message = item as HistoryMessage;
          items.push(
            <Box key={itemKey} marginBottom={1}>
              <MessageItem
                message={message}
                contentWidth={contentWidth}
                isDetailedView
                showThinking
              />
            </Box>
          );
        });

        return items;
      }
    );

    return (
      <StaticRenderCacheProvider scopeKey={cacheScopeKey}>
        <Static key={staticKey} items={staticItems}>
          {(item) => item}
        </Static>
      </StaticRenderCacheProvider>
    );
  }
);

StaticDetailedTranscriptPanel.displayName = 'StaticDetailedTranscriptPanel';
