import { Box, Text } from 'ink';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { MC_COLORS } from '@/components/mission-control/constants';
import { convertHistoryMessagesToUIItems } from '@/components/mission-control/utils/sessionStoreTranscript';
import {
  CompactMessageEntry,
  CompactToolEntry,
} from '@/components/mission-control/views/CompactTranscriptEntries';
import { useSessionMessages } from '@/hooks/useSessionMessages';
import { ensureSessionLoadedForPreview } from '@/services/daemon/ensureSessionLoadedForPreview';

const MAX_PREVIEW_ITEMS = 12;
const PREVIEW_LINES_PER_ENTRY = 2;

interface ActiveWorkerPreviewProps {
  sessionId: string;
  workingDirectory: string;
  maxWidth: number;
  maxItems?: number;
  isLive?: boolean;
}

export function ActiveWorkerPreview({
  sessionId,
  workingDirectory: _workingDirectory,
  maxWidth,
  maxItems,
  isLive: _isLive = true,
}: ActiveWorkerPreviewProps) {
  const { t } = useTranslation('common');

  useEffect(() => {
    ensureSessionLoadedForPreview(sessionId, 'ActiveWorkerPreview');
  }, [sessionId]);

  const messages = useSessionMessages(sessionId);

  const contentWidth = Math.max(40, maxWidth - 3);
  const effectiveMaxItems = maxItems ?? MAX_PREVIEW_ITEMS;

  const uiItems = useMemo(
    () => convertHistoryMessagesToUIItems(messages).slice(-effectiveMaxItems),
    [effectiveMaxItems, messages]
  );

  return (
    <Box flexDirection="column">
      {uiItems.length === 0 ? (
        <Text color={MC_COLORS.tertiary}>
          {t('common:missionControl.noWorkerActivity')}
        </Text>
      ) : (
        uiItems.map((item) =>
          item.kind === 'message' ? (
            <CompactMessageEntry
              key={item.data.id}
              message={item.data}
              contentWidth={contentWidth}
              linesPerEntry={PREVIEW_LINES_PER_ENTRY}
            />
          ) : (
            <CompactToolEntry
              key={item.data.id}
              tool={item.data}
              contentWidth={contentWidth}
              linesPerEntry={PREVIEW_LINES_PER_ENTRY}
            />
          )
        )
      )}
    </Box>
  );
}
