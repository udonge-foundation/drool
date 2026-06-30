import { scrubSecrets } from '@industry/utils';

import { getCompactToolParams } from '@/components/mission-control/utils/compactToolParams';
import type { StartMissionRunWorkerActivity } from '@/components/tools/implementations/types';
import { MessageRole, MessageType } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';
import { getDisplayNameForTool } from '@/utils/tool-display';

const DEFAULT_RECENT_ACTIVITY_LIMIT = 4;
const SUMMARY_PREVIEW_LENGTH = 200;
const RECENT_ACTIVITY_HIDDEN_TOOL_NAMES = new Set(['TaskOutput']);

interface WorkerActivityEntry {
  summary: string;
}

interface WorkerActivitySnapshot {
  toolCount: number;
  recentActivity: WorkerActivityEntry[];
}

export function buildWorkerActivitySnapshot(params: {
  messages: HistoryMessage[];
  recentActivityLimit?: number;
}): WorkerActivitySnapshot {
  const seenToolCallIds = new Set<string>();
  const activity: WorkerActivityEntry[] = [];
  const sanitizeActivityText = (text: string): string =>
    scrubSecrets(sanitizeTerminalDisplayText(text, { stripSgr: true })).replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi,
      '$1=***'
    );
  const truncateText = (text: string): string => {
    if (text.length <= SUMMARY_PREVIEW_LENGTH) {
      return text;
    }
    return `${text.slice(0, SUMMARY_PREVIEW_LENGTH)}...`;
  };
  const firstLine = (text: string): string =>
    sanitizeActivityText(text).split('\n')[0]?.trim() ?? '';
  const pushActivity = (entry: WorkerActivityEntry): void => {
    if (activity.at(-1)?.summary === entry.summary) {
      return;
    }
    activity.push(entry);
  };
  const getProgressUpdateSummary = (
    update: NonNullable<HistoryMessage['progressUpdates']>[number]
  ): string => {
    if (update.type === 'tool_call' && update.toolName) {
      const compactParams = update.parameters
        ? getCompactToolParams(update.toolName, update.parameters)
        : '';
      const toolLabel = getDisplayNameForTool(update.toolName);
      return compactParams ? `${toolLabel}: ${compactParams}` : toolLabel;
    }

    return (
      update.text ??
      update.details ??
      update.valueSnippet ??
      update.error ??
      update.status ??
      ''
    );
  };
  const getToolCallBaseSummary = (message: HistoryMessage): string => {
    const toolName = message.toolName ?? '';
    const compactParams = message.toolInput
      ? getCompactToolParams(toolName, message.toolInput)
      : '';
    const sanitizedParams = truncateText(sanitizeActivityText(compactParams));
    return sanitizedParams
      ? `${getDisplayNameForTool(toolName)}: ${sanitizedParams}`
      : getDisplayNameForTool(toolName);
  };

  for (const message of params.messages) {
    if (
      message.messageType === MessageType.ToolCall &&
      message.toolCallId &&
      !seenToolCallIds.has(message.toolCallId)
    ) {
      seenToolCallIds.add(message.toolCallId);
      const toolName = message.toolName ?? '';
      if (RECENT_ACTIVITY_HIDDEN_TOOL_NAMES.has(toolName)) {
        continue;
      }

      const progressUpdates = message.progressUpdates ?? [];
      if (progressUpdates.length > 0) {
        const parentToolLabel = getDisplayNameForTool(toolName);
        const activityCountBeforeProgress = activity.length;
        for (const update of progressUpdates) {
          const progressSummary = firstLine(getProgressUpdateSummary(update));
          if (!progressSummary) {
            continue;
          }
          pushActivity({
            summary: `${parentToolLabel}: ${truncateText(progressSummary)}`,
          });
        }
        if (activity.length === activityCountBeforeProgress) {
          pushActivity({
            summary: getToolCallBaseSummary(message),
          });
        }
        continue;
      }

      pushActivity({
        summary: getToolCallBaseSummary(message),
      });
      continue;
    }

    if (message.messageType === MessageType.Thinking) {
      const text = firstLine(message.content);
      if (text) {
        pushActivity({
          summary: `Thinking: "${truncateText(text)}"`,
        });
      }
      continue;
    }

    if (
      message.role === MessageRole.Assistant &&
      message.messageType === MessageType.Markdown
    ) {
      const text = firstLine(message.content);
      if (text) {
        pushActivity({
          summary: `Assistant: ${truncateText(text)}`,
        });
      }
    }
  }

  const limit = params.recentActivityLimit ?? DEFAULT_RECENT_ACTIVITY_LIMIT;

  return {
    toolCount: seenToolCallIds.size,
    recentActivity: limit > 0 ? activity.slice(-limit) : [],
  };
}

export function buildStartMissionRunWorkerActivity(params: {
  workerSessionId: string | null;
  workerMessages: HistoryMessage[];
}): StartMissionRunWorkerActivity | null {
  const { workerSessionId } = params;
  if (!workerSessionId) {
    return null;
  }

  const liveActivity = buildWorkerActivitySnapshot({
    messages: params.workerMessages,
  });

  return {
    toolCount: liveActivity.toolCount,
    recentActivity: liveActivity.recentActivity,
  };
}
