import { Box, Static } from 'ink';
import React from 'react';

import { ToolResultDisplay } from '@industry/common/cli';

import { Header } from '@/components/Header';
import type { HistoryMessage } from '@/hooks/types';
import { getSettingsService } from '@/services/SettingsService';
import { getThemeEngine } from '@/theme/ThemeEngine';
import type { ToolExecution } from '@/types/types';
import { renderGroupedItem } from '@/utils/messageRenderers';
import {
  clearStaticRenderCache,
  getOrComputeStaticRenderCache,
} from '@/utils/staticRenderCache';
import {
  estimateStaticRenderItemsSize,
  getStaticRenderItemsFingerprint,
} from '@/utils/staticRenderCache/staticItemFingerprint';
import { StaticRenderCacheProvider } from '@/utils/staticRenderCacheContext';
import { groupConsecutiveReadTools } from '@/utils/toolGrouping';

interface StaticMessageListProps {
  messages: Array<HistoryMessage | ToolExecution>;
  contentWidth: number;
  headerWidth?: number;
  staticKey: number;
  isConversationEmpty?: boolean;
  showThinking?: boolean;
  permissionToolIds?: ReadonlySet<string>;
  pendingPermissionToolIds?: ReadonlySet<string>;
}

// Track whether the header has been shown in this session
let headerShownInSession = false;

// Export a function to reset the header state when starting a new session
export function resetHeaderShown() {
  headerShownInSession = false;
  clearStaticRenderCache();
}

export const StaticMessageList = React.memo(
  ({
    messages,
    contentWidth,
    headerWidth,
    staticKey,
    isConversationEmpty: _isConversationEmpty = false,
    showThinking,
    permissionToolIds,
    pendingPermissionToolIds,
  }: StaticMessageListProps) => {
    // Show the header once per session (or after resetHeaderShown is called,
    // e.g. theme change, /clear, /new). Not gated on isConversationEmpty so
    // the header re-renders with updated theme colors even when messages exist.
    let shouldShowHeader = false;
    if (!headerShownInSession) {
      headerShownInSession = true;
      shouldShowHeader = true;
    }

    const compact =
      getSettingsService().getToolResultDisplay() === ToolResultDisplay.Compact;
    const cacheScopeKey = [
      'static-message-list',
      `width=${contentWidth}`,
      `theme=${getThemeEngine().getActiveThemeName()}`,
      `compact=${compact ? 1 : 0}`,
      `showThinking=${showThinking ? 1 : 0}`,
    ].join('|');

    // Group consecutive Read tools so they stay collapsed when moving
    // from the dynamic region into the static scrollback.
    // This is safe because static items are all completed — the grouping is stable.
    const grouped = groupConsecutiveReadTools(messages);

    const staticItemsFingerprint = getStaticRenderItemsFingerprint(grouped);
    const permissionKey = [
      [...(permissionToolIds ?? [])].join(','),
      [...(pendingPermissionToolIds ?? [])].join(','),
    ].join('|');
    const staticItems = getOrComputeStaticRenderCache(
      [
        cacheScopeKey,
        `header=${shouldShowHeader ? 1 : 0}`,
        `headerWidth=${headerWidth ?? contentWidth + 6}`,
        `permissions=${permissionKey}`,
        staticItemsFingerprint,
      ].join('|'),
      estimateStaticRenderItemsSize(grouped),
      () => [
        // Ink's <Static> only renders new items when items.length changes
        // (useLayoutEffect depends solely on [items.length]). The header is
        // shown once and then excluded on subsequent renders. If the first
        // user message arrives in the next render, staticItems goes from
        // [header] (length 1) to [userMsg] (length 1) — same length, so Ink
        // silently skips the user message. Always include a header-slot
        // element so the length monotonically increases with new content.
        shouldShowHeader ? (
          <Box flexDirection="column" key="static-header">
            <Header width={headerWidth ?? contentWidth + 6} />
          </Box>
        ) : (
          <Box key="static-header-placeholder" flexDirection="column" />
        ),
        ...grouped
          .map((item) =>
            renderGroupedItem(item, contentWidth, {
              showThinking,
              compact,
              permissionToolIds,
              pendingPermissionToolIds,
              renderRegion: 'static',
            })
          )
          .filter(Boolean),
      ]
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

StaticMessageList.displayName = 'StaticMessageList';
