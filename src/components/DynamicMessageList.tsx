import { ToolResultDisplay } from '@industry/common/cli';

import type { HistoryMessage } from '@/hooks/types';
import { getSettingsService } from '@/services/SettingsService';
import type { ToolExecution } from '@/types/types';
import { renderGroupedItem } from '@/utils/messageRenderers';
import { groupConsecutiveReadTools } from '@/utils/toolGrouping';

interface DynamicMessageListProps {
  messages: Array<HistoryMessage | ToolExecution>;
  contentWidth: number;
  showThinking?: boolean;
  permissionToolIds?: ReadonlySet<string>;
  pendingPermissionToolIds?: ReadonlySet<string>;
}

export function DynamicMessageList({
  messages,
  contentWidth,
  showThinking,
  permissionToolIds,
  pendingPermissionToolIds,
}: DynamicMessageListProps) {
  const compact =
    getSettingsService().getToolResultDisplay() === ToolResultDisplay.Compact;
  const grouped = groupConsecutiveReadTools(messages, compact);
  return (
    <>
      {grouped.map((item) =>
        renderGroupedItem(item, contentWidth, {
          showThinking,
          compact,
          permissionToolIds,
          pendingPermissionToolIds,
          renderRegion: 'dynamic',
        })
      )}
    </>
  );
}
