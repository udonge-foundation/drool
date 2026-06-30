import { Box, Text } from 'ink';
import React from 'react';

import { COLORS } from '@/components/chat/themedColors';
import { DynamicMessageList } from '@/components/DynamicMessageList';
import type { HistoryMessage } from '@/hooks/types';
import { getI18n } from '@/i18n';
import type { ToolExecution } from '@/types/types';
import { TranscriptAnchorMode } from '@/utils/transcriptTurnNavigation/enums';
import { sliceAroundAnchor } from '@/utils/transcriptTurnNavigation/transcriptTurnNavigation';

interface AnchoredTranscriptPanelProps {
  messages: Array<HistoryMessage | ToolExecution>;
  contentWidth: number;
  /** Index into `messages` to anchor the slice at (its end). */
  anchorIndex: number;
  /** Total anchor count, 1-based position within that list. */
  totalAnchors: number;
  currentAnchorPosition: number;
  /** Navigation mode: any turn vs user turns only. */
  mode: TranscriptAnchorMode;
  /** Maximum number of messages to include in the slice. */
  maxItems?: number;
  showThinking?: boolean;
}

/**
 * Renders a bounded slice of the transcript ending at the anchored turn. This
 * is used when chat-view transcript scroll mode is active (Alt+Up/Down or
 * Alt+PgUp/PgDn) so the selected turn stays visible next to the input area
 * while the user navigates history. The inner rendering is delegated to
 * `DynamicMessageList` so messages look identical to live chat output.
 */
export const AnchoredTranscriptPanel = React.memo(
  ({
    messages,
    contentWidth,
    anchorIndex,
    totalAnchors,
    currentAnchorPosition,
    mode,
    maxItems,
    showThinking,
  }: AnchoredTranscriptPanelProps) => {
    const { items: slicedItems, startIndex } = sliceAroundAnchor(
      messages,
      anchorIndex,
      maxItems
    );

    const t = getI18n().t.bind(getI18n());
    const safeTotal = Math.max(0, totalAnchors);
    const safePosition = Math.max(0, currentAnchorPosition);
    const olderRemaining = Math.max(0, startIndex);

    const modeLabel =
      mode === TranscriptAnchorMode.UserOnly
        ? t('common:transcriptScroll.modeUser')
        : t('common:transcriptScroll.modeAny');

    return (
      <Box flexDirection="column" width="100%">
        <Box width="100%" paddingX={1} marginBottom={1}>
          <Text color={COLORS.text.muted}>
            {t('common:transcriptScroll.header', {
              mode: modeLabel,
              position: safePosition,
              total: safeTotal,
              older: olderRemaining,
            })}
          </Text>
        </Box>
        <DynamicMessageList
          messages={slicedItems}
          contentWidth={contentWidth}
          showThinking={showThinking}
        />
        <Box width="100%" paddingX={1} marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:transcriptScroll.hint')}
          </Text>
        </Box>
      </Box>
    );
  }
);

AnchoredTranscriptPanel.displayName = 'AnchoredTranscriptPanel';
