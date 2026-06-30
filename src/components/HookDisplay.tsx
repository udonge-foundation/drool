import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import {
  getHookContextLabel,
  getHookHeaderWidth,
  HookCommandLine,
} from '@/components/HookCommandLine';
import {
  getGitAiCheckpointHookLabel,
  shouldCollapseHookInTranscript,
} from '@/components/hookDisplayUtils';
import {
  HOOK_HEADER_NAME,
  HOOK_LEFT_MARGIN,
} from '@/components/hooks/constants';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { HookEventName, HookExecutionStatus } from '@/hooks/enums';

interface HookDisplayProps {
  hookEventName: HookEventName;
  hookMatcher?: string;
  hookCommands: Array<{ command: string; timeout?: number }>;
  hookStatus?: HookExecutionStatus;
  hookResults?: Array<{
    exitCode: number;
    stdout: string;
    stderr: string;
    suppressOutput?: boolean;
  }>;
  contentWidth?: number;
  /**
   * When true the hook is being rendered in the Ctrl+O detailed transcript. The
   * Git AI checkpoint hook is collapsed to a single header line here instead of
   * its full output (it is hidden entirely from the live chat view).
   */
  isDetailedView?: boolean;
}

type HookCommand = HookDisplayProps['hookCommands'][number];
type HookResult = NonNullable<HookDisplayProps['hookResults']>[number];

interface HookDisplayItem {
  command: HookCommand;
  result?: HookResult;
}

export function CompactGitAiCheckpointHookDisplay({
  executingCount,
  completedCount,
  failedCount,
  contentWidth,
}: {
  executingCount: number;
  completedCount: number;
  failedCount: number;
  contentWidth?: number;
}) {
  const { t } = useTranslation();
  const headerWidth = getHookHeaderWidth(contentWidth);
  const isPending = failedCount === 0 && executingCount > 0;

  // Status precedence mirrors getOverallStatus in ParallelHooksDisplay:
  // Error > Executing > Completed, so the collapsed header matches the expanded
  // one for mixed batches.
  let statusText: string;
  let statusColor: string;
  if (failedCount > 0) {
    statusText = ` [${t('common:parallelHooks.failedCount', { count: failedCount })}]`;
    statusColor = COLORS.error;
  } else if (executingCount > 0) {
    const completedPart =
      completedCount > 0
        ? `, ${t('common:parallelHooks.completedCount', { count: completedCount })}`
        : '';
    statusText = ` [${t('common:parallelHooks.executingCount', { count: executingCount })}${completedPart}]`;
    statusColor = COLORS.warning;
  } else {
    statusText = ` [${t('common:parallelHooks.completedCount', { count: completedCount })}]`;
    statusColor = COLORS.success;
  }

  return (
    <Box flexDirection="row" marginLeft={HOOK_LEFT_MARGIN}>
      <ToolHeader
        toolName={HOOK_HEADER_NAME}
        headerParts={[
          { text: getGitAiCheckpointHookLabel() },
          { text: statusText, color: statusColor, rightAligned: true },
        ]}
        isPending={isPending}
        contentWidth={headerWidth}
        nameColor={COLORS.hookBadgeBg}
        pendingBaseColor={COLORS.hookBadgeBg}
      />
    </Box>
  );
}

function DetailedHookDisplay({
  hookEventName,
  hookMatcher,
  hookStatus,
  hookItems,
  contentWidth,
}: Omit<HookDisplayProps, 'hookCommands' | 'hookResults'> & {
  hookItems: HookDisplayItem[];
}) {
  const { t } = useTranslation();
  const isPending = hookStatus === HookExecutionStatus.Executing;
  const headerWidth = getHookHeaderWidth(contentWidth);
  const hookResults = hookItems
    .map((item) => item.result)
    .filter((result): result is HookResult => result !== undefined);

  return (
    <Box flexDirection="row" marginLeft={HOOK_LEFT_MARGIN}>
      <Box flexGrow={1} flexDirection="column">
        <ToolHeader
          toolName={HOOK_HEADER_NAME}
          headerParts={[
            { text: getHookContextLabel(hookEventName, hookMatcher) },
          ]}
          isPending={isPending}
          contentWidth={headerWidth}
          nameColor={COLORS.hookBadgeBg}
          pendingBaseColor={COLORS.hookBadgeBg}
        />

        {/* Commands */}
        <Box flexDirection="column" marginLeft={1} marginTop={0}>
          {hookItems.map((item, index) => (
            <HookCommandLine
              key={index}
              command={item.command.command}
              prefix={index === hookItems.length - 1 ? '└─' : '├─'}
              contentWidth={contentWidth}
            />
          ))}
        </Box>

        {/* Results */}
        {hookResults.length > 0 && (
          <Box flexDirection="column" marginLeft={1}>
            {hookResults.map((result, index) => (
              <Box key={index} flexDirection="column">
                <Box flexDirection="row">
                  <Text dimColor>
                    {t('common:hookDisplay.resultLabel', {
                      name: hookResults.length > 1 ? String(index + 1) : '',
                    })}
                  </Text>
                  <Text
                    color={
                      result.exitCode === 0 ? COLORS.success : COLORS.error
                    }
                  >
                    {t('common:hookDisplay.exitCodeLabel')}
                    {result.exitCode}
                  </Text>
                </Box>
                {result.stdout && result.stdout.trim().length > 0 && (
                  <Box flexDirection="column" marginLeft={2}>
                    <Text dimColor>{t('common:hookDisplay.stdoutLabel')}</Text>
                    <Text>{result.stdout.trim()}</Text>
                  </Box>
                )}
                {result.stderr && result.stderr.trim().length > 0 && (
                  <Box flexDirection="column" marginLeft={2}>
                    <Text dimColor>{t('common:hookDisplay.stderrLabel')}</Text>
                    <Text color={COLORS.error}>{result.stderr.trim()}</Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function HookDisplay({
  hookEventName,
  hookMatcher,
  hookCommands,
  hookStatus,
  hookResults,
  contentWidth,
  isDetailedView = false,
}: HookDisplayProps) {
  const hookItems = hookCommands.map((command, index) => ({
    command,
    result: hookResults?.[index],
  }));

  if (isDetailedView && shouldCollapseHookInTranscript(hookCommands)) {
    const results = hookResults ?? [];
    const completedCount = results.filter((r) => r.exitCode === 0).length;
    const explicitFailedCount = results.filter((r) => r.exitCode !== 0).length;
    const pendingCount = hookCommands.length - results.length;

    // A checkpoint hook can error before producing a result. When the batch
    // status is Error, treat any still-pending command as failed so the
    // collapsed transcript surfaces the failure instead of showing "executing".
    const isError = hookStatus === HookExecutionStatus.Error;
    const executingCount = isError ? 0 : pendingCount;
    const failedCount = isError
      ? explicitFailedCount + pendingCount
      : explicitFailedCount;
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
    <DetailedHookDisplay
      hookEventName={hookEventName}
      hookMatcher={hookMatcher}
      hookStatus={hookStatus}
      hookItems={hookItems}
      contentWidth={contentWidth}
    />
  );
}
