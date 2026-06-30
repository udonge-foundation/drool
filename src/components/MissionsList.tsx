import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MissionState } from '@industry/drool-sdk-ext/protocol/drool';

import { COLORS } from '@/components/chat/themedColors';
import { computeTitlePathColumnWidths } from '@/components/common/listColumnWidths';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { KeypressLayer } from '@/contexts/enums';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { getI18n } from '@/i18n/index';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { MissionErrorType, MissionMetadata } from '@/services/mission/types';
import { displayWidth as getDisplayWidth } from '@/utils/displayWidth';
import { formatRelativeTime } from '@/utils/formatRelativeTime';
import { cleanPastedText } from '@/utils/pasteHandler';

const VISIBLE_COUNT = 10;

type MissionsListMode = 'browse' | 'rename';

interface MissionsListProps {
  missions: MissionMetadata[];
  currentMissionId: string | null;
  onSelect: (mission: MissionMetadata) => void;
  onNewMission: () => void;
  onExitMission?: () => void;
  onRename?: (missionId: string, newTitle: string) => Promise<void>;
  onCancel: () => void;
}

function getMissionStateDisplay(state: MissionState | null): {
  text: string;
} {
  const t = getI18n().t.bind(getI18n());
  if (!state) {
    return { text: t('common:missions.states.awaitingInput') };
  }

  switch (state) {
    case MissionState.Running:
      return { text: t('common:missions.states.running') };
    case MissionState.Paused:
      return { text: t('common:missions.states.paused') };
    case MissionState.Completed:
      return { text: t('common:missions.states.completed') };
    case MissionState.OrchestratorTurn:
      return { text: t('common:missions.states.orchestratorTurn') };
    case MissionState.Planning:
      return { text: t('common:missions.states.planning') };
    case MissionState.AwaitingInput:
      return { text: t('common:missions.states.awaitingInput') };
    case MissionState.Initializing:
      return { text: t('common:missions.states.initializing') };
    default:
      return { text: String(state) };
  }
}

function getErrorDisplay(mission: MissionMetadata): {
  indicator: string;
  color: string;
} {
  if (!mission.hasError) {
    return { indicator: '', color: '' };
  }

  switch (mission.errorType) {
    case MissionErrorType.InvalidJson:
      return { indicator: '✗', color: COLORS.error };
    case MissionErrorType.PermissionDenied:
      return { indicator: '⊘', color: COLORS.error };
    case MissionErrorType.MissingTranscript:
      return { indicator: '⚠', color: COLORS.warning };
    case MissionErrorType.ReadError:
    default:
      return { indicator: '⚠', color: COLORS.warning };
  }
}

export function MissionsList({
  missions,
  currentMissionId,
  onSelect,
  onNewMission,
  onExitMission,
  onRename,
  onCancel,
}: MissionsListProps) {
  const isInMission = currentMissionId !== null && onExitMission !== undefined;
  const { t } = useTranslation('common');
  const { width: terminalWidth } = useTerminalDimensions();
  const [selectedIndex, setSelectedIndex] = useState(() => {
    if (currentMissionId) {
      const idx = missions.findIndex(
        (m) => m.baseSessionId === currentMissionId
      );
      if (idx >= 0) return idx + 1; // +1 for action button at index 0
    }
    return 0;
  });
  const [mode, setMode] = useState<MissionsListMode>('browse');
  const [searchQuery, setSearchQuery] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [renamePlaceholder, setRenamePlaceholder] = useState('');
  const [renameMissionId, setRenameMissionId] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [arrowFrame, setArrowFrame] = useState(0);
  const arrowTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (selectedIndex === 0) {
      arrowTimerRef.current = setInterval(() => {
        setArrowFrame((f) => (f === 0 ? 1 : 0));
      }, 600);
    } else {
      setArrowFrame(0);
      if (arrowTimerRef.current) {
        clearInterval(arrowTimerRef.current);
        arrowTimerRef.current = null;
      }
    }
    return () => {
      if (arrowTimerRef.current) {
        clearInterval(arrowTimerRef.current);
        arrowTimerRef.current = null;
      }
    };
  }, [selectedIndex]);

  const displayMissions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return missions;
    return missions.filter((m) => {
      const title = (m.title ?? '').toLowerCase();
      const dir = (m.workingDirectory ?? '').toLowerCase();
      return title.includes(query) || dir.includes(query);
    });
  }, [missions, searchQuery]);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  // Column widths
  const selectorWidth = 2;
  const stateWidth = 15;
  const featuresWidth = 8;
  const featuresGap = 2;

  const updatedWidth = useMemo(() => {
    let maxWidth = 8;
    for (const mission of missions) {
      const timeStr = formatRelativeTime(
        mission.updatedAt ?? mission.createdAt
      );
      const width = getDisplayWidth(timeStr);
      if (width > maxWidth) maxWidth = width;
    }
    return maxWidth + 1;
  }, [missions]);

  const fixedColumnsWidth =
    selectorWidth + stateWidth + updatedWidth + featuresWidth + featuresGap;
  const remainingWidth = Math.max(terminalWidth - fixedColumnsWidth - 4, 20);

  const maxPathWidth = useMemo(() => {
    let maxW = 4;
    for (const mission of missions) {
      if (mission.workingDirectory) {
        const w = getDisplayWidth(mission.workingDirectory);
        if (w > maxW) maxW = w;
      }
    }
    return maxW;
  }, [missions]);

  const titlePathGap = 2;
  const showPath = remainingWidth > 40;
  const { pathWidth, titleWidth } = computeTitlePathColumnWidths({
    remainingWidth,
    maxPathWidth,
    showPath,
    titlePathGap,
  });

  // Index 0 = action button (rendered outside the list), indices 1+ = missions
  const totalItems = 1 + displayMissions.length;

  // Clamp selectedIndex
  useEffect(() => {
    if (totalItems > 0 && selectedIndex >= totalItems) {
      setSelectedIndex(totalItems - 1);
    }
  }, [totalItems, selectedIndex]);

  const handleCtrlR = useCallback(() => {
    if (mode !== 'browse') return;
    // Only allow rename on mission rows (selectedIndex > 0)
    if (selectedIndex === 0 || displayMissions.length === 0) return;
    const mission = displayMissions[selectedIndex - 1];
    if (!mission) return;
    setRenamePlaceholder(mission.title ?? t('missions.untitled'));
    setRenameValue('');
    setRenameMissionId(mission.baseSessionId);
    setMode('rename');
  }, [mode, selectedIndex, displayMissions, t]);

  const exitRenameMode = useCallback(() => {
    setMode('browse');
    setRenameValue('');
    setRenamePlaceholder('');
    setRenameMissionId(null);
    setIsRenaming(false);
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!renameMissionId || isRenaming || !onRename) {
      exitRenameMode();
      return;
    }
    const newTitle = renameValue.trim() || renamePlaceholder;
    if (!newTitle) {
      exitRenameMode();
      return;
    }
    setIsRenaming(true);
    try {
      await onRename(renameMissionId, newTitle);
    } finally {
      exitRenameMode();
    }
  }, [
    renameMissionId,
    onRename,
    isRenaming,
    renameValue,
    renamePlaceholder,
    exitRenameMode,
  ]);

  useKeypressHandler(
    (input, key) => {
      if (mode === 'rename') {
        if (matchKeyboardChord({ key, input }, 'escape')) {
          exitRenameMode();
          return true;
        }
        return false;
      }

      if (matchKeyboardChord({ key, input }, 'escape') || input === 'q') {
        onCancel();
        return true;
      }

      if (matchKeyboardChord({ key, input }, 'ctrl-r')) {
        handleCtrlR();
        return true;
      }

      if (matchKeyboardChord({ key, input }, 'enter')) {
        if (selectedIndex === 0) {
          if (isInMission) {
            onExitMission();
          } else {
            onNewMission();
          }
          return true;
        }

        const mission = displayMissions[selectedIndex - 1];
        if (mission) {
          onSelect(mission);
          return true;
        }
        return false;
      }

      if (matchKeyboardChord({ key, input }, 'up-arrow')) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return true;
      }

      if (matchKeyboardChord({ key, input }, 'down-arrow')) {
        setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 1));
        return true;
      }

      return false;
    },
    { layer: KeypressLayer.Navigation }
  );

  // Scrolling for mission list only (action button is rendered outside)
  const missionCount = displayMissions.length;
  const missionSelectedIndex = selectedIndex - 1; // -1 because index 0 is the action button
  const ANCHOR_ROW = 7;
  const windowStart = (() => {
    if (missionCount <= VISIBLE_COUNT) return 0;
    if (missionSelectedIndex < 0) return 0;
    const idealStart = missionSelectedIndex - ANCHOR_ROW;
    const maxStart = Math.max(0, missionCount - VISIBLE_COUNT);
    return Math.max(0, Math.min(idealStart, maxStart));
  })();

  const windowEnd = Math.min(windowStart + VISIBLE_COUNT, missionCount);
  const visibleMissions = displayMissions.slice(windowStart, windowEnd);

  const rangeText =
    missionCount === 0
      ? t('missions.rangeEmpty')
      : `${windowStart + 1}-${windowEnd} of ${missionCount}`;

  return (
    <MenuContainer
      title={t('missions.titleGeneric')}
      titleBold={false}
      width={terminalWidth}
      helpText={
        mode === 'rename' ? t('missions.helpRename') : t('missions.helpBrowse')
      }
      helpRight={rangeText}
      showDefaultHelp={false}
    >
      {/* Search input */}
      <Box marginBottom={1}>
        {mode === 'browse' ? (
          <TextInput
            value={searchQuery}
            onChange={(v) => setSearchQuery(cleanPastedText(v))}
            placeholder={t('missions.searchPlaceholder')}
          />
        ) : (
          <Text color={COLORS.text.muted}>
            {searchQuery || t('missions.searchPlaceholder')}
          </Text>
        )}
      </Box>

      {/* Action button */}
      <Box marginBottom={1}>
        <Box width={selectorWidth}>
          <Text
            color={
              selectedIndex === 0
                ? isInMission
                  ? COLORS.warning
                  : COLORS.success
                : undefined
            }
            wrap="truncate-end"
          >
            {selectedIndex === 0 ? (arrowFrame === 0 ? '> ' : ' >') : '  '}
          </Text>
        </Box>
        <Text
          color={
            selectedIndex === 0
              ? isInMission
                ? COLORS.warning
                : COLORS.success
              : COLORS.text.secondary
          }
          bold={selectedIndex === 0}
        >
          {isInMission
            ? t('missions.exitCurrentMission')
            : t('missions.newMission')}
        </Text>
      </Box>

      {/* Column headers */}
      <Box marginBottom={1}>
        <Box width={selectorWidth}>
          <Text> </Text>
        </Box>
        <Box width={stateWidth}>
          <Text color={COLORS.text.muted}>{t('missions.columns.state')}</Text>
        </Box>
        <Box width={updatedWidth}>
          <Text color={COLORS.text.muted}>{t('missions.columns.updated')}</Text>
        </Box>
        <Box width={featuresWidth} marginRight={featuresGap}>
          <Text color={COLORS.text.muted}>
            {t('missions.columns.features')}
          </Text>
        </Box>
        <Box width={titleWidth} marginRight={showPath ? titlePathGap : 0}>
          <Text color={COLORS.text.muted}>
            {t('missions.columns.titleDirectory')}
          </Text>
        </Box>
        {showPath && (
          <Box width={pathWidth}>
            <Text color={COLORS.text.muted}>{t('missions.columns.path')}</Text>
          </Box>
        )}
      </Box>

      {/* Mission list */}
      <Box flexDirection="column" height={VISIBLE_COUNT}>
        {visibleMissions.map((mission, i) => {
          const globalMissionIdx = windowStart + i;
          const isSelected = globalMissionIdx === missionSelectedIndex;
          const isCurrent =
            currentMissionId !== null &&
            mission.baseSessionId === currentMissionId;
          const color: string | undefined = isSelected
            ? COLORS.text.primary
            : COLORS.text.muted;

          const stateDisplay = getMissionStateDisplay(mission.state);
          const errorDisplay = getErrorDisplay(mission);
          const hasError = mission.hasError;

          let displayText = mission.title || '-';
          if (hasError) {
            displayText = `${errorDisplay.indicator} ${displayText || t('missions.errors.errorReading')}`;
          }

          const titleColor =
            hasError && !isSelected ? errorDisplay.color : color;

          return (
            <Box key={mission.baseSessionId}>
              <Box width={selectorWidth}>
                <Text color={isCurrent ? COLORS.primary : undefined}>
                  {isCurrent ? '●' : ' '}
                </Text>
              </Box>
              <Box width={stateWidth}>
                <Text
                  bold={isSelected}
                  color={isSelected ? COLORS.text.primary : COLORS.text.muted}
                >
                  {stateDisplay.text}
                </Text>
              </Box>
              <Box width={updatedWidth}>
                <Text bold={isSelected} color={color}>
                  {formatRelativeTime(mission.updatedAt ?? mission.createdAt)}
                </Text>
              </Box>
              <Box width={featuresWidth} marginRight={featuresGap}>
                <Text bold={isSelected} color={color}>
                  {mission.totalFeatures != null
                    ? `${mission.state === MissionState.Completed ? mission.totalFeatures : (mission.completedFeatures ?? 0)}/${mission.totalFeatures}`
                    : '-'}
                </Text>
              </Box>
              <Box width={titleWidth} marginRight={showPath ? titlePathGap : 0}>
                <Text bold={isSelected} color={titleColor} wrap="truncate-end">
                  {displayText}
                </Text>
              </Box>
              {showPath && (
                <Box width={pathWidth}>
                  <Text bold={isSelected} color={color} wrap="truncate-end">
                    {mission.workingDirectory ?? ''}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}

        {/* Empty states */}
        {displayMissions.length === 0 && searchQuery.trim() && (
          <Box>
            <Text color={COLORS.text.muted}>
              {t('missions.noMatchSearch', { query: searchQuery.trim() })}
            </Text>
          </Box>
        )}
        {missions.length === 0 && !searchQuery.trim() && (
          <Box>
            <Text color={COLORS.text.muted}>{t('missions.emptyState')}</Text>
          </Box>
        )}

        {/* Pad empty slots to maintain fixed height */}
        {Array.from({
          length: Math.max(0, VISIBLE_COUNT - visibleMissions.length),
        }).map((_, i) => (
          <Box key={`empty-${i}`} height={1}>
            <Text> </Text>
          </Box>
        ))}
      </Box>
      {/* Rename input */}
      {mode === 'rename' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.text.muted}>
            {isRenaming ? t('missions.saving') : t('missions.renameLabel')}
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
    </MenuContainer>
  );
}
