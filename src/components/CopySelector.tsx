import { Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { MenuContainer } from '@/components/common/MenuContainer';
import { CopyQuickItem, CopySelectionKind } from '@/components/enums';
import type { CopySelectorProps } from '@/components/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';
import type { ConversationTurn } from '@/utils/types';

// Cap the turn submenu viewport to a small, fixed window so the overlay's
// dynamic area stays compact. Turns outside the window are reachable by
// arrowing up/down — the windowed slice scrolls under the cursor.
const VISIBLE_TURN_ROWS = 5;

const I18N_KEYS = {
  title: 'commands:slashMessages.copySelector.title',
  rangeTitle: 'commands:slashMessages.copySelector.rangeTitle',
  helpText: 'commands:slashMessages.copySelector.helpText',
  helpTextRange: 'commands:slashMessages.copySelector.helpTextRange',
  lastAssistant: 'commands:slashMessages.copySelector.lastAssistant',
  lastUser: 'commands:slashMessages.copySelector.lastUser',
  sessionId: 'commands:slashMessages.copySelector.sessionId',
  fullTranscript: 'commands:slashMessages.copySelector.fullTranscript',
  selectRange: 'commands:slashMessages.copySelector.selectRange',
  unavailable: 'commands:slashMessages.copySelector.unavailable',
  anchorBadge: 'commands:slashMessages.copySelector.anchorBadge',
  userPrefix: 'commands:slashMessages.copySelector.userPrefix',
  assistantPrefix: 'commands:slashMessages.copySelector.assistantPrefix',
  emptyUser: 'commands:slashMessages.copySelector.emptyUser',
  emptyAssistant: 'commands:slashMessages.copySelector.emptyAssistant',
  anchorIndicator: 'commands:slashMessages.copySelector.anchorIndicator',
  turnLabel: 'commands:slashMessages.copySelector.turnLabel',
  paginationInfo: 'commands:slashMessages.copySelector.paginationInfo',
};

const PREVIEW_SANITIZE_OPTIONS = { stripSgr: true } as const;

// `•` marks turns inside a pending range; blank prefixes keep rows aligned.
const IN_RANGE_PREFIX = '• ';
const BLANK_PREFIX = '  ';

type QuickRow = {
  kind: 'quick';
  item: CopyQuickItem;
  disabled: boolean;
  label: string;
};
type ActionRow = {
  kind: 'action';
  action: 'open-range';
  disabled: boolean;
  label: string;
};
type TurnRow = { kind: 'turn'; turn: ConversationTurn };
type Row = QuickRow | ActionRow | TurnRow;

type View = 'main' | 'range';

function buildQuickRows(args: {
  hasLastAssistant: boolean;
  hasLastUser: boolean;
  hasSessionId: boolean;
  labels: {
    lastAssistant: string;
    lastUser: string;
    sessionId: string;
    fullTranscript: string;
  };
  hasTurns: boolean;
}): QuickRow[] {
  const { hasLastAssistant, hasLastUser, hasSessionId, hasTurns, labels } =
    args;
  return [
    {
      kind: 'quick',
      item: CopyQuickItem.LastAssistant,
      disabled: !hasLastAssistant,
      label: labels.lastAssistant,
    },
    {
      kind: 'quick',
      item: CopyQuickItem.LastUser,
      disabled: !hasLastUser,
      label: labels.lastUser,
    },
    {
      kind: 'quick',
      item: CopyQuickItem.SessionId,
      disabled: !hasSessionId,
      label: labels.sessionId,
    },
    {
      kind: 'quick',
      item: CopyQuickItem.FullTranscript,
      disabled: !hasTurns,
      label: labels.fullTranscript,
    },
  ];
}

function isRowSelectable(row: Row): boolean {
  if (row.kind === 'turn') return true;
  return !row.disabled;
}

function findFirstSelectableIndex(rows: Row[]): number {
  for (let i = 0; i < rows.length; i++) {
    if (isRowSelectable(rows[i])) return i;
  }
  return 0;
}

export function CopySelector({
  turns,
  hasLastAssistant,
  hasLastUser,
  hasSessionId,
  onSelect,
  onCancel,
}: CopySelectorProps) {
  const { t } = useTranslation();

  const quickRows: QuickRow[] = useMemo(
    () =>
      buildQuickRows({
        hasLastAssistant,
        hasLastUser,
        hasSessionId,
        hasTurns: turns.length > 0,
        labels: {
          lastAssistant: t(I18N_KEYS.lastAssistant),
          lastUser: t(I18N_KEYS.lastUser),
          sessionId: t(I18N_KEYS.sessionId),
          fullTranscript: t(I18N_KEYS.fullTranscript),
        },
      }),
    [hasLastAssistant, hasLastUser, hasSessionId, turns.length, t]
  );

  // Newest first for display.
  const turnRowsDesc: TurnRow[] = useMemo(
    () => [...turns].reverse().map((turn) => ({ kind: 'turn', turn })),
    [turns]
  );

  // Flat fifth row: "Select range (N turns)". Only offered when there are
  // turns to pick from; otherwise it'd just be dead weight in the quick list.
  const rangeActionRow: ActionRow | null = useMemo(
    () =>
      turnRowsDesc.length > 0
        ? {
            kind: 'action',
            action: 'open-range',
            disabled: false,
            label: t(I18N_KEYS.selectRange, { count: turnRowsDesc.length }),
          }
        : null,
    [turnRowsDesc.length, t]
  );

  const [view, setView] = useState<View>('main');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [anchorTurn, setAnchorTurn] = useState<number | null>(null);

  const rows: Row[] = useMemo(
    () =>
      view === 'main'
        ? [...quickRows, ...(rangeActionRow ? [rangeActionRow] : [])]
        : turnRowsDesc,
    [view, quickRows, rangeActionRow, turnRowsDesc]
  );

  // Keep selectedIndex within bounds and on a selectable row when the row
  // list changes (e.g. turns load asynchronously, view switches).
  const clampedIndex = useMemo(() => {
    if (rows.length === 0) return 0;
    if (selectedIndex >= rows.length) return findFirstSelectableIndex(rows);
    if (!isRowSelectable(rows[selectedIndex]))
      return findFirstSelectableIndex(rows);
    return selectedIndex;
  }, [rows, selectedIndex]);

  const moveSelection = (direction: 1 | -1) => {
    setSelectedIndex((prev) => {
      // Re-base to the first selectable row when `prev` itself isn't
      // selectable (e.g. a disabled quick row the cursor was initialised
      // on). Without this, the first arrow keypress only syncs state with
      // the already-rendered clamped position and the cursor appears to
      // eat one keypress. Mirrors the guard in `clampedIndex`.
      const prevRow = rows[prev];
      const base =
        prev >= rows.length || !prevRow || !isRowSelectable(prevRow)
          ? findFirstSelectableIndex(rows)
          : prev;
      let next = base + direction;
      while (next >= 0 && next < rows.length) {
        if (isRowSelectable(rows[next])) return next;
        next += direction;
      }
      return base;
    });
  };

  const openRangeView = () => {
    setView('range');
    setSelectedIndex(0);
    setAnchorTurn(null);
  };

  const returnToMainView = () => {
    setView('main');
    setAnchorTurn(null);
    // Park the cursor back on the "Select range" row so re-entry is one Enter.
    setSelectedIndex(quickRows.length);
  };

  const commitSelection = () => {
    const row = rows[clampedIndex];
    if (!row || !isRowSelectable(row)) return;
    if (row.kind === 'quick') {
      onSelect({ kind: CopySelectionKind.Quick, quickItem: row.item });
      return;
    }
    if (row.kind === 'action' && row.action === 'open-range') {
      openRangeView();
      return;
    }
    if (row.kind === 'turn') {
      const cursor = row.turn.turnNumber;
      const anchor = anchorTurn ?? cursor;
      const lo = Math.min(anchor, cursor);
      const hi = Math.max(anchor, cursor);
      onSelect({
        kind: CopySelectionKind.Range,
        rangeStart: lo,
        rangeEnd: hi,
      });
    }
  };

  const toggleAnchor = () => {
    if (view !== 'range') return;
    const row = rows[clampedIndex];
    if (!row || row.kind !== 'turn') return;
    setAnchorTurn((current) =>
      current === row.turn.turnNumber ? null : row.turn.turnNumber
    );
  };

  useKeypressHandler((input, key) => {
    if (key.escape || input === 'q') {
      // In the range submenu Esc pops back to the main list; a second Esc
      // (now in main view) closes the overlay entirely.
      if (view === 'range') {
        returnToMainView();
      } else {
        onCancel();
      }
      return;
    }
    if (key.return) {
      commitSelection();
      return;
    }
    if (key.upArrow || input === 'k') {
      moveSelection(-1);
      return;
    }
    if (key.downArrow || input === 'j') {
      moveSelection(1);
      return;
    }
    if (input === ' ') {
      toggleAnchor();
    }
  });

  // Windowed view into the turn list while in range view.
  const turnWindow = getWindowedListSlice({
    items: turnRowsDesc,
    selectedIndex: view === 'range' ? clampedIndex : 0,
    visibleCount: VISIBLE_TURN_ROWS,
    anchorRow: 3,
  });

  const selectedRow = rows[clampedIndex];
  const selectedTurnNumber =
    view === 'range' && selectedRow?.kind === 'turn'
      ? selectedRow.turn.turnNumber
      : null;

  const helpText =
    view === 'main' ? t(I18N_KEYS.helpText) : t(I18N_KEYS.helpTextRange);

  const headerRight =
    view === 'range' && anchorTurn != null ? (
      <Text color={COLORS.text.helpLabel}>
        {t(I18N_KEYS.anchorIndicator, { turn: anchorTurn })}
      </Text>
    ) : undefined;

  const rangeLow =
    anchorTurn != null && selectedTurnNumber != null
      ? Math.min(anchorTurn, selectedTurnNumber)
      : null;
  const rangeHigh =
    anchorTurn != null && selectedTurnNumber != null
      ? Math.max(anchorTurn, selectedTurnNumber)
      : null;

  const title = view === 'main' ? t(I18N_KEYS.title) : t(I18N_KEYS.rangeTitle);

  return (
    <MenuContainer
      title={title}
      titleBold={false}
      helpText={helpText}
      headerRight={headerRight}
      showDefaultHelp={false}
    >
      {view === 'main' && (
        <>
          {quickRows.map((row, index) => {
            const isSelected = index === clampedIndex;
            const labelColor = row.disabled
              ? COLORS.text.muted
              : isSelected
                ? COLORS.text.primary
                : COLORS.text.muted;
            return (
              <Box key={`quick-${row.item}`}>
                <Text
                  color={labelColor}
                  bold={isSelected && !row.disabled}
                  dimColor={row.disabled}
                >
                  {row.label}
                </Text>
                {row.disabled && (
                  <Text color={COLORS.text.muted}>
                    {' '}
                    {t(I18N_KEYS.unavailable)}
                  </Text>
                )}
              </Box>
            );
          })}

          {rangeActionRow &&
            (() => {
              const index = quickRows.length;
              const isSelected = index === clampedIndex;
              const labelColor = isSelected
                ? COLORS.text.primary
                : COLORS.text.muted;
              return (
                <Box key="action-open-range">
                  <Text color={labelColor} bold={isSelected}>
                    {rangeActionRow.label}
                  </Text>
                </Box>
              );
            })()}
        </>
      )}

      {view === 'range' && (
        <Box flexDirection="column">
          {turnWindow.visibleItems.map((row, visibleIndex) => {
            const rowIndex = turnWindow.windowStart + visibleIndex;
            const isSelected = rowIndex === clampedIndex;
            const inRange =
              rangeLow !== null &&
              rangeHigh !== null &&
              row.turn.turnNumber >= rangeLow &&
              row.turn.turnNumber <= rangeHigh;
            const isAnchor = anchorTurn === row.turn.turnNumber;
            const prefix = inRange ? IN_RANGE_PREFIX : BLANK_PREFIX;
            const prefixColor = inRange ? COLORS.highlight : COLORS.text.muted;
            const labelColor = isSelected
              ? COLORS.text.primary
              : inRange
                ? COLORS.highlight
                : COLORS.text.muted;
            const previewColor = isSelected
              ? COLORS.text.primary
              : inRange
                ? COLORS.highlight
                : COLORS.text.secondary;
            const userPrev = sanitizeTerminalDisplayText(
              row.turn.userPreview || t(I18N_KEYS.emptyUser),
              PREVIEW_SANITIZE_OPTIONS
            );
            const assistantPrev = sanitizeTerminalDisplayText(
              row.turn.assistantPreview || t(I18N_KEYS.emptyAssistant),
              PREVIEW_SANITIZE_OPTIONS
            );
            return (
              <Box
                key={`turn-${row.turn.turnNumber}`}
                flexDirection="column"
                marginBottom={0}
              >
                <Box>
                  <Text color={prefixColor}>{prefix}</Text>
                  <Text color={labelColor} bold={isSelected}>
                    {t(I18N_KEYS.turnLabel, {
                      turn: row.turn.turnNumber,
                    })}
                    {isAnchor ? ` ${t(I18N_KEYS.anchorBadge)}` : ''}
                  </Text>
                </Box>
                <Box marginLeft={2}>
                  <Text color={COLORS.text.muted}>
                    {t(I18N_KEYS.userPrefix)}{' '}
                  </Text>
                  <Text color={previewColor}>{userPrev}</Text>
                </Box>
                <Box marginLeft={2}>
                  <Text color={COLORS.text.muted}>
                    {t(I18N_KEYS.assistantPrefix)}{' '}
                  </Text>
                  <Text color={previewColor}>{assistantPrev}</Text>
                </Box>
              </Box>
            );
          })}
          {turnRowsDesc.length > VISIBLE_TURN_ROWS &&
            turnWindow.visibleItems.length > 0 &&
            (() => {
              // Report pagination in turn-number space (what the user sees
              // on each row), not reversed-array-index space. The turn list
              // is newest-first, so the oldest visible turn number is the
              // smaller of the two endpoints and the newest is the larger.
              const first = turnWindow.visibleItems[0].turn.turnNumber;
              const last =
                turnWindow.visibleItems[turnWindow.visibleItems.length - 1].turn
                  .turnNumber;
              const lo = Math.min(first, last);
              const hi = Math.max(first, last);
              return (
                <Box marginTop={1}>
                  <Text color={COLORS.text.muted}>
                    {t(I18N_KEYS.paginationInfo, {
                      start: lo,
                      end: hi,
                      total: turnRowsDesc.length,
                    })}
                  </Text>
                </Box>
              );
            })()}
        </Box>
      )}
    </MenuContainer>
  );
}
