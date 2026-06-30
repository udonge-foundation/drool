import { Box, Text } from 'ink';
import { useMemo } from 'react';

import { COLORS } from '@/components/chat/themedColors';
import {
  getHookContextLabel,
  getHookHeaderWidth,
  HookCommandLine,
} from '@/components/HookCommandLine';
import { CompactGitAiCheckpointHookDisplay } from '@/components/HookDisplay';
import { shouldCollapseHookInTranscript } from '@/components/hookDisplayUtils';
import {
  HOOK_HEADER_NAME,
  HOOK_LEFT_MARGIN,
} from '@/components/hooks/constants';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { HookEventName, HookExecutionStatus } from '@/hooks/enums';
import { getI18n } from '@/i18n';

interface HookExecutionInfo {
  id: string;
  command: string;
  timeout?: number;
  status: HookExecutionStatus;
  result?: {
    exitCode: number;
    stdout: string;
    stderr: string;
    suppressOutput?: boolean;
  };
  startTime?: number;
  endTime?: number;
}

interface ParallelHooksDisplayProps {
  hookEventName: HookEventName;
  hookMatcher?: string;
  hooks: HookExecutionInfo[];
  contentWidth?: number;
  /**
   * When true the hooks are being rendered in the Ctrl+O detailed transcript.
   * Git AI checkpoint hooks are collapsed to a single header line here instead
   * of their full output (they are hidden entirely from the live chat view).
   */
  isDetailedView?: boolean;
}

function getOverallStatus(hooks: HookExecutionInfo[]): HookExecutionStatus {
  if (hooks.some((h) => h.status === HookExecutionStatus.Error)) {
    return HookExecutionStatus.Error;
  }
  if (hooks.some((h) => h.status === HookExecutionStatus.Executing)) {
    return HookExecutionStatus.Executing;
  }
  if (hooks.every((h) => h.status === HookExecutionStatus.Completed)) {
    return HookExecutionStatus.Completed;
  }
  return HookExecutionStatus.Executing;
}

export function ParallelHooksDisplay({
  hookEventName,
  hookMatcher,
  hooks,
  contentWidth,
  isDetailedView = false,
}: ParallelHooksDisplayProps) {
  const overallStatus = useMemo(() => getOverallStatus(hooks), [hooks]);

  const statusColor = useMemo(() => {
    switch (overallStatus) {
      case HookExecutionStatus.Executing:
        return COLORS.warning;
      case HookExecutionStatus.Completed:
        return COLORS.success;
      case HookExecutionStatus.Error:
        return COLORS.error;
      default:
        return COLORS.text.muted;
    }
  }, [overallStatus]);

  const executingCount = useMemo(
    () =>
      hooks.filter((h) => h.status === HookExecutionStatus.Executing).length,
    [hooks]
  );

  const completedCount = useMemo(
    () =>
      hooks.filter((h) => h.status === HookExecutionStatus.Completed).length,
    [hooks]
  );

  const failedCount = useMemo(
    () => hooks.filter((h) => h.status === HookExecutionStatus.Error).length,
    [hooks]
  );

  const statusSuffix = useMemo(() => {
    const t = getI18n().t;
    if (overallStatus === HookExecutionStatus.Executing) {
      const completedPart =
        completedCount > 0
          ? `, ${t('common:parallelHooks.completedCount', { count: completedCount })}`
          : '';
      return ` [${t('common:parallelHooks.executingCount', { count: executingCount })}${completedPart}]`;
    }
    if (overallStatus === HookExecutionStatus.Completed) {
      return ` [${t('common:parallelHooks.completedCount', { count: hooks.length })}]`;
    }
    if (overallStatus === HookExecutionStatus.Error) {
      return ` [${t('common:parallelHooks.failedCount', { count: failedCount })}]`;
    }
    return '';
  }, [
    overallStatus,
    executingCount,
    completedCount,
    hooks.length,
    failedCount,
  ]);

  const headerWidth = getHookHeaderWidth(contentWidth);

  if (isDetailedView && shouldCollapseHookInTranscript(hooks)) {
    return (
      <CompactGitAiCheckpointHookDisplay
        executingCount={executingCount}
        completedCount={completedCount}
        failedCount={failedCount}
        contentWidth={contentWidth}
      />
    );
  }

  return (
    <Box flexDirection="row" marginLeft={HOOK_LEFT_MARGIN}>
      <Box flexGrow={1} flexDirection="column">
        <ToolHeader
          toolName={HOOK_HEADER_NAME}
          headerParts={[
            { text: getHookContextLabel(hookEventName, hookMatcher) },
            ...(statusSuffix
              ? [
                  {
                    text: statusSuffix,
                    color: statusColor,
                    rightAligned: true,
                  },
                ]
              : []),
          ]}
          isPending={overallStatus === HookExecutionStatus.Executing}
          contentWidth={headerWidth}
          nameColor={COLORS.hookBadgeBg}
          pendingBaseColor={COLORS.hookBadgeBg}
        />

        {/* Hooks List */}
        <Box flexDirection="column" marginLeft={1} marginTop={0}>
          {hooks.map((hook, index) => {
            const isLast = index === hooks.length - 1;
            const prefix = isLast ? '└─' : '├─';

            return (
              <Box key={hook.id} flexDirection="column">
                <HookCommandLine
                  command={hook.command}
                  prefix={prefix}
                  contentWidth={contentWidth}
                />

                {/* Result line */}
                {hook.result && (
                  <Box flexDirection="column" marginLeft={isLast ? 2 : 1}>
                    <Box flexDirection="row">
                      <Text dimColor>
                        {isLast ? ' ' : '│'} └─{' '}
                        {getI18n().t('common:parallelHooks.resultLabel')}{' '}
                      </Text>
                      <Text
                        color={
                          hook.result.exitCode === 0
                            ? COLORS.success
                            : COLORS.error
                        }
                      >
                        {getI18n().t('common:parallelHooks.exitCode', {
                          code: hook.result.exitCode,
                        })}
                      </Text>
                    </Box>
                    {hook.result.stdout &&
                      hook.result.stdout.trim().length > 0 && (
                        <Box flexDirection="column" marginLeft={2}>
                          <Text dimColor>
                            {isLast ? ' ' : '│'}{' '}
                            {getI18n().t('common:hookDisplay.stdoutLabel')}
                          </Text>
                          <Text>{hook.result.stdout.trim()}</Text>
                        </Box>
                      )}
                    {hook.result.stderr &&
                      hook.result.stderr.trim().length > 0 && (
                        <Box flexDirection="column" marginLeft={2}>
                          <Text dimColor>
                            {isLast ? ' ' : '│'}{' '}
                            {getI18n().t('common:hookDisplay.stderrLabel')}
                          </Text>
                          <Text color={COLORS.error}>
                            {hook.result.stderr.trim()}
                          </Text>
                        </Box>
                      )}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
