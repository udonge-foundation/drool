import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { UnifiedToolDisplay } from '@/components/UnifiedToolDisplay';
import type { ToolExecution } from '@/types/types';

interface ToolExecutionItemProps {
  toolExecution: ToolExecution;
  contentWidth?: number;
  isAwaitingPermission?: boolean;
  hideHeader?: boolean;
  renderRegion?: 'static' | 'dynamic';
}

export function ToolExecutionItem({
  toolExecution,
  contentWidth,
  isAwaitingPermission = false,
  hideHeader = false,
  renderRegion,
}: ToolExecutionItemProps) {
  const { t } = useTranslation('common');

  if (toolExecution.toolName === 'TodoWrite') {
    if (toolExecution.isError) {
      return null;
    }
    return (
      <Box marginLeft={3}>
        <Text color={COLORS.text.muted} dimColor>
          {t('toolDisplay.todoWrite.subtleUpdated')}
        </Text>
      </Box>
    );
  }

  const display = (
    <UnifiedToolDisplay
      toolUseId={toolExecution.id}
      toolName={toolExecution.toolName}
      toolInput={toolExecution.toolInput}
      status={toolExecution.status}
      result={toolExecution.result}
      isError={toolExecution.isError}
      _startTime={toolExecution.startTime}
      _endTime={toolExecution.endTime}
      progressUpdates={toolExecution.progressUpdates}
      contentWidth={contentWidth}
      isAwaitingPermission={isAwaitingPermission}
      hideHeader={hideHeader}
      renderRegion={renderRegion}
    />
  );

  // Clamp Task (Worker) tool to exactly 2 lines (header + status) to prevent jitter
  if (toolExecution.toolName === 'Task') {
    return (
      <Box height={2} overflow="hidden">
        {display}
      </Box>
    );
  }

  return display;
}
