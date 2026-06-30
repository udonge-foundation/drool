import { Box, Text } from 'ink';
import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  QueuedUserMessageDisplayGroup,
  getQueuedUserMessageDisplayGroup,
  isReviewableQueuedMessageKind,
} from '@industry/daemon-client';

import { COLORS } from '@/components/chat/themedColors';
import { StyledHelpText } from '@/components/common/StyledHelpText';
import type { QueuedUserMessage } from '@/hooks/types';
import {
  displayWidth as getDisplayWidth,
  sliceByDisplayWidth,
} from '@/utils/displayWidth';

interface PendingMessagesListProps {
  items: QueuedUserMessage[];
  width: number;
  reviewActive?: boolean;
  reviewEnabled?: boolean;
  selectedItemId?: string;
}

interface PreviewOptions {
  maxLines?: number;
  showMoreLineCount?: boolean;
  formatMoreLines?: (count: number) => string;
}

const MAX_PREVIEW_LINES = 3;
const ELLIPSIS = '…';
const ELLIPSIS_WIDTH = getDisplayWidth(ELLIPSIS);
const QUEUED_ACCENT_COLORS = [
  COLORS.primary,
  COLORS.queuedAccentPurple,
  COLORS.success,
] as const;

const getQueuedAccentColor = (index: number): string =>
  QUEUED_ACCENT_COLORS[index % QUEUED_ACCENT_COLORS.length];

type PendingMessageGroupKey = 'steering' | 'queued';
type BracketedTitlePrefixSplit = { prefix: string; rest: string };

interface PendingMessageGroupConfig {
  key: PendingMessageGroupKey;
  items: QueuedUserMessage[];
  label: string;
  getAccentColor: (item: QueuedUserMessage, index: number) => string;
  getTextColor: (index: number) => string;
  previewOptions?: PreviewOptions;
}

interface QueuedMessageRowProps {
  item: QueuedUserMessage;
  width: number;
  accentColor: string;
  textColor: string;
  selected: boolean;
  previewOptions?: PreviewOptions;
}

interface QueuedMessageGroupProps {
  group: PendingMessageGroupConfig;
  width: number;
  reviewActive: boolean;
  selectedItemId?: string;
}

function truncateLine(line: string, width: number): string {
  if (width <= 0) return '';
  if (getDisplayWidth(line) <= width) return line;
  if (width <= ELLIPSIS_WIDTH) return ELLIPSIS;
  const { slice } = sliceByDisplayWidth(line, width - ELLIPSIS_WIDTH);
  return `${slice}${ELLIPSIS}`;
}

function appendEllipsis(line: string, width: number): string {
  if (width <= 0) return '';
  if (getDisplayWidth(line) + ELLIPSIS_WIDTH <= width) {
    return `${line}${ELLIPSIS}`;
  }
  return truncateLine(line, width);
}

function appendMoreLinesSuffix(
  line: string,
  width: number,
  hiddenLineCount: number,
  formatMoreLines: (count: number) => string
): string {
  const suffix = ` ${formatMoreLines(hiddenLineCount)}`;
  const fullLine = `${line}${suffix}`;

  if (width <= 0) return '';
  if (getDisplayWidth(fullLine) <= width) return fullLine;
  const suffixWidth = getDisplayWidth(suffix);
  if (suffixWidth + ELLIPSIS_WIDTH <= width) {
    const { slice } = sliceByDisplayWidth(
      line,
      width - suffixWidth - ELLIPSIS_WIDTH
    );
    return `${slice}${ELLIPSIS}${suffix}`;
  }
  return truncateLine(suffix, width);
}

function getPreviewLines(
  text: string,
  previewLineCount: number
): {
  visibleLines: string[];
  hiddenLineCount: number;
} {
  const visibleLines: string[] = [];
  let lineStart = 0;
  let totalLineCount = 0;

  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\n') {
      continue;
    }

    let lineEnd = index;
    if (lineEnd > lineStart && text[lineEnd - 1] === '\r') {
      lineEnd--;
    }

    if (visibleLines.length < previewLineCount) {
      visibleLines.push(text.slice(lineStart, lineEnd));
    }
    totalLineCount++;
    lineStart = index + 1;
  }

  return {
    visibleLines,
    hiddenLineCount: Math.max(0, totalLineCount - previewLineCount),
  };
}

function formatPreview(
  text: string,
  width: number,
  {
    maxLines = 1,
    showMoreLineCount = false,
    formatMoreLines = (count) =>
      `(${count} more ${count === 1 ? 'line' : 'lines'})`,
  }: PreviewOptions = {}
): string {
  const available = Math.max(0, width - 3);
  const previewLineCount = Math.max(1, maxLines);
  const { visibleLines, hiddenLineCount } = getPreviewLines(
    text,
    previewLineCount
  );

  if (available <= 0) {
    return '';
  }

  return visibleLines
    .map((line, index) => {
      const isLastVisibleLine = index === visibleLines.length - 1;
      if (isLastVisibleLine && hiddenLineCount > 0) {
        return showMoreLineCount
          ? appendMoreLinesSuffix(
              line,
              available,
              hiddenLineCount,
              formatMoreLines
            )
          : appendEllipsis(line, available);
      }
      return truncateLine(line, available);
    })
    .join('\n');
}

function splitLeadingBracketedTitlePrefix(
  line: string
): BracketedTitlePrefixSplit | null {
  if (!line.startsWith('[')) return null;
  const endIndex = line.indexOf(']');
  if (endIndex <= 0) return null;

  return {
    prefix: line.slice(0, endIndex + 1),
    rest: line.slice(endIndex + 1),
  };
}

function PreviewTextWithBoldTitlePrefix({
  backgroundColor,
  color,
  text,
}: {
  backgroundColor: string;
  color: string;
  text: string;
}) {
  return (
    <>
      {text.split('\n').map((line, index) => {
        const split = splitLeadingBracketedTitlePrefix(line);
        return (
          <Fragment key={`${index}-${line}`}>
            {index > 0 ? '\n' : null}
            {split ? (
              <>
                <Text bold backgroundColor={backgroundColor} color={color}>
                  {split.prefix}
                </Text>
                {split.rest}
              </>
            ) : (
              line
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function QueuedMessageRow({
  item,
  width,
  accentColor,
  textColor,
  selected,
  previewOptions,
}: QueuedMessageRowProps) {
  const display = useMemo(
    () => formatPreview(item.text || '', width, previewOptions),
    [item.text, previewOptions, width]
  );
  const resolvedTextColor = selected ? COLORS.text.primary : textColor;

  return (
    <Box flexDirection="row" width="100%">
      <Box backgroundColor={accentColor} flexShrink={0}>
        <Text backgroundColor={accentColor}> </Text>
      </Box>
      <Box paddingLeft={2} backgroundColor={COLORS.text.userBg} flexGrow={1}>
        <Text
          color={resolvedTextColor}
          backgroundColor={COLORS.text.userBg}
          wrap="wrap"
        >
          <PreviewTextWithBoldTitlePrefix
            backgroundColor={COLORS.text.userBg}
            color={resolvedTextColor}
            text={display}
          />{' '}
        </Text>
      </Box>
    </Box>
  );
}

function QueuedMessageGroup({
  group,
  width,
  reviewActive,
  selectedItemId,
}: QueuedMessageGroupProps) {
  if (group.items.length === 0) return null;

  return (
    <>
      <Box paddingLeft={3}>
        <Text color={COLORS.text.muted}>{group.label}</Text>
      </Box>
      {group.items.map((item, index) => (
        <QueuedMessageRow
          key={item.id}
          item={item}
          width={width}
          accentColor={group.getAccentColor(item, index)}
          textColor={group.getTextColor(index)}
          selected={reviewActive && item.id === selectedItemId}
          previewOptions={group.previewOptions}
        />
      ))}
    </>
  );
}

export function PendingMessagesList({
  items,
  width,
  reviewActive = false,
  reviewEnabled = false,
  selectedItemId,
}: PendingMessagesListProps) {
  const { t } = useTranslation();
  const { steeringItems, queuedItems, showReviewHint } = useMemo(() => {
    const nextSteeringItems: QueuedUserMessage[] = [];
    const nextQueuedItems: QueuedUserMessage[] = [];

    for (const item of items) {
      if (
        getQueuedUserMessageDisplayGroup(item.kind) ===
        QueuedUserMessageDisplayGroup.Queued
      ) {
        nextQueuedItems.push(item);
      } else {
        nextSteeringItems.push(item);
      }
    }

    return {
      steeringItems: nextSteeringItems,
      queuedItems: nextQueuedItems,
      showReviewHint:
        reviewEnabled &&
        items.some((item) => isReviewableQueuedMessageKind(item.kind)),
    };
  }, [items, reviewEnabled]);
  const queuedPreviewOptions = useMemo<PreviewOptions>(
    () => ({
      maxLines: MAX_PREVIEW_LINES,
      showMoreLineCount: true,
      formatMoreLines: (count) =>
        t('common:pendingMessages.moreLines', { count }),
    }),
    [t]
  );
  const groups = useMemo<PendingMessageGroupConfig[]>(
    () => [
      {
        key: 'steering',
        items: steeringItems,
        label: t('common:pendingMessages.steeringMessages'),
        getAccentColor: () => COLORS.text.queuedSymbol,
        getTextColor: () => COLORS.text.queuedText,
      },
      {
        key: 'queued',
        items: queuedItems,
        label: t('common:pendingMessages.queuedMessages'),
        getAccentColor: (_item, index) => getQueuedAccentColor(index),
        getTextColor: () => COLORS.text.queuedText,
        previewOptions: queuedPreviewOptions,
      },
    ],
    [queuedItems, queuedPreviewOptions, steeringItems, t]
  );

  if (items.length === 0) return null;

  const reviewHint = reviewActive
    ? t('common:pendingMessages.queuedReviewActiveHint')
    : t('common:pendingMessages.queuedReviewHint');

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      {groups.map((group) => (
        <QueuedMessageGroup
          key={group.key}
          group={group}
          width={width}
          reviewActive={reviewActive}
          selectedItemId={selectedItemId}
        />
      ))}
      {showReviewHint ? (
        <Box paddingLeft={3}>
          <StyledHelpText text={reviewHint} />
        </Box>
      ) : null}
    </Box>
  );
}
