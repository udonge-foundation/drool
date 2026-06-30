import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { KeypressLayer } from '@/contexts/enums';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { SessionMetadata } from '@/services/types';
import { displayWidth as getDisplayWidth } from '@/utils/displayWidth';
import { formatRelativeTime } from '@/utils/formatRelativeTime';
import { cleanPastedText } from '@/utils/pasteHandler';

// Maximum number of rows to display at once
const VISIBLE_COUNT = 10;
const MENU_HORIZONTAL_CHROME_WIDTH = 4;
const ROW_MARKER_COLUMN_WIDTH = 2;
const COLUMN_GAP = 1;
const TITLE_PATH_GAP = 2;
const SIZE_COLUMN_WIDTH = 6;
const MIN_TITLE_COLUMN_WIDTH = 16;
const MIN_PATH_COLUMN_WIDTH = 4;
const MAX_PATH_COLUMN_SHARE = 0.4;

type SessionTab = 'currentFolder' | 'all' | 'exec' | 'favorites';
type SessionListMode = 'browse' | 'rename' | 'archive-confirm';

interface SessionListColumnWidthParams {
  terminalWidth: number;
  timeColumnWidth: number;
  showPath: boolean;
  maxPathWidth: number;
}

interface SessionListColumnWidths {
  titleColumnWidth: number;
  pathColumnWidth: number;
}

export function getSessionListColumnWidths({
  terminalWidth,
  timeColumnWidth,
  showPath,
  maxPathWidth,
}: SessionListColumnWidthParams): SessionListColumnWidths {
  const fixedColumnsWidth =
    ROW_MARKER_COLUMN_WIDTH +
    timeColumnWidth +
    COLUMN_GAP +
    timeColumnWidth +
    COLUMN_GAP +
    SIZE_COLUMN_WIDTH +
    COLUMN_GAP;
  const flexibleWidth = Math.max(
    terminalWidth - MENU_HORIZONTAL_CHROME_WIDTH - fixedColumnsWidth,
    MIN_TITLE_COLUMN_WIDTH
  );

  if (!showPath) {
    return { titleColumnWidth: flexibleWidth, pathColumnWidth: 0 };
  }

  const titleAndPathWidth = Math.max(
    flexibleWidth - TITLE_PATH_GAP,
    MIN_TITLE_COLUMN_WIDTH + MIN_PATH_COLUMN_WIDTH
  );
  const pathShareLimit = Math.max(
    MIN_PATH_COLUMN_WIDTH,
    Math.floor(titleAndPathWidth * MAX_PATH_COLUMN_SHARE)
  );
  const pathTitleReserveLimit = Math.max(
    MIN_PATH_COLUMN_WIDTH,
    titleAndPathWidth - MIN_TITLE_COLUMN_WIDTH
  );
  const pathColumnWidth = Math.min(
    Math.max(maxPathWidth, MIN_PATH_COLUMN_WIDTH),
    pathShareLimit,
    pathTitleReserveLimit
  );

  return {
    titleColumnWidth: titleAndPathWidth - pathColumnWidth,
    pathColumnWidth,
  };
}

interface SessionListProps {
  sessions: SessionMetadata[];
  currentSessionId?: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  onArchive?: (sessionId: string) => Promise<void>;
  onRename?: (sessionId: string, newTitle: string) => Promise<void>;
  onModeChange?: (mode: SessionListMode) => void;
}

export function SessionList({
  sessions,
  currentSessionId,
  onSelect,
  onCancel,
  onArchive,
  onRename,
  onModeChange,
}: SessionListProps) {
  const { t } = useTranslation('common');
  const { width: terminalWidth } = useTerminalDimensions();
  const [selectedTab, setSelectedTab] = useState<SessionTab>('currentFolder');

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [hasUserMovedSelection, setHasUserMovedSelection] = useState(false);
  const [mode, setMode] = useState<SessionListMode>('browse');
  const [archiveSessionId, setArchiveSessionId] = useState<string | null>(null);
  const [archiveSessionTitle, setArchiveSessionTitle] = useState('');
  const [isArchiving, setIsArchiving] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renamePlaceholder, setRenamePlaceholder] = useState('');
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const hasHandledInitialCatchupRefreshRef = useRef(false);
  const previousSessionsOrderKeyRef = useRef<string | null>(null);

  // Filter sessions based on selected tab and search query
  const displaySessions = useMemo(() => {
    let filtered: SessionMetadata[];

    // Apply tab filter
    switch (selectedTab) {
      case 'currentFolder':
        filtered = sessions.filter((s) => s.isCurrentProject && !s.isExec);
        break;
      case 'exec':
        filtered = sessions.filter((s) => s.isExec);
        break;
      case 'favorites':
        filtered = sessions.filter((s) => s.isFavorite && !s.isExec);
        break;
      case 'all':
      default:
        filtered = sessions.filter((s) => !s.isExec);
    }

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((s) => {
        const summary = s.title.toLowerCase();
        const sessionTitle = (s.sessionTitle ?? '').toLowerCase();
        return summary.includes(query) || sessionTitle.includes(query);
      });
    }

    return filtered;
  }, [sessions, selectedTab, searchQuery]);

  // Calculate column widths for relative time columns.
  // Compute max display width of all relative time strings to handle CJK.
  const timeColumnWidth = useMemo(() => {
    let maxWidth = 8; // minimum column width for 'Modified'/'Created' header
    for (const session of displaySessions) {
      const modWidth = getDisplayWidth(
        formatRelativeTime(session.modifiedTime)
      );
      const creWidth = getDisplayWidth(formatRelativeTime(session.createdTime));
      if (modWidth > maxWidth) maxWidth = modWidth;
      if (creWidth > maxWidth) maxWidth = creWidth;
    }
    // Add 1 for spacing
    return maxWidth + 1;
  }, [displaySessions]);

  // Whether to show path column (All/Exec/Favorites tabs)
  const showPath = selectedTab !== 'currentFolder';

  // Size the path column from the current tab, but reserve most wide-terminal
  // growth for titles so long paths don't starve the title column.
  const maxPathWidth = useMemo(() => {
    let maxW = 4; // minimum for "Path" header
    for (const session of displaySessions) {
      if (session.cwd) {
        const w = getDisplayWidth(session.cwd);
        if (w > maxW) maxW = w;
      }
    }
    return maxW;
  }, [displaySessions]);
  const { titleColumnWidth, pathColumnWidth } = getSessionListColumnWidths({
    terminalWidth,
    timeColumnWidth,
    showPath,
    maxPathWidth,
  });

  const sessionsOrderKey = useMemo(
    () => sessions.map((session) => session.id).join('\u0000'),
    [sessions]
  );

  useEffect(() => {
    setSelectedSessionId(null);
  }, [searchQuery, selectedTab]);

  useEffect(() => {
    if (previousSessionsOrderKeyRef.current === null) {
      previousSessionsOrderKeyRef.current = sessionsOrderKey;
      return;
    }

    if (previousSessionsOrderKeyRef.current === sessionsOrderKey) {
      return;
    }

    previousSessionsOrderKeyRef.current = sessionsOrderKey;

    if (hasHandledInitialCatchupRefreshRef.current) {
      return;
    }

    hasHandledInitialCatchupRefreshRef.current = true;

    if (!hasUserMovedSelection) {
      setSelectedSessionId(null);
    }
  }, [hasUserMovedSelection, sessionsOrderKey]);

  useEffect(() => {
    if (displaySessions.length === 0) {
      if (selectedSessionId !== null) {
        setSelectedSessionId(null);
      }
      return;
    }

    if (
      selectedSessionId === null ||
      !displaySessions.some((session) => session.id === selectedSessionId)
    ) {
      setSelectedSessionId(displaySessions[0]?.id ?? null);
    }
  }, [displaySessions, selectedSessionId]);

  const selectedIndex =
    selectedSessionId && displaySessions.length > 0
      ? Math.max(
          0,
          displaySessions.findIndex(
            (session) => session.id === selectedSessionId
          )
        )
      : 0;

  // Ctrl+R handler - enter rename mode
  const handleCtrlR = useCallback(() => {
    if (mode !== 'browse') return;
    if (displaySessions.length > 0 && displaySessions[selectedIndex]) {
      const session = displaySessions[selectedIndex];
      setRenamePlaceholder(session.sessionTitle ?? t('sessions.untitled'));
      setRenameValue('');
      setRenameSessionId(session.id);
      setMode('rename');
      onModeChange?.('rename');
    }
  }, [mode, displaySessions, selectedIndex, onModeChange]);

  // Ctrl+X handler - enter archive confirmation mode
  const handleCtrlX = useCallback(() => {
    if (mode !== 'browse') return;
    if (displaySessions.length > 0 && displaySessions[selectedIndex]) {
      const session = displaySessions[selectedIndex];
      setArchiveSessionId(session.id);
      setArchiveSessionTitle(session.sessionTitle ?? t('sessions.untitled'));
      setMode('archive-confirm');
      onModeChange?.('archive-confirm');
    }
  }, [mode, displaySessions, selectedIndex, onModeChange]);

  // Exit archive confirmation mode
  const exitArchiveMode = useCallback(() => {
    setMode('browse');
    setArchiveSessionId(null);
    setArchiveSessionTitle('');
    setIsArchiving(false);
    onModeChange?.('browse');
  }, [onModeChange]);

  // Exit rename mode
  const exitRenameMode = useCallback(() => {
    setMode('browse');
    setRenameValue('');
    setRenamePlaceholder('');
    setRenameSessionId(null);
    setIsRenaming(false);
    onModeChange?.('browse');
  }, [onModeChange]);

  // Submit rename
  const handleRenameSubmit = useCallback(async () => {
    if (!renameSessionId || isRenaming) return;

    // Use input value, or fall back to placeholder (original title) if empty
    const newTitle = renameValue.trim() || renamePlaceholder;
    if (!newTitle || !onRename) {
      exitRenameMode();
      return;
    }

    setIsRenaming(true);
    try {
      await onRename(renameSessionId, newTitle);
    } finally {
      exitRenameMode();
    }
  }, [
    renameSessionId,
    onRename,
    isRenaming,
    renameValue,
    renamePlaceholder,
    exitRenameMode,
  ]);

  // Submit archive
  const handleArchiveConfirm = useCallback(async () => {
    if (!archiveSessionId || isArchiving || !onArchive) {
      exitArchiveMode();
      return;
    }

    setIsArchiving(true);
    try {
      await onArchive(archiveSessionId);
    } finally {
      exitArchiveMode();
    }
  }, [archiveSessionId, isArchiving, onArchive, exitArchiveMode]);

  // Helper to get next tab in cycle
  const getNextTab = (current: SessionTab): SessionTab => {
    switch (current) {
      case 'currentFolder':
        return 'all';
      case 'all':
        return 'exec';
      case 'exec':
        return 'favorites';
      case 'favorites':
        return 'currentFolder';
      default:
        return 'currentFolder';
    }
  };

  // Handle keyboard navigation via KeypressProvider
  useKeypressHandler(
    (input, key) => {
      // In rename mode, handle Escape to exit
      if (mode === 'rename') {
        if (matchKeyboardChord({ key, input }, 'escape')) {
          exitRenameMode();
          return true;
        }
        // Block all other keys in rename mode - TextInput handles the rest
        return false;
      }

      // In archive-confirm mode, handle Enter/Escape only
      if (mode === 'archive-confirm') {
        if (matchKeyboardChord({ key, input }, 'escape')) {
          exitArchiveMode();
          return true;
        }
        if (matchKeyboardChord({ key, input }, 'enter')) {
          void handleArchiveConfirm();
          return true;
        }
        return false;
      }

      // Browse mode inputs
      if (matchKeyboardChord({ key, input }, 'escape') || input === 'q') {
        onCancel();
        return true;
      }

      // Ctrl+X to enter archive confirmation mode
      if (matchKeyboardChord({ key, input }, 'ctrl-x')) {
        handleCtrlX();
        return true;
      }

      // Ctrl+R to enter rename mode
      if (matchKeyboardChord({ key, input }, 'ctrl-r')) {
        handleCtrlR();
        return true;
      }

      if (matchKeyboardChord({ key, input }, 'enter')) {
        if (displaySessions.length > 0 && displaySessions[selectedIndex]) {
          onSelect(displaySessions[selectedIndex].id);
          return true;
        }
        return false;
      }

      if (matchKeyboardChord({ key, input }, 'up-arrow')) {
        setSelectedSessionId((prevSessionId) => {
          const currentIndex =
            prevSessionId && displaySessions.length > 0
              ? Math.max(
                  0,
                  displaySessions.findIndex(
                    (session) => session.id === prevSessionId
                  )
                )
              : 0;
          const nextIndex = Math.max(0, currentIndex - 1);
          const nextSessionId = displaySessions[nextIndex]?.id ?? null;
          if (nextSessionId !== null && nextSessionId !== prevSessionId) {
            setHasUserMovedSelection(true);
          }
          return nextSessionId;
        });
        return true;
      }

      if (matchKeyboardChord({ key, input }, 'down-arrow')) {
        setSelectedSessionId((prevSessionId) => {
          const currentIndex =
            prevSessionId && displaySessions.length > 0
              ? Math.max(
                  0,
                  displaySessions.findIndex(
                    (session) => session.id === prevSessionId
                  )
                )
              : 0;
          const nextIndex = Math.min(
            displaySessions.length - 1,
            currentIndex + 1
          );
          const nextSessionId = displaySessions[nextIndex]?.id ?? null;
          if (nextSessionId !== null && nextSessionId !== prevSessionId) {
            setHasUserMovedSelection(true);
          }
          return nextSessionId;
        });
        return true;
      }

      if (matchKeyboardChord({ key, input }, 'tab')) {
        setSelectedTab((prev) => getNextTab(prev));
        return true;
      }

      return false;
    },
    { layer: KeypressLayer.Navigation }
  );

  // Handle search input changes
  const handleSearchChange = (value: string) => {
    setSearchQuery(cleanPastedText(value));
  };

  // Anchor selection at the 8th row (index 7) when scrolling down
  const anchorRow = 7;
  const { windowStart, visibleItems: visibleSlice } = getWindowedListSlice({
    items: displaySessions,
    selectedIndex,
    visibleCount: VISIBLE_COUNT,
    anchorRow,
  });
  const end = Math.min(
    windowStart + visibleSlice.length,
    displaySessions.length
  );

  return (
    <MenuContainer
      title={t('sessions.titleGeneric')}
      titleBold={false}
      width={terminalWidth}
      headerRight={
        <Box>
          <Text
            color={
              selectedTab === 'currentFolder'
                ? COLORS.primary
                : COLORS.text.muted
            }
          >
            {selectedTab === 'currentFolder' ? '◉' : '○'}{' '}
            {t('sessions.tabs.currentFolder')}
          </Text>
          <Text color={COLORS.text.muted}> | </Text>
          <Text
            color={selectedTab === 'all' ? COLORS.primary : COLORS.text.muted}
          >
            {selectedTab === 'all' ? '◉' : '○'} {t('sessions.tabs.all')}
          </Text>
          <Text color={COLORS.text.muted}> | </Text>
          <Text
            color={selectedTab === 'exec' ? COLORS.primary : COLORS.text.muted}
          >
            {selectedTab === 'exec' ? '◉' : '○'} {t('sessions.tabs.exec')}
          </Text>
          <Text color={COLORS.text.muted}> | </Text>
          <Text
            color={
              selectedTab === 'favorites' ? COLORS.primary : COLORS.text.muted
            }
          >
            {selectedTab === 'favorites' ? '◉' : '○'}{' '}
            {t('sessions.tabs.favorites')}
          </Text>
        </Box>
      }
      helpText={
        mode === 'rename'
          ? t('sessions.helpRename')
          : mode === 'archive-confirm'
            ? t('sessions.helpArchiveConfirm')
            : t('sessions.helpBrowseShort')
      }
      helpRight={
        mode === 'browse'
          ? displaySessions.length === 0
            ? t('sessions.rangeEmpty')
            : `${windowStart + 1}-${end} of ${displaySessions.length}`
          : undefined
      }
      showDefaultHelp={false}
    >
      {/* Search input - disabled when in rename/archive-confirm mode */}
      <Box marginBottom={1}>
        {mode === 'browse' ? (
          <TextInput
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder={t('sessions.searchPlaceholder')}
          />
        ) : (
          <Text color={COLORS.text.muted}>
            {searchQuery || t('sessions.searchPlaceholder')}
          </Text>
        )}
      </Box>

      {/* Column headers */}
      <Box marginTop={0} marginBottom={1}>
        <Box width={ROW_MARKER_COLUMN_WIDTH}>
          <Text> </Text>
        </Box>
        <Box width={timeColumnWidth} marginRight={COLUMN_GAP}>
          <Text color={COLORS.text.muted}>
            {t('sessions.columns.modified')}
          </Text>
        </Box>
        <Box width={timeColumnWidth} marginRight={COLUMN_GAP}>
          <Text color={COLORS.text.muted}>{t('sessions.columns.created')}</Text>
        </Box>
        <Box width={SIZE_COLUMN_WIDTH} marginRight={COLUMN_GAP}>
          <Text color={COLORS.text.muted}>{t('sessions.columns.size')}</Text>
        </Box>
        <Box
          width={titleColumnWidth}
          marginRight={showPath ? TITLE_PATH_GAP : 0}
        >
          <Text color={COLORS.text.muted}>{t('sessions.columns.title')}</Text>
        </Box>
        {showPath && (
          <Box width={pathColumnWidth}>
            <Text color={COLORS.text.muted}>{t('sessions.columns.path')}</Text>
          </Box>
        )}
      </Box>

      {/* Session list area (fixed-height) */}
      <Box flexDirection="column" height={VISIBLE_COUNT}>
        {/* Empty state when search yields no results */}
        {displaySessions.length === 0 && searchQuery.trim() && (
          <Box>
            <Text color={COLORS.text.muted}>
              {t('sessions.noMatchSearch', { query: searchQuery.trim() })}
            </Text>
          </Box>
        )}

        {/* Session list */}
        {visibleSlice.map((session, index) => {
          const globalIndex = windowStart + index;
          const isSelected = globalIndex === selectedIndex;
          const color: string | undefined = isSelected
            ? COLORS.text.primary
            : COLORS.text.muted;

          const isCurrent = session.id === currentSessionId;

          return (
            <Box key={session.id} flexDirection="row">
              <Box>
                <Box width={ROW_MARKER_COLUMN_WIDTH}>
                  <Text color={isCurrent ? COLORS.primary : undefined}>
                    {isCurrent ? '●' : ' '}
                  </Text>
                </Box>
                <Box width={timeColumnWidth} marginRight={COLUMN_GAP}>
                  <Text bold={isSelected} color={color}>
                    {formatRelativeTime(session.modifiedTime)}
                  </Text>
                </Box>
                <Box width={timeColumnWidth} marginRight={COLUMN_GAP}>
                  <Text bold={isSelected} color={color}>
                    {formatRelativeTime(session.createdTime)}
                  </Text>
                </Box>
                <Box width={SIZE_COLUMN_WIDTH} marginRight={COLUMN_GAP}>
                  <Text bold={isSelected} color={color}>
                    {session.messageCount}
                  </Text>
                </Box>
                <Box
                  width={titleColumnWidth}
                  marginRight={showPath ? TITLE_PATH_GAP : 0}
                >
                  <Text bold={isSelected} color={color} wrap="truncate-end">
                    {session.sessionTitle ?? t('sessions.untitled')}
                  </Text>
                </Box>
                {showPath && (
                  <Box width={pathColumnWidth}>
                    <Text bold={isSelected} color={color} wrap="truncate-end">
                      {session.cwd ?? ''}
                    </Text>
                  </Box>
                )}
              </Box>
            </Box>
          );
        })}

        {/* Pad empty slots to maintain fixed height */}
        {Array.from({
          length: Math.max(
            0,
            VISIBLE_COUNT -
              visibleSlice.length -
              (displaySessions.length === 0 && searchQuery.trim() ? 1 : 0)
          ),
        }).map((_, i) => (
          <Box key={`empty-${i}`} height={1}>
            <Text> </Text>
          </Box>
        ))}
      </Box>

      {/* Rename input - shown when in rename mode */}
      {mode === 'rename' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.text.muted}>
            {isRenaming ? t('sessions.saving') : t('sessions.renameLabel')}
          </Text>
          <Box marginTop={0}>
            <TextInput
              value={renameValue}
              onChange={setRenameValue}
              placeholder={renamePlaceholder}
              onSubmit={handleRenameSubmit}
            />
          </Box>
        </Box>
      )}

      {/* Archive confirmation prompt */}
      {mode === 'archive-confirm' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.text.muted}>
            {isArchiving
              ? t('sessions.archiving')
              : t('sessions.archivePrompt')}
          </Text>
          {!isArchiving && (
            <Text color={COLORS.text.muted}>
              {t('sessions.archiveDescription', { title: archiveSessionTitle })}
            </Text>
          )}
        </Box>
      )}
    </MenuContainer>
  );
}
