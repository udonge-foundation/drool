import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { ToolCallStatus } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import type {
  CollapsedToolGroup as CollapsedToolGroupType,
  ToolExecution,
} from '@/types/types';
import { getDisplayNameForTool } from '@/utils/tool-display';

const MAX_PREVIEW_ITEMS = 8;
const MAX_PATH_SEGMENTS = 3;

function shortenPath(filePath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const normalized =
    home && filePath.startsWith(home)
      ? `~${filePath.slice(home.length)}`
      : filePath;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= MAX_PATH_SEGMENTS) return normalized;
  return `.../${parts.slice(-MAX_PATH_SEGMENTS).join('/')}`;
}

interface CollapsedToolGroupProps {
  group: CollapsedToolGroupType;
  compact?: boolean;
}

const TOOL_NAME_COLOR = COLORS.toolName;
const TOOL_COLOR = COLORS.toolParam;

function getStringInput(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getToolSubtitle(tool: ToolExecution): string | null {
  const input = tool.toolInput;
  if (!input) return null;

  switch (tool.toolName) {
    case 'Read':
      return input.file_path ? shortenPath(input.file_path as string) : null;
    case 'Grep': {
      const pattern = (input.pattern as string) || null;
      if (!pattern) return null;
      const quoted = `"${pattern}"`;
      const grepPath = (input.path ?? input.folder) as string | undefined;
      if (grepPath) return `${quoted} in ${shortenPath(grepPath)}`;
      return quoted;
    }
    case 'Glob': {
      const patterns = input.patterns;
      if (typeof patterns === 'string') return patterns;
      if (Array.isArray(patterns)) return patterns.join(', ');
      return null;
    }
    case 'LS':
      return input.directory_path
        ? shortenPath(input.directory_path as string)
        : null;
    case 'WebSearch':
      return (
        getStringInput(input, 'query') ??
        getStringInput(input, 'objective') ??
        null
      );
    case 'FetchUrl':
      return (input.url as string) || null;
    default:
      return null;
  }
}

// Left margin (3) + subtitle indent (1) + arrow prefix (2) = 6 chars
const SUBTITLE_INDENT = 6;

function truncateSubtitle(text: string, _toolName: string): string {
  const maxWidth = (process.stdout.columns || 80) - SUBTITLE_INDENT;
  if (text.length > maxWidth) {
    return `${text.slice(0, maxWidth - 3)}...`;
  }
  return text;
}

interface CollapsedToolDisplayIdentity {
  toolName: string;
  primary?: string;
  qualifier?: string;
  uniqueKey?: string;
}

interface CollapsedToolDisplayEntry {
  key: string;
  subtitle: string | null;
  isError: boolean;
  status: ToolCallStatus;
  identity: CollapsedToolDisplayIdentity;
}

function hasExplicitReadRange(input: Record<string, unknown>): boolean {
  return Object.hasOwn(input, 'offset') || Object.hasOwn(input, 'limit');
}

function isActiveStatus(status: ToolCallStatus): boolean {
  return (
    status === ToolCallStatus.Executing || status === ToolCallStatus.Pending
  );
}

interface ReadFileDisplayState {
  count: number;
  hasExplicitRange: boolean;
  hasActiveRead: boolean;
}

interface ReadDisplayDedupeState {
  dedupedFilePaths: Set<string>;
  shouldDeferUnknownActiveReads: boolean;
}

function getReadDisplayDedupeState(
  tools: ToolExecution[]
): ReadDisplayDedupeState {
  const fileStates = new Map<string, ReadFileDisplayState>();
  let identifiedReadCount = 0;

  for (const tool of tools) {
    if (tool.toolName !== 'Read') continue;

    const filePath = getStringInput(tool.toolInput, 'file_path');
    if (!filePath) continue;

    identifiedReadCount += 1;

    const current = fileStates.get(filePath) ?? {
      count: 0,
      hasExplicitRange: false,
      hasActiveRead: false,
    };

    current.count += 1;
    current.hasExplicitRange =
      current.hasExplicitRange || hasExplicitReadRange(tool.toolInput);
    current.hasActiveRead =
      current.hasActiveRead || isActiveStatus(tool.status);
    fileStates.set(filePath, current);
  }

  const dedupedFilePaths = new Set<string>();
  for (const [filePath, state] of fileStates) {
    if (state.hasExplicitRange || (state.count > 1 && state.hasActiveRead)) {
      dedupedFilePaths.add(filePath);
    }
  }

  return {
    dedupedFilePaths,
    shouldDeferUnknownActiveReads: identifiedReadCount > 0,
  };
}

function getDisplayIdentity(
  tool: ToolExecution,
  readDedupeState: ReadDisplayDedupeState
): CollapsedToolDisplayIdentity | null {
  const uniqueKey = `${tool.toolName}:${tool.id}`;
  const { toolInput } = tool;

  switch (tool.toolName) {
    case 'Read': {
      const filePath = getStringInput(toolInput, 'file_path');
      if (
        !filePath &&
        isActiveStatus(tool.status) &&
        readDedupeState.shouldDeferUnknownActiveReads
      ) {
        return null;
      }
      if (
        filePath &&
        (hasExplicitReadRange(toolInput) ||
          readDedupeState.dedupedFilePaths.has(filePath))
      ) {
        return { toolName: tool.toolName, primary: filePath };
      }
      return { toolName: tool.toolName, uniqueKey };
    }
    case 'Grep': {
      const pattern = getStringInput(toolInput, 'pattern');
      if (!pattern) return { toolName: tool.toolName, uniqueKey };

      const qualifier =
        getStringInput(toolInput, 'path') ??
        getStringInput(toolInput, 'folder');
      return { toolName: tool.toolName, primary: pattern, qualifier };
    }
    case 'Glob': {
      const patterns = toolInput.patterns;
      if (typeof patterns === 'string' && patterns.length > 0) {
        return { toolName: tool.toolName, primary: patterns };
      }
      if (Array.isArray(patterns) && patterns.length > 0) {
        return {
          toolName: tool.toolName,
          primary: patterns
            .filter((pattern): pattern is string => typeof pattern === 'string')
            .join('\n'),
        };
      }
      return { toolName: tool.toolName, uniqueKey };
    }
    case 'LS': {
      const directoryPath = getStringInput(toolInput, 'directory_path');
      return directoryPath
        ? { toolName: tool.toolName, primary: directoryPath }
        : { toolName: tool.toolName, uniqueKey };
    }
    case 'WebSearch': {
      const query =
        getStringInput(toolInput, 'query') ??
        getStringInput(toolInput, 'objective');
      return query
        ? { toolName: tool.toolName, primary: query }
        : { toolName: tool.toolName, uniqueKey };
    }
    case 'FetchUrl': {
      const url = getStringInput(toolInput, 'url');
      return url
        ? { toolName: tool.toolName, primary: url }
        : { toolName: tool.toolName, uniqueKey };
    }
    default:
      return { toolName: tool.toolName, uniqueKey };
  }
}

function mergeStatus(
  current: ToolCallStatus,
  next: ToolCallStatus
): ToolCallStatus {
  if (isActiveStatus(next)) return next;
  if (isActiveStatus(current)) return current;
  return next;
}

function getDisplayKey(identity: CollapsedToolDisplayIdentity): string {
  if (identity.uniqueKey) return identity.uniqueKey;
  return JSON.stringify([
    identity.toolName,
    identity.primary,
    identity.qualifier ?? null,
  ]);
}

function identitiesMatch(
  current: CollapsedToolDisplayIdentity,
  next: CollapsedToolDisplayIdentity
): boolean {
  if (current.uniqueKey || next.uniqueKey) {
    return (
      current.uniqueKey !== undefined && current.uniqueKey === next.uniqueKey
    );
  }

  return (
    current.toolName === next.toolName &&
    current.primary === next.primary &&
    (current.qualifier === undefined ||
      next.qualifier === undefined ||
      current.qualifier === next.qualifier)
  );
}

function mergeIdentity(
  current: CollapsedToolDisplayIdentity,
  next: CollapsedToolDisplayIdentity
): CollapsedToolDisplayIdentity {
  return {
    toolName: current.toolName,
    primary: current.primary,
    qualifier: next.qualifier ?? current.qualifier,
  };
}

function buildDisplayEntries(
  tools: ToolExecution[]
): CollapsedToolDisplayEntry[] {
  const readDedupeState = getReadDisplayDedupeState(tools);
  const entries: CollapsedToolDisplayEntry[] = [];

  for (const tool of tools) {
    const identity = getDisplayIdentity(tool, readDedupeState);
    if (!identity) continue;

    const existingIndex = entries.findIndex((entry) =>
      identitiesMatch(entry.identity, identity)
    );
    const subtitle = getToolSubtitle(tool);

    if (existingIndex === -1) {
      entries.push({
        key: getDisplayKey(identity),
        subtitle,
        isError: tool.isError === true,
        status: tool.status,
        identity,
      });
      continue;
    }

    const existing = entries[existingIndex];
    existing.subtitle = subtitle;
    existing.isError = existing.isError || tool.isError === true;
    existing.status = mergeStatus(existing.status, tool.status);
    existing.identity = mergeIdentity(existing.identity, identity);
    existing.key = getDisplayKey(existing.identity);
    entries.splice(existingIndex, 1);
    entries.push(existing);
  }

  return entries;
}

function getToolNoun(toolName: string): string {
  switch (toolName) {
    case 'Read':
      return 'file';
    case 'Grep':
      return 'search';
    case 'Glob':
      return 'pattern';
    case 'LS':
      return 'directory';
    case 'WebSearch':
      return 'search';
    case 'FetchUrl':
      return 'URL';
    default:
      return 'item';
  }
}

function pluralize(noun: string, count: number): string {
  if (count === 1) return noun;
  if (noun === 'search') return 'searches';
  if (noun === 'directory') return 'directories';
  return `${noun}s`;
}

export function CollapsedToolGroupComponent({
  group,
  compact = false,
}: CollapsedToolGroupProps) {
  const { tools, toolName } = group;
  const displayEntries = buildDisplayEntries(tools);
  const count = displayEntries.length;
  const errorCount = displayEntries.filter((entry) => entry.isError).length;
  const _isLoading = tools.some(
    (t) =>
      t.status === ToolCallStatus.Executing ||
      t.status === ToolCallStatus.Pending
  );

  const displayName = getDisplayNameForTool(toolName);
  const noun = getToolNoun(toolName);

  // In compact mode: find the most recent executing/pending tool
  const activeEntry = compact
    ? displayEntries.findLast((entry) => isActiveStatus(entry.status))
    : undefined;

  if (compact) {
    const activeSubtitle = activeEntry?.subtitle ?? null;

    return (
      <Box flexDirection="row" marginLeft={3}>
        <Box flexGrow={1} flexDirection="column">
          <Box flexDirection="row">
            <Text color={TOOL_NAME_COLOR} bold>
              {displayName}
            </Text>
            <Text color={TOOL_COLOR}>
              {' '}
              {count} {pluralize(noun, count)}
            </Text>
            {errorCount > 0 && (
              <Text color={COLORS.error}>
                {` (${getI18n().t('common:toolDisplay.countFailed', { count: errorCount })})`}
              </Text>
            )}
          </Box>
          {activeSubtitle && (
            <Box marginLeft={1}>
              <Text color={COLORS.text.muted}>
                {'↳ '}
                {truncateSubtitle(activeSubtitle, toolName)}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  // Expanded mode: sliding window of last 8 items
  const entriesWithSubtitles = displayEntries.filter((entry) => entry.subtitle);

  const totalItems = entriesWithSubtitles.length;
  const overflowCount = totalItems - MAX_PREVIEW_ITEMS;
  const visibleEntries =
    totalItems > MAX_PREVIEW_ITEMS
      ? entriesWithSubtitles.slice(-MAX_PREVIEW_ITEMS)
      : entriesWithSubtitles;

  return (
    <Box flexDirection="row" marginLeft={3}>
      <Box flexGrow={1} flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text color={TOOL_NAME_COLOR} bold>
            {displayName}
          </Text>
          <Text color={TOOL_COLOR}>
            {' '}
            {count} {pluralize(noun, count)}
          </Text>
          {overflowCount > 0 && (
            <Text color={COLORS.text.muted}>
              {'   '}
              {getI18n().t('common:toolDisplay.ctrlOToViewAll')}
            </Text>
          )}
        </Box>
        <Box flexDirection="column" marginLeft={1}>
          {visibleEntries.map((entry, index) => {
            const subtitle = entry.subtitle!;
            return (
              <Text key={entry.key} color={COLORS.text.muted}>
                {index === 0 ? '↳ ' : '  '}
                {truncateSubtitle(subtitle, toolName)}
                {entry.isError ? (
                  <Text color={COLORS.error}>
                    {' '}
                    {getI18n().t('common:toolDisplay.errorSuffix')}
                  </Text>
                ) : null}
              </Text>
            );
          })}
          {errorCount > 0 && (
            <Text color={COLORS.error}>
              {errorCount} {pluralize(noun, errorCount)}{' '}
              {getI18n().t('common:toolDisplay.failedSuffix')}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
