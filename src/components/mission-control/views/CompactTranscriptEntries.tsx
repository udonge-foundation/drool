/**
 * Shared compact transcript entry components used by both SessionViewerView
 * and ActiveWorkerPreview for consistent Lines(N) rendering of transcript rows.
 *
 * Provides:
 * - CompactMessageEntry: renders a message row with role marker + content
 * - CompactToolEntry: renders a tool call row with tag + params + result
 */

import { Box, Text } from 'ink';
import React from 'react';

import { MessageRole } from '@industry/drool-sdk-ext/protocol/sessionV2';

import { MC_COLORS } from '@/components/mission-control/constants';
import { SubagentState } from '@/components/mission-control/enums';
import type {
  CompactMessage,
  SubagentActivityItem,
  SubagentDisplayData,
} from '@/components/mission-control/types';
import {
  getCompactResultSummary,
  normalizeToSingleLine,
} from '@/components/mission-control/utils/compactResultSummary';
import { getCompactToolParams } from '@/components/mission-control/utils/compactToolParams';
import {
  formatTimestamp,
  getTaskParamSummary,
  isTaskToolUse,
} from '@/components/mission-control/utils/subagentActivity';
import { truncateWithEllipsis } from '@/components/mission-control/utils/text';
import { Spinner } from '@/components/Spinner';
import type { ToolExecution } from '@/types/types';
import { getDisplayNameForTool } from '@/utils/tool-display';

/** Get role marker symbol matching MessageItem conventions */
function getRoleMarker(role: MessageRole): string {
  switch (role) {
    case MessageRole.User:
      return '>';
    case MessageRole.Assistant:
      return '🔱';
    case MessageRole.Tool:
      return '●';
    case MessageRole.System:
      return '●';
    default:
      return '●';
  }
}

/** Get role marker color matching MC v22 design spec */
function getRoleMarkerColor(role: MessageRole): string {
  switch (role) {
    case MessageRole.User:
      return MC_COLORS.active;
    case MessageRole.Assistant:
      return MC_COLORS.active;
    case MessageRole.Tool:
      return MC_COLORS.secondary;
    case MessageRole.System:
      return MC_COLORS.secondary;
    default:
      return MC_COLORS.secondary;
  }
}

/**
 * Split text across multiple lines, preserving word boundaries when possible.
 * For long content that doesn't fit, shows the start with ellipsis.
 */
function splitTextForLines(
  text: string,
  lineWidth: number,
  maxLines: number
): string[] {
  if (maxLines <= 0 || lineWidth <= 0 || !text) {
    return [''];
  }

  const normalized = normalizeToSingleLine(text);

  if (maxLines === 1) {
    return [truncateWithEllipsis(normalized, lineWidth)];
  }

  const totalAvailableChars = lineWidth * maxLines;

  // If text fits in available space, split into lines
  if (normalized.length <= totalAvailableChars) {
    const lines: string[] = [];
    for (
      let i = 0;
      i < normalized.length && lines.length < maxLines;
      i += lineWidth
    ) {
      lines.push(normalized.slice(i, i + lineWidth));
    }
    // Pad with empty strings if fewer lines than maxLines
    while (lines.length < maxLines) {
      lines.push('');
    }
    return lines;
  }

  // Text too long - fill lines and show ellipsis on last line
  const lines: string[] = [];
  for (let i = 0; i < maxLines - 1; i++) {
    lines.push(normalized.slice(i * lineWidth, (i + 1) * lineWidth));
  }
  // Last line gets truncated with ellipsis
  const lastLineStart = (maxLines - 1) * lineWidth;
  lines.push(truncateWithEllipsis(normalized.slice(lastLineStart), lineWidth));

  return lines;
}

/**
 * Compact message entry with configurable line height.
 * Line 1: Role marker + content start
 * Lines 2+: Content continuation (if linesPerEntry > 1)
 */
export function CompactMessageEntry({
  message,
  contentWidth,
  linesPerEntry,
}: {
  message: CompactMessage;
  contentWidth: number;
  linesPerEntry: number;
}) {
  const marker = getRoleMarker(message.role);
  const markerColor = getRoleMarkerColor(message.role);
  // Account for marker (1 char) + space (1 char) on first line
  const firstLineWidth = Math.max(10, contentWidth - 4);

  // Split content across lines
  const lines = splitTextForLines(
    message.content,
    firstLineWidth,
    linesPerEntry
  );

  const contentColor = MC_COLORS.t2;

  return (
    <Box flexDirection="column" height={linesPerEntry}>
      <Text wrap="truncate-end">
        <Text color={markerColor} bold>
          {marker}
        </Text>
        <Text color={contentColor}> {lines[0] || ''}</Text>
      </Text>
      {lines.slice(1).map((line, lineIdx) => (
        <Text
          key={`${message.id}-l${lineIdx}`}
          color={contentColor}
          wrap="truncate-end"
        >
          {'  '}
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Right-align a left part and right part within a given line width.
 * If they don't fit together, truncates the left part to make room.
 */
function rightAlignLine(
  left: string,
  right: string,
  lineWidth: number
): string {
  const totalNeeded = left.length + 1 + right.length;
  if (totalNeeded > lineWidth) {
    const availLeft = Math.max(3, lineWidth - right.length - 1);
    return `${truncateWithEllipsis(left, availLeft)} ${right}`;
  }
  const gap = lineWidth - left.length - right.length;
  return `${left}${' '.repeat(gap)}${right}`;
}

/**
 * Format a single activity item as a left-hand string: '↳ HH:MM:SS  ToolDisplay'.
 * Execute tool uses just the '$ command' (paramSummary already has $ prefix);
 * other tools use 'ToolName params'.
 */
function formatActivityLeft(item: SubagentActivityItem): string {
  const timestamp = formatTimestamp(item.timestamp);
  const toolDisplay =
    item.toolName === 'Execute'
      ? item.paramSummary
      : `${item.toolName}${item.paramSummary ? ` ${item.paramSummary}` : ''}`;
  return `↳ ${timestamp}  ${toolDisplay}`;
}

/**
 * Build ↳ activity lines for a subagent in initializing or live state.
 * Returns an array of pre-truncated strings (one per ↳ line).
 *
 * - Initializing: always 1 line — '↳ Initializing...    Xs'
 * - LiveActivity, maxLines=1: single line with stats on right
 * - LiveActivity, maxLines>1: most recent N lines; stats only on last
 */
function buildSubagentActivityLines(
  subagentData: SubagentDisplayData,
  lineWidth: number,
  maxLines: number
): string[] {
  if (maxLines <= 0) return [];

  const { state, stats, recentActivity } = subagentData;

  if (state === SubagentState.Initializing) {
    const leftPart = '↳ Initializing...';
    const rightPart = stats.formattedElapsed;
    return [rightAlignLine(leftPart, rightPart, lineWidth)];
  }

  // LiveActivity
  if (recentActivity.length === 0) {
    // Shouldn't happen (live_activity requires activity) but handle gracefully
    return [`↳ ...${' '.repeat(Math.max(1, lineWidth - 5))}`];
  }

  // Show the most recent N items (N = min(maxLines, available items))
  const items = recentActivity.slice(-maxLines);
  const lines: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const isLast = i === items.length - 1;
    const leftPart = formatActivityLeft(item);

    if (isLast) {
      // Last line gets right-aligned stats
      lines.push(rightAlignLine(leftPart, stats.formattedStats, lineWidth));
    } else {
      // Non-last lines: just the activity content, truncated if needed
      lines.push(
        leftPart.length > lineWidth
          ? truncateWithEllipsis(leftPart, lineWidth)
          : leftPart
      );
    }
  }

  return lines;
}

/**
 * Compact tool entry with configurable line height.
 * Renders entirely as pre-truncated plain strings to avoid Ink layout issues
 * with background-colored text in constrained containers.
 *
 * For non-Task tools:
 *   Line 1: TOOLNAME  params (pre-truncated to contentWidth)
 *   Lines 2+: → result (pre-truncated to contentWidth)
 *
 * For Task tools with subagentData:
 *   Line 1: TASK  subagent_type: description
 *   Line 2 (initializing): ↳ Initializing...    Xs
 *   Line 2 (live activity): ↳ HH:MM:SS  ToolName params    N tools · Xm Ys
 *   Lines 2+ (completed): → result text (standard rendering)
 */
export function CompactToolEntry({
  tool,
  contentWidth,
  linesPerEntry,
  padTagLeft,
  subagentData,
  showSpinner,
}: {
  tool: ToolExecution;
  contentWidth: number;
  linesPerEntry: number;
  padTagLeft?: boolean;
  subagentData?: SubagentDisplayData;
  /** When true, show an animated Spinner inline on the tag line (for in-progress tools) */
  showSpinner?: boolean;
}) {
  const isTask = isTaskToolUse(tool.toolName);
  const displayName = getDisplayNameForTool(tool.toolName);

  // Task tools get uppercase tag and dedicated param summary
  const tagText = isTask ? displayName.toUpperCase() : displayName;
  const paramSummary = isTask
    ? getTaskParamSummary(tool.toolInput)
    : getCompactToolParams(tool.toolName, tool.toolInput);

  const tagStr = padTagLeft ? `  ${tagText}` : ` ${tagText}`;

  // Determine if we should render subagent ↳ activity lines
  const showSubagentActivity =
    isTask && subagentData && subagentData.state !== SubagentState.Completed;

  const resultLinesCount = Math.max(0, linesPerEntry - 1);

  // --- Build tag line ---
  let tagLineNode: React.ReactNode;

  if (showSubagentActivity && linesPerEntry === 1) {
    // 1-line mode: tag + params + right-aligned stats/indicator on tag line
    const { state, stats } = subagentData!;
    const rightPart =
      state === SubagentState.Initializing
        ? `Initializing... ${stats.formattedElapsed}`
        : stats.formattedStats;

    // Reserve space: tagStr + "  " + params + minGap(4) + rightPart
    const minGap = 4;
    const maxParamsWidth = Math.max(
      0,
      contentWidth - tagStr.length - 2 - minGap - rightPart.length
    );
    const truncParams = paramSummary
      ? truncateWithEllipsis(paramSummary, maxParamsWidth)
      : '';
    const leftWidth =
      tagStr.length + (truncParams ? 2 + truncParams.length : 0);
    const gap = Math.max(1, contentWidth - leftWidth - rightPart.length);

    tagLineNode = (
      <Text wrap="truncate-end">
        <Text color={MC_COLORS.t6} bold>
          {tagStr}
        </Text>
        {truncParams ? (
          <Text color={MC_COLORS.t6}>
            {'  '}
            {truncParams}
          </Text>
        ) : null}
        <Text color={MC_COLORS.info}>
          {' '.repeat(gap)}
          {rightPart}
        </Text>
      </Text>
    );
  } else {
    // Standard tag line (no stats on this line)
    // Reserve 3 chars for spinner: min gap (1) + spinner char (1) + right pad (1)
    const spinnerReserved = showSpinner ? 3 : 0;
    const truncatedParams = paramSummary
      ? truncateWithEllipsis(
          paramSummary,
          Math.max(5, contentWidth - tagStr.length - 2 - spinnerReserved)
        )
      : '';
    const leftLen =
      tagStr.length + (truncatedParams ? 2 + truncatedParams.length : 0);
    // 1 char right padding to mirror the 1 char left padding in tagStr
    const spinnerGap = showSpinner
      ? Math.max(1, contentWidth - leftLen - 2)
      : 0;
    tagLineNode = (
      <Text wrap="truncate-end">
        <Text color={MC_COLORS.t6} bold>
          {tagStr}
        </Text>
        {truncatedParams ? (
          <Text color={MC_COLORS.t6}>
            {'  '}
            {truncatedParams}
          </Text>
        ) : (
          ''
        )}
        {showSpinner && (
          <Text>
            {' '.repeat(spinnerGap)}
            <Spinner />{' '}
          </Text>
        )}
      </Text>
    );
  }

  // --- Build sub-lines (either ↳ activity or standard → result) ---
  let subLines: React.ReactNode[];

  if (showSubagentActivity) {
    // Render ↳ activity lines for initializing/live states
    const lineWidth = Math.max(10, contentWidth - 2);
    const activityStrings = buildSubagentActivityLines(
      subagentData!,
      lineWidth,
      resultLinesCount
    );
    subLines = activityStrings.map((str, idx) => (
      <Text
        key={`${tool.id}-subagent-${idx}`}
        color={MC_COLORS.info}
        wrap="truncate-end"
      >
        {'  '}
        {str}
      </Text>
    ));
  } else {
    // Standard result rendering (non-Task tools, or completed Task tools)
    // For completed Task tools: use tool.result when available, otherwise
    // fall back to sessionEnd.finalText when completed via session_end.
    const effectiveResult =
      tool.result ||
      (isTask &&
        subagentData?.state === SubagentState.Completed &&
        subagentData.sessionEnd?.finalText) ||
      undefined;
    const resultSummary = getCompactResultSummary(
      effectiveResult || undefined,
      tool.isError
    );
    const resultTextLines =
      resultLinesCount > 0 && resultSummary
        ? splitTextForLines(resultSummary, contentWidth - 2, resultLinesCount)
        : [];
    subLines = resultTextLines.map((line, lineIdx) => (
      <Text
        key={`${tool.id}-r${lineIdx}`}
        color={tool.isError ? MC_COLORS.fail : MC_COLORS.info}
        wrap="truncate-end"
      >
        {'  '}
        {line}
      </Text>
    ));
  }

  // Pad remaining lines to maintain fixed height
  const padCount = Math.max(0, resultLinesCount - subLines.length);

  return (
    <Box flexDirection="column" height={linesPerEntry}>
      {tagLineNode}
      {subLines}
      {Array.from({ length: padCount }).map((_, padIdx) => (
        <Text key={`${tool.id}-pad-${padIdx}`}> </Text>
      ))}
    </Box>
  );
}
