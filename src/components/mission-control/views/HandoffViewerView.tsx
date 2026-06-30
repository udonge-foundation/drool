import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ProgressLogEntryType,
  type Handoff,
  type ProgressLogEntry,
} from '@industry/drool-sdk-ext/protocol/drool';

import { MC_COLORS } from '@/components/mission-control/constants';
import type { HandoffViewerViewProps } from '@/components/mission-control/types';
import {
  truncateWithEllipsis,
  wrapText,
} from '@/components/mission-control/utils/text';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';

interface SectionProps {
  title: string;
  content: string | null | undefined;
  contentWidth: number;
  color?: string;
}

function Section({ title, content, contentWidth, color }: SectionProps) {
  const displayContent = content?.trim();
  if (!displayContent) {
    return null;
  }
  const lines = wrapText(displayContent, Math.max(1, contentWidth - 2));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={MC_COLORS.t4}>{title}</Text>
      <Box flexDirection="column" marginLeft={2}>
        {lines.map((line, index) => (
          <Text
            key={index}
            color={color ?? MC_COLORS.primary}
            wrap="truncate-end"
          >
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

interface DiscoveredIssuesSectionProps {
  issues: Handoff['discoveredIssues'] | undefined;
  contentWidth: number;
}

function DiscoveredIssuesSection({
  issues,
  contentWidth,
}: DiscoveredIssuesSectionProps) {
  const { t } = useTranslation('common');

  if (!issues || issues.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={MC_COLORS.t4}>
          {t('common:handoffViewer.discoveredIssuesTitle')}
        </Text>
        <Box marginLeft={2}>
          <Text color={MC_COLORS.tertiary}>
            {t('common:handoffViewer.noIssues')}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={MC_COLORS.t4}>
        {t('common:handoffViewer.discoveredIssuesTitle')} {issues.length}
      </Text>
      {issues.map((issue, index) => (
        <Box key={index} flexDirection="column" marginLeft={2} marginBottom={1}>
          <Text
            color={
              issue.severity === 'blocking'
                ? MC_COLORS.fail
                : MC_COLORS.tertiary
            }
          >
            [{issue.severity}]
          </Text>
          {wrapText(issue.description, Math.max(1, contentWidth - 6)).map(
            (line, lineIndex) => (
              <Text key={`${index}-${lineIndex}`} wrap="truncate-end">
                {line}
              </Text>
            )
          )}
          {issue.suggestedFix ? (
            <Box flexDirection="column" marginLeft={2}>
              <Text color={MC_COLORS.tertiary}>
                {t('common:handoffViewer.suggestedFix')}
              </Text>
              {wrapText(issue.suggestedFix, Math.max(1, contentWidth - 8)).map(
                (line, lineIndex) => (
                  <Text
                    key={`${index}-fix-${lineIndex}`}
                    color={MC_COLORS.secondary}
                    wrap="truncate-end"
                  >
                    {line}
                  </Text>
                )
              )}
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

function getWorkerHandoffFromProgressLog(
  progressLog: ProgressLogEntry[],
  workerSessionId: string
): Handoff | null {
  for (let index = progressLog.length - 1; index >= 0; index -= 1) {
    const entry = progressLog[index];
    if (
      entry.type === ProgressLogEntryType.WorkerCompleted &&
      entry.workerSessionId === workerSessionId
    ) {
      return entry.handoff ?? null;
    }
  }
  return null;
}

export function HandoffViewerView({
  workerSessionId,
  featureId,
  viewport,
}: HandoffViewerViewProps) {
  const { t } = useTranslation('common');
  const terminalDimensions = useTerminalDimensions();
  const width = viewport?.width ?? terminalDimensions.width;
  const contentWidth = Math.max(1, width);

  const title = t('common:handoffViewer.title');
  const sessionLabel = t('common:handoffViewer.sessionLabel');
  const featureLabel = t('common:handoffViewer.featureLabel');

  const missionSessionId = getSessionService().getDecompMissionId();
  const missionStore = missionSessionId
    ? getTuiDaemonAdapter()
        .getMissionStateManager()
        .getMissionStoreIfKnown(missionSessionId)
    : null;
  const [version, setVersion] = useState(0);

  useEffect(
    () => missionStore?.subscribe(() => setVersion((current) => current + 1)),
    [missionStore]
  );

  const handoff = useMemo(
    () =>
      getWorkerHandoffFromProgressLog(
        missionStore?.getSnapshot().progressLog ?? [],
        workerSessionId
      ),
    [missionStore, version, workerSessionId]
  );

  const truncatedSessionId = truncateWithEllipsis(
    workerSessionId,
    Math.max(0, contentWidth - sessionLabel.length)
  );
  const truncatedFeatureId = featureId
    ? truncateWithEllipsis(
        featureId,
        Math.max(0, contentWidth - featureLabel.length)
      )
    : null;

  if (!handoff) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={MC_COLORS.emphasis}>
            {title}
          </Text>
          <Box marginTop={1}>
            <Text color={MC_COLORS.tertiary}>{sessionLabel}</Text>
            <Text>{truncatedSessionId}</Text>
          </Box>
          {truncatedFeatureId ? (
            <Box>
              <Text color={MC_COLORS.tertiary}>{featureLabel}</Text>
              <Text>{truncatedFeatureId}</Text>
            </Box>
          ) : null}
          <Text color={MC_COLORS.border}>
            {'─'.repeat(Math.min(contentWidth, 60))}
          </Text>
        </Box>
        <Text color={MC_COLORS.tertiary}>
          {t('common:handoffViewer.noHandoff')}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={MC_COLORS.emphasis}>
          {title}
        </Text>
        <Box marginTop={1}>
          <Text color={MC_COLORS.tertiary}>{sessionLabel}</Text>
          <Text>{truncatedSessionId}</Text>
        </Box>
        {truncatedFeatureId ? (
          <Box>
            <Text color={MC_COLORS.tertiary}>{featureLabel}</Text>
            <Text>{truncatedFeatureId}</Text>
          </Box>
        ) : null}
        <Text color={MC_COLORS.border}>
          {'─'.repeat(Math.min(contentWidth, 60))}
        </Text>
      </Box>

      <Section
        title={t('common:handoffViewer.summaryTitle')}
        content={handoff.salientSummary}
        contentWidth={contentWidth}
      />
      <Section
        title={t('common:handoffViewer.leftUndoneTitle')}
        content={handoff.whatWasLeftUndone}
        contentWidth={contentWidth}
        color={MC_COLORS.secondary}
      />
      <DiscoveredIssuesSection
        issues={handoff.discoveredIssues}
        contentWidth={contentWidth}
      />
    </Box>
  );
}
