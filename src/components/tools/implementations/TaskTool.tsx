import { Box, Text } from 'ink';
import { useMemo, type ReactNode } from 'react';

import { useSessionDisplayMessages } from '@industry/daemon-client/messages';
import {
  buildSessionToolProgressUpdates,
  buildTaskToolProgressEntries,
  formatToolProgressDetails,
} from '@industry/utils/session';

import { COLORS } from '@/components/chat/themedColors';
import {
  getSubagentBadge,
  getSubagentPlaceholderBadge,
} from '@/components/tools/implementations/subagentBadge';
import {
  ToolComponent,
  ToolComponentProps,
  ToolHeaderBadge,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getSessionService } from '@/services/SessionService';
import { getTaskInvocation } from '@/utils/taskInvocationStore';
import { getTextContent } from '@/utils/tool-result-helpers';

import type { ToolStreamingUpdate } from '@industry/drool-sdk-ext/protocol/drool';

const MAX_DETAILED_VIEW_LINES = 200;
const MAX_DETAILED_VIEW_UPDATES = 20;

type TimelineItem = {
  key: string;
  node: ReactNode;
};

type ResolveTaskChildSessionIdParams = Pick<
  ToolComponentProps,
  'input' | 'progressUpdates' | 'result' | 'toolUseId'
> & {
  isSubAgentsV2Enabled: boolean;
};

function getSessionIdFromTaskResult(result: ToolComponentProps['result']) {
  const match = getTextContent(result).match(/^session_id:\s*(\S+)/m);
  return match?.[1];
}

function getSessionIdFromProgress(
  progressUpdates: ToolStreamingUpdate[] | undefined
) {
  for (let index = (progressUpdates?.length ?? 0) - 1; index >= 0; index--) {
    const sessionId = progressUpdates?.[index]?.subagentSessionId;
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

function resolveTaskChildSessionId({
  isSubAgentsV2Enabled,
  input,
  progressUpdates,
  result,
  toolUseId,
}: ResolveTaskChildSessionIdParams) {
  if (!isSubAgentsV2Enabled) return undefined;

  const progressSessionId = getSessionIdFromProgress(progressUpdates);
  if (progressSessionId) return progressSessionId;

  const resultSessionId = getSessionIdFromTaskResult(result);
  if (resultSessionId) return resultSessionId;

  if (typeof input.resume === 'string' && input.resume.trim()) {
    return input.resume.trim();
  }

  if (!toolUseId) return undefined;

  const parentSessionId = getSessionService().getCurrentSessionId();
  if (!parentSessionId) return undefined;

  return getTaskInvocation({
    parentSessionId,
    parentToolUseId: toolUseId,
  })?.childSessionId;
}

function useTaskSessionProgress({
  input,
  progressUpdates,
  result,
  toolUseId,
}: Pick<
  ToolComponentProps,
  'input' | 'progressUpdates' | 'result' | 'toolUseId'
>): ToolStreamingUpdate[] {
  const isSubAgentsV2Enabled = getExecRuntimeConfig().isSubAgentsV2Enabled();
  const childSessionId = useMemo(
    () =>
      resolveTaskChildSessionId({
        isSubAgentsV2Enabled,
        input,
        progressUpdates,
        result,
        toolUseId,
      }),
    [input, isSubAgentsV2Enabled, progressUpdates, result, toolUseId]
  );
  const ssm = useMemo(
    () =>
      childSessionId ? getTuiDaemonAdapter().getSessionStateManager() : null,
    [childSessionId]
  );
  const messages = useSessionDisplayMessages({
    ssm,
    sessionId: childSessionId ?? null,
    isChunkLevel: false,
  });
  const sessionUpdates = useMemo(
    () =>
      buildSessionToolProgressUpdates(messages, {
        maxUpdates: MAX_DETAILED_VIEW_UPDATES,
      }).map((update) => ({
        ...update,
        subagentSessionId: update.subagentSessionId ?? childSessionId,
      })),
    [childSessionId, messages]
  );

  return isSubAgentsV2Enabled && sessionUpdates.length > 0
    ? sessionUpdates
    : (progressUpdates ?? []);
}

function renderTaskCompactResult({
  input,
  result,
  isError,
  progressUpdates,
}: ToolComponentProps) {
  const updates: ToolStreamingUpdate[] = progressUpdates ?? [];
  const progressEntries = buildTaskToolProgressEntries(updates);
  const hasFinalResult = result !== undefined;
  const isBackground = input.run_in_background === true;

  const completedToolUses = progressEntries.filter(
    (entry) => entry.status === 'complete'
  ).length;
  const toolCount =
    completedToolUses > 0 ? completedToolUses : progressEntries.length;
  const timestamps = updates
    .map((u) => u.timestamp)
    .filter(Boolean) as number[];
  const duration =
    timestamps.length >= 2
      ? timestamps[timestamps.length - 1]! - timestamps[0]!
      : undefined;
  const durationStr =
    duration && duration > 0 ? ` · ${(duration / 1000).toFixed(1)}s` : '';

  if (hasFinalResult) {
    if (isError) {
      return (
        <Text color={COLORS.error}>
          {getI18n().t('common:toolDisplay.task.taskFailed')}
        </Text>
      );
    }
    if (isBackground) {
      return (
        <Text color={COLORS.text.muted}>
          {getI18n().t('common:toolDisplay.task.runningInBackground')}
        </Text>
      );
    }
    return (
      <Text color={COLORS.text.muted}>
        {getI18n().t('common:toolDisplay.task.done')} ({toolCount}{' '}
        {getI18n().t('common:toolDisplay.task.toolUse', {
          count: toolCount,
        })}
        {durationStr})
      </Text>
    );
  }

  const lastUpdate = updates[updates.length - 1];
  let label: string;
  if (!lastUpdate) {
    label = getI18n().t('common:toolDisplay.task.initializingDetail');
  } else if (lastUpdate.type === 'tool_call' && lastUpdate.toolName) {
    const detailText = formatToolProgressDetails(lastUpdate.details);
    label = detailText
      ? `${lastUpdate.toolName} ${detailText}`
      : lastUpdate.toolName;
  } else {
    label =
      lastUpdate.toolName ||
      lastUpdate.text ||
      formatToolProgressDetails(lastUpdate.details) ||
      getI18n().t('common:toolDisplay.task.statusUpdate');
  }
  if (label.length > 80) {
    label = `${label.slice(0, 77)}...`;
  }

  return <Text color={COLORS.text.muted}>↳ {label}</Text>;
}

function TaskCompactResult(props: ToolComponentProps) {
  const updates = useTaskSessionProgress(props);
  return renderTaskCompactResult({ ...props, progressUpdates: updates });
}

// eslint-disable-next-line industry/constants-file-organization
export const TaskTool: ToolComponent = {
  getHeaderBadge(input: Record<string, unknown>): ToolHeaderBadge | undefined {
    const subagentType = input.subagent_type as string | undefined;
    if (!subagentType) {
      // Return a muted placeholder while input is still streaming
      // to avoid a flash from "TASK" → "EXPLORER"
      return getSubagentPlaceholderBadge();
    }

    return getSubagentBadge(subagentType);
  },

  getHeaderLabel(input: Record<string, unknown>): string {
    const description =
      typeof input.description === 'string' ? input.description : '';
    const complexity =
      typeof input.complexity === 'string' ? input.complexity : undefined;
    const resume = typeof input.resume === 'string' ? input.resume : undefined;

    const shortDescription =
      description?.length > 50
        ? `${description.substring(0, 47)}...`
        : description;

    const suffix = [resume ? 'resumed' : '', complexity]
      .filter(Boolean)
      .join(', ');

    const tag = suffix ? ` - ${suffix}` : '';

    const label = shortDescription ? `"${shortDescription}"${tag}` : tag || '';

    return label;
  },

  renderResult({
    toolUseId,
    input,
    result,
    isError,
    progressUpdates,
  }: ToolComponentProps) {
    return (
      <TaskCompactResult
        toolUseId={toolUseId}
        input={input}
        result={result}
        isError={isError}
        progressUpdates={progressUpdates}
      />
    );
  },

  renderDetailedView({
    input,
    result,
    isError,
    progressUpdates,
  }: ToolComponentProps) {
    const subagentType = input.subagent_type as string;
    const description = input.description as string;
    const prompt = input.prompt as string;
    const resultText = getTextContent(result);
    const hasFinalResult = result !== undefined;

    // Build timeline of recent updates for in-progress display
    const updates: ToolStreamingUpdate[] = progressUpdates ?? [];
    const progressTimeline: TimelineItem[] = [];
    updates.forEach((update, index) => {
      let item: TimelineItem | null = null;

      switch (update.type) {
        case 'status': {
          const label =
            update.details ||
            update.text ||
            getI18n().t('common:toolDisplay.task.statusUpdate');
          item = {
            key: `status-${index}`,
            node: <Text color={COLORS.text.muted}>↳ {label}</Text>,
          };
          break;
        }
        case 'tool_call': {
          const detailText = formatToolProgressDetails(update.details);
          const suffix = detailText ? ` (${detailText})` : '';
          const label = update.toolName
            ? `${update.toolName}${suffix}`
            : update.details;
          item = {
            key: `call-${index}`,
            node: (
              <Text color={COLORS.text.muted}>
                ↳ {label ?? getI18n().t('common:toolDisplay.task.toolCall')}
              </Text>
            ),
          };
          break;
        }
        case 'tool_result': {
          const succeeded = update.status !== 'error';
          const icon = succeeded ? '↳' : '⚠';
          const color = succeeded ? COLORS.text.muted : COLORS.error;
          const detail =
            formatToolProgressDetails(update.details) || update.valueSnippet;
          const label = update.toolName
            ? `${update.toolName}`
            : getI18n().t('common:toolDisplay.task.toolResult');
          const text = detail ? `${label} · ${detail}` : label;
          item = {
            key: `result-${index}`,
            node: <Text color={color}>{`${icon} ${text}`}</Text>,
          };
          break;
        }
        case 'message': {
          if (update.text) {
            item = {
              key: `message-${index}`,
              node: <Text color={COLORS.text.muted}>↳ {update.text}</Text>,
            };
          }
          break;
        }
        case 'error': {
          if (update.error) {
            item = {
              key: `error-${index}`,
              node: <Text color={COLORS.error}>⚠ {update.error}</Text>,
            };
          }
          break;
        }
        default:
          break;
      }

      if (item) {
        progressTimeline.push(item);
      }
    });

    // Show only the last N updates
    const totalUpdates = progressTimeline.length;
    const isTruncatedUpdates = totalUpdates > MAX_DETAILED_VIEW_UPDATES;
    const displayTimeline = isTruncatedUpdates
      ? progressTimeline.slice(-MAX_DETAILED_VIEW_UPDATES)
      : progressTimeline;

    return (
      <Box flexDirection="column">
        {/* Input section */}
        <Box flexDirection="column" marginBottom={1}>
          <Text color={COLORS.text.muted} bold>
            {getI18n().t('common:toolDisplay.task.inputLabel')}
          </Text>
          {subagentType && (
            <Box marginLeft={2}>
              <Text color={COLORS.text.muted}>
                <Text bold>
                  {getI18n().t('common:toolDisplay.task.subagentTypeLabel')}
                </Text>{' '}
                {subagentType}
              </Text>
            </Box>
          )}
          {description && (
            <Box marginLeft={2}>
              <Text color={COLORS.text.muted}>
                <Text bold>
                  {getI18n().t('common:toolDisplay.task.descriptionLabel')}
                </Text>{' '}
                {description}
              </Text>
            </Box>
          )}
          {prompt && (
            <Box flexDirection="column" marginLeft={2}>
              <Text color={COLORS.text.muted} bold>
                {getI18n().t('common:toolDisplay.task.promptLabel')}
              </Text>
              <Box marginLeft={2}>
                <Text color={COLORS.text.secondary}>{prompt}</Text>
              </Box>
            </Box>
          )}
        </Box>

        {/* Output section */}
        <Box flexDirection="column">
          <Text color={COLORS.text.muted} bold>
            {getI18n().t('common:toolDisplay.task.outputLabel')}
          </Text>
          <Box marginLeft={2} flexDirection="column">
            {!hasFinalResult ? (
              // Show last N tool calls/results when task is in progress
              displayTimeline.length > 0 ? (
                <Box flexDirection="column">
                  {isTruncatedUpdates && (
                    <Text color={COLORS.text.muted} dimColor>
                      {getI18n().t('common:toolDisplay.task.earlierUpdates', {
                        count: totalUpdates - MAX_DETAILED_VIEW_UPDATES,
                      })}
                    </Text>
                  )}
                  {displayTimeline.map((item) => (
                    <Box key={item.key}>{item.node}</Box>
                  ))}
                </Box>
              ) : (
                <Text color={COLORS.text.muted} dimColor>
                  {getI18n().t('common:toolDisplay.task.initializingDetail')}
                </Text>
              )
            ) : isError ? (
              <Text color={COLORS.error}>{resultText}</Text>
            ) : (
              <>
                {(() => {
                  const lines = resultText.split('\n');
                  const totalLines = lines.length;
                  const isTruncated = totalLines > MAX_DETAILED_VIEW_LINES;
                  const displayText = isTruncated
                    ? lines.slice(-MAX_DETAILED_VIEW_LINES).join('\n')
                    : resultText;

                  return (
                    <>
                      <Text color={COLORS.text.primary}>{displayText}</Text>
                      {isTruncated && (
                        <Box marginTop={1}>
                          <Text color={COLORS.text.muted}>
                            {getI18n().t('common:toolDisplay.showingLast', {
                              shown: MAX_DETAILED_VIEW_LINES,
                              total: totalLines,
                            })}
                          </Text>
                        </Box>
                      )}
                    </>
                  );
                })()}
              </>
            )}
          </Box>
        </Box>
      </Box>
    );
  },

  getSummaryLine(
    input: Record<string, unknown>,
    result: string,
    isError: boolean
  ): string {
    const description = input.description as string;
    const subagentType = input.subagent_type as string;

    if (isError) {
      return `${getI18n().t('common:toolDisplay.task.summaryFailed')}${subagentType ? ` (${subagentType})` : ''}`;
    }

    if (result === undefined) {
      return `${getI18n().t('common:toolDisplay.task.summaryRunning')}${subagentType ? ` (${subagentType})` : ''}...`;
    }

    const summaryMatch = result.match(/Summary:\s*(.*)/);
    if (summaryMatch && summaryMatch[1]) {
      return summaryMatch[1].trim();
    }

    return (
      description ?? getI18n().t('common:toolDisplay.task.summaryCompleted')
    );
  },
};
