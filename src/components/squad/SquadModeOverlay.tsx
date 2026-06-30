import { Box, Text } from 'ink';
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import { COLORS } from '@/components/chat/themedColors';
import { TextInput } from '@/components/common/TextInput';
import { SessionViewerView } from '@/components/mission-control/views/SessionViewerView';
import type { SquadModeOverlayRef } from '@/components/squad/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import {
  SQUAD_USER_PARTICIPANT_ID,
  SQUAD_USER_PARTICIPANT_LABEL,
} from '@/services/squad/constants';
import { SquadRole, SquadStatus } from '@/services/squad/enums';
import { sendUserDmToOrchestrator } from '@/services/squad/SquadBoardStore';
import { startSquad } from '@/services/squad/SquadBootstrap';
import {
  refreshSquadOverview,
  subscribeToSquadOverview,
} from '@/services/squad/SquadModeState';
import {
  clearActiveSquadIfStopped,
  createSquad,
  prepareStoppedSquadForResume,
  stopSquad,
} from '@/services/squad/SquadStateService';
import { getSquadWakeupScheduler } from '@/services/squad/SquadWakeupScheduler';
import type { SquadBoardMessage, SquadOverview } from '@/services/squad/types';

const FRAME_CHROME_HEIGHT = 6;
const MESSAGE_SECTION_RESERVED_LINES = 4;
const MESSAGE_BOX_CHROME_HEIGHT = 2;
const CENTER_PANE_INFO_WIDTH_PADDING = 2;
const SQUAD_MODE_CLOSE_ARM_TIMEOUT_MS = 1500;

type Pane = 'channels' | 'dms';
type ActiveSection = 'sidebar' | 'messages' | 'agents';
type RenderedMessageLine = {
  text: string;
  tone: 'meta' | 'body' | 'spacer';
};

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}

function formatTimestamp(timestamp?: string): string {
  if (!timestamp) {
    return '—';
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function HorizontalBorder({
  width,
  left = '├',
  right = '┤',
}: {
  width: number;
  left?: string;
  right?: string;
}) {
  return <Text>{`${left}${'─'.repeat(Math.max(0, width - 2))}${right}`}</Text>;
}

function FramedRow({
  width,
  children,
}: {
  width: number;
  children?: ReactNode;
}) {
  return (
    <Box height={1}>
      <Text>│</Text>
      <Box width={width} height={1} overflow="hidden">
        {children}
      </Box>
      <Text>│</Text>
    </Box>
  );
}

export function wrapLine(
  value: string,
  width: number,
  continuationPrefix = ''
): string[] {
  if (width <= 0) {
    return [''];
  }

  if (value.length <= width) {
    return [value];
  }

  const wrappedLines: string[] = [];
  let remaining = value;
  let prefix = '';

  while (remaining.length > 0) {
    const availableWidth = Math.max(1, width - prefix.length);
    if (remaining.length <= availableWidth) {
      wrappedLines.push(`${prefix}${remaining}`);
      break;
    }

    let splitIndex = remaining.lastIndexOf(' ', availableWidth);
    if (splitIndex <= 0) {
      splitIndex = availableWidth;
    }

    wrappedLines.push(`${prefix}${remaining.slice(0, splitIndex).trimEnd()}`);
    remaining = remaining.slice(splitIndex).trimStart();
    prefix = continuationPrefix;
  }

  return wrappedLines;
}

export function wrapBoardLine(value: string, width: number): string[] {
  return wrapLine(value, width, value.startsWith('  ↳ ') ? '    ' : '  ');
}

export function formatSquadParticipantLabel(participantId: string): string {
  return participantId === SQUAD_USER_PARTICIPANT_ID
    ? SQUAD_USER_PARTICIPANT_LABEL
    : participantId;
}

export function buildDmConversationId(
  participantA: string,
  participantB: string
): string {
  return [participantA, participantB].sort().join(' ↔ ');
}

export function formatDmConversationLabel(conversationId: string): string {
  const participants = conversationId.split(' ↔ ');
  const orderedParticipants = participants.includes(SQUAD_USER_PARTICIPANT_ID)
    ? [
        SQUAD_USER_PARTICIPANT_ID,
        ...participants.filter(
          (participant) => participant !== SQUAD_USER_PARTICIPANT_ID
        ),
      ]
    : participants;

  return orderedParticipants.map(formatSquadParticipantLabel).join(' ↔ ');
}

export function canStopSquadStatus(status?: SquadStatus | null): boolean {
  return status === SquadStatus.Starting || status === SquadStatus.Running;
}

export function canResumeSquadStatus(status?: SquadStatus | null): boolean {
  return status === SquadStatus.Stopped;
}

export function formatMessageBlock(
  message: SquadBoardMessage,
  width: number,
  options?: { isReply?: boolean }
): RenderedMessageLine[] {
  const isReply = options?.isReply ?? false;
  const headerPrefix = isReply ? '↳ ' : '';
  const bodyPrefix = isReply ? '    ' : '  ';

  return [
    {
      text: truncate(
        `${headerPrefix}${formatSquadParticipantLabel(message.authorAgentId)} • ${formatTimestamp(message.timestamp)}`,
        Math.max(1, width)
      ),
      tone: 'meta',
    },
    ...wrapLine(`${bodyPrefix}${message.content}`, width, bodyPrefix).map(
      (line) => ({
        text: line,
        tone: 'body' as const,
      })
    ),
  ];
}

interface SquadModeOverlayProps {
  width: number;
  onClose: () => void;
}

export function resolveSquadModeEscapeAction(params: {
  isComposingOrchestratorDm: boolean;
  isViewingWorkerDetail?: boolean;
  isCloseArmed: boolean;
}): 'cancel-compose' | 'close-worker-detail' | 'arm-close' | 'close-overlay' {
  if (params.isComposingOrchestratorDm) {
    return 'cancel-compose';
  }

  if (params.isViewingWorkerDetail) {
    return 'close-worker-detail';
  }

  return params.isCloseArmed ? 'close-overlay' : 'arm-close';
}

export function shouldResetSquadModeCloseGuard(params: {
  input: string;
  key?: { sequence?: string; escape?: boolean };
}): boolean {
  return !matchKeyboardChord(params, 'escape');
}

export const SquadModeOverlay = forwardRef<
  SquadModeOverlayRef,
  SquadModeOverlayProps
>(function SquadModeOverlay({ width, onClose }: SquadModeOverlayProps, ref) {
  const { height: terminalHeight } = useTerminalDimensions();
  const [overview, setOverview] = useState<SquadOverview>({
    snapshot: null,
    selectedSquadId: null,
    agents: [],
  });
  const [goal, setGoal] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isPlanningNewSquad, setIsPlanningNewSquad] = useState(false);
  const [pane, setPane] = useState<Pane>('channels');
  const [activeSection, setActiveSection] = useState<ActiveSection>('sidebar');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [messageScrollOffset, setMessageScrollOffset] = useState(0);
  const [followLatestMessages, setFollowLatestMessages] = useState(true);
  const [isComposingOrchestratorDm, setIsComposingOrchestratorDm] =
    useState(false);
  const [isSendingOrchestratorDm, setIsSendingOrchestratorDm] = useState(false);
  const [isCloseArmed, setIsCloseArmed] = useState(false);
  const [orchestratorDmDraft, setOrchestratorDmDraft] = useState('');
  const [workerDetailAgentId, setWorkerDetailAgentId] = useState<string | null>(
    null
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const closeGuardTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const closeGuardArmedRef = useRef(false);

  useEffect(() => subscribeToSquadOverview(setOverview), []);

  const refresh = useCallback(() => refreshSquadOverview(), []);

  const snapshot = overview.snapshot;
  const isStopped = snapshot?.squad.status === 'stopped';
  const isPlanning = !snapshot || isPlanningNewSquad;
  const canStopActiveSquad = canStopSquadStatus(snapshot?.squad.status);
  const canResumeActiveSquad = canResumeSquadStatus(snapshot?.squad.status);
  const orchestratorAgentId =
    snapshot?.squad.agents.find(
      (agent) => agent.role === SquadRole.Orchestrator
    )?.agentId ?? null;
  const orchestratorConversationId = orchestratorAgentId
    ? buildDmConversationId(SQUAD_USER_PARTICIPANT_ID, orchestratorAgentId)
    : null;
  const frameWidth = width;
  const contentWidth = frameWidth - 2;
  const workerDetailAgent =
    snapshot?.squad.agents.find(
      (agent) => agent.agentId === workerDetailAgentId
    ) ?? null;
  const isViewingWorkerDetail = workerDetailAgent !== null;
  const contentAreaHeight = Math.max(1, terminalHeight - FRAME_CHROME_HEIGHT);
  const sidebarWidth = Math.max(24, Math.floor(contentWidth * 0.24));
  const rightWidth = Math.max(30, Math.floor(contentWidth * 0.27));
  const centerWidth = Math.max(
    28,
    contentWidth - sidebarWidth - rightWidth - 2
  );
  const agentRows = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    const overviewAgentsById = new Map(
      overview.agents.map((agent) => [agent.agentId, agent])
    );

    return snapshot.squad.agents.map((agent) => ({
      ...agent,
      pendingNotifications:
        overviewAgentsById.get(agent.agentId)?.pendingNotifications ?? 0,
      introduced:
        overviewAgentsById.get(agent.agentId)?.introduced ??
        Boolean(agent.introducedAt),
    }));
  }, [overview.agents, snapshot]);

  const sidebarItems = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    if (pane === 'channels') {
      return snapshot.channels.map((channel) => ({
        id: channel.name,
        label: `#${channel.name}`,
      }));
    }

    return snapshot.dmConversations.map((conversation) => ({
      id: conversation.targetAgentId,
      label: formatDmConversationLabel(conversation.targetAgentId),
    }));
  }, [pane, snapshot]);

  const selectedItem =
    sidebarItems[Math.min(selectedIndex, Math.max(sidebarItems.length - 1, 0))];

  const selectedMessages = useMemo(() => {
    if (!snapshot || !selectedItem) {
      return [] as SquadBoardMessage[];
    }

    if (pane === 'channels') {
      const channel = snapshot.channels.find(
        (candidate) => candidate.name === selectedItem.id
      );
      return channel?.messages ?? [];
    }

    const conversation = snapshot.dmConversations.find(
      (candidate) => candidate.targetAgentId === selectedItem.id
    );
    return conversation?.messages ?? [];
  }, [pane, selectedItem, snapshot]);

  const messageBoxInnerWidth = Math.max(1, centerWidth - 4);

  const renderedMessages = useMemo(() => {
    if (!snapshot || selectedMessages.length === 0) {
      return [] as RenderedMessageLine[];
    }

    const lines: RenderedMessageLine[] = [];

    if (pane === 'dms') {
      selectedMessages.forEach((message, index) => {
        lines.push(...formatMessageBlock(message, messageBoxInnerWidth));
        if (index < selectedMessages.length - 1) {
          lines.push({ text: '', tone: 'spacer' });
        }
      });

      return lines;
    }

    for (const message of selectedMessages) {
      if (message.parentMessageId) {
        continue;
      }

      lines.push(...formatMessageBlock(message, messageBoxInnerWidth));

      const replies = snapshot.threadReplies[message.id] ?? [];
      for (const reply of replies) {
        lines.push(
          ...formatMessageBlock(reply, messageBoxInnerWidth, { isReply: true })
        );
      }

      lines.push({ text: '', tone: 'spacer' });
    }

    if (lines.length > 0 && lines.at(-1)?.tone === 'spacer') {
      lines.pop();
    }

    return lines;
  }, [messageBoxInnerWidth, pane, selectedMessages, snapshot]);

  const messageViewportHeight = Math.max(
    3,
    contentAreaHeight -
      MESSAGE_SECTION_RESERVED_LINES -
      MESSAGE_BOX_CHROME_HEIGHT
  );
  const messageBoxHeight = messageViewportHeight + MESSAGE_BOX_CHROME_HEIGHT;
  const maxMessageScrollOffset = Math.max(
    0,
    renderedMessages.length - messageViewportHeight
  );
  const visibleMessageLines = renderedMessages.slice(
    messageScrollOffset,
    messageScrollOffset + messageViewportHeight
  );
  const paddedVisibleMessageLines = [
    ...visibleMessageLines,
    ...Array.from(
      {
        length: Math.max(0, messageViewportHeight - visibleMessageLines.length),
      },
      () => ({ text: '', tone: 'spacer' as const })
    ),
  ];
  const headerRightText = snapshot
    ? `${snapshot.squad.id} • ${snapshot.squad.status}`
    : 'No active squad';
  const headerRightWidth = Math.min(
    Math.max(24, headerRightText.length),
    Math.max(24, Math.floor(contentWidth * 0.45))
  );
  const headerLeftWidth = Math.max(1, contentWidth - headerRightWidth);
  const footerStatusText = isCloseArmed
    ? 'Press Esc again to close Squad Mode.'
    : (statusMessage ??
      (isStarting
        ? 'Starting squad…'
        : isStopping
          ? 'Stopping squad…'
          : isSendingOrchestratorDm
            ? 'Sending DM to orchestrator…'
            : isComposingOrchestratorDm
              ? 'Composing DM to orchestrator'
              : 'Watching live squad state'));
  const footerRightWidth = Math.min(
    Math.max(28, footerStatusText.length),
    Math.max(28, Math.floor(contentWidth * 0.42))
  );
  const footerLeftWidth = Math.max(1, contentWidth - footerRightWidth);
  const selectedAgent =
    agentRows.find((agent) => agent.agentId === selectedAgentId) ??
    agentRows[0] ??
    null;
  const selectedAgentIndex = selectedAgent
    ? agentRows.findIndex((agent) => agent.agentId === selectedAgent.agentId)
    : -1;

  const startNewSquad = useCallback(async () => {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal || isStarting) {
      return;
    }

    setIsStarting(true);
    setStatusMessage(null);

    let createdSquadId: string | null = null;

    try {
      await clearActiveSquadIfStopped();

      const squad = await createSquad({
        goal: trimmedGoal,
        cwd: process.cwd(),
      });
      createdSquadId = squad.id;
      const result = await startSquad(squad.id);
      setIsPlanningNewSquad(false);
      setGoal('');
      setStatusMessage(
        `Started squad ${result.squadId}. Spawned ${result.spawnedAgents}/5 agents.`
      );
      await refresh();
    } catch (error) {
      if (createdSquadId) {
        await stopSquad(createdSquadId);
        await clearActiveSquadIfStopped();
        await refresh();
      }
      setStatusMessage(
        error instanceof Error ? error.message : 'Failed to start squad.'
      );
    } finally {
      setIsStarting(false);
    }
  }, [goal, isStarting, refresh]);

  const handleStartSubmit = useCallback(() => {
    startNewSquad().catch(() => undefined);
  }, [startNewSquad]);

  const disarmCloseGuard = useCallback(() => {
    closeGuardArmedRef.current = false;
    setIsCloseArmed(false);

    if (closeGuardTimeoutRef.current) {
      clearTimeout(closeGuardTimeoutRef.current);
      closeGuardTimeoutRef.current = null;
    }
  }, []);

  const armCloseGuard = useCallback(() => {
    closeGuardArmedRef.current = true;
    setIsCloseArmed(true);

    if (closeGuardTimeoutRef.current) {
      clearTimeout(closeGuardTimeoutRef.current);
    }

    closeGuardTimeoutRef.current = setTimeout(() => {
      closeGuardArmedRef.current = false;
      setIsCloseArmed(false);
      closeGuardTimeoutRef.current = null;
    }, SQUAD_MODE_CLOSE_ARM_TIMEOUT_MS);
  }, []);

  const cancelOrchestratorDmCompose = useCallback(() => {
    if (isSendingOrchestratorDm) {
      return;
    }

    setIsComposingOrchestratorDm(false);
    setOrchestratorDmDraft('');
    setStatusMessage(null);
  }, [isSendingOrchestratorDm]);

  useEffect(
    () => () => {
      if (closeGuardTimeoutRef.current) {
        clearTimeout(closeGuardTimeoutRef.current);
      }
    },
    []
  );

  useImperativeHandle(
    ref,
    () => ({
      handleEsc: () => {
        const action = resolveSquadModeEscapeAction({
          isComposingOrchestratorDm,
          isViewingWorkerDetail,
          isCloseArmed: closeGuardArmedRef.current,
        });
        if (action === 'cancel-compose') {
          cancelOrchestratorDmCompose();
          return true;
        }

        if (action === 'close-worker-detail') {
          setWorkerDetailAgentId(null);
          setActiveSection('agents');
          return true;
        }
        if (action === 'arm-close') {
          armCloseGuard();
          return true;
        }

        onClose();
        return true;
      },
    }),
    [
      armCloseGuard,
      cancelOrchestratorDmCompose,
      isComposingOrchestratorDm,
      isViewingWorkerDetail,
      onClose,
    ]
  );

  const handleOrchestratorDmSubmit = useCallback(async () => {
    const trimmedDraft = orchestratorDmDraft.trim();
    if (
      !snapshot ||
      !orchestratorAgentId ||
      snapshot.squad.status !== 'running' ||
      !trimmedDraft ||
      isSendingOrchestratorDm
    ) {
      return;
    }

    setIsSendingOrchestratorDm(true);
    setStatusMessage(null);

    try {
      const result = await sendUserDmToOrchestrator({
        squadId: snapshot.squad.id,
        content: trimmedDraft,
      });
      const nextOverview = await refresh();

      setPane('dms');
      if (orchestratorConversationId) {
        const conversationIndex =
          nextOverview.snapshot?.dmConversations.findIndex(
            (conversation) =>
              conversation.targetAgentId === orchestratorConversationId
          );
        if (conversationIndex !== undefined && conversationIndex >= 0) {
          setSelectedIndex(conversationIndex);
        }
      }
      setFollowLatestMessages(true);
      setIsComposingOrchestratorDm(false);
      setOrchestratorDmDraft('');
      setStatusMessage(result);
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : 'Failed to message orchestrator.'
      );
    } finally {
      setIsSendingOrchestratorDm(false);
    }
  }, [
    isSendingOrchestratorDm,
    orchestratorAgentId,
    orchestratorConversationId,
    orchestratorDmDraft,
    refresh,
    snapshot,
  ]);

  const openOrchestratorDmCompose = useCallback(() => {
    if (
      !snapshot ||
      !orchestratorAgentId ||
      snapshot.squad.status !== 'running' ||
      isSendingOrchestratorDm
    ) {
      return;
    }

    setIsComposingOrchestratorDm(true);
    setStatusMessage(null);
  }, [isSendingOrchestratorDm, orchestratorAgentId, snapshot]);

  const stopCurrentSquad = useCallback(async () => {
    if (!snapshot || isStopping || snapshot.squad.status === 'stopped') {
      return;
    }

    setIsStopping(true);
    setStatusMessage(null);
    try {
      const client = getTuiDaemonAdapter();
      await Promise.allSettled(
        snapshot.squad.agents
          .map((agent) => agent.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId))
          .map((sessionId) => client.closeSession(sessionId))
      );
      await stopSquad(snapshot.squad.id);
      getSquadWakeupScheduler().stop(snapshot.squad.id);
      setStatusMessage(`Stopped squad ${snapshot.squad.id}.`);
      await refresh();
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : 'Failed to stop squad.'
      );
    } finally {
      setIsStopping(false);
    }
  }, [isStopping, refresh, snapshot]);

  const resumeStoppedSquad = useCallback(async () => {
    if (
      !snapshot ||
      !canResumeSquadStatus(snapshot.squad.status) ||
      isStarting
    ) {
      return;
    }

    setIsStarting(true);
    setStatusMessage(null);

    try {
      const preparedSquad = await prepareStoppedSquadForResume(
        snapshot.squad.id
      );
      if (!preparedSquad) {
        setStatusMessage('Only stopped squads can be resumed.');
        return;
      }

      const result = await startSquad(snapshot.squad.id, { resume: true });
      setStatusMessage(
        `Resumed squad ${result.squadId}. Spawned ${result.spawnedAgents}/5 agents.`
      );
      await refresh();
    } catch (error) {
      await stopSquad(snapshot.squad.id);
      await refresh();
      setStatusMessage(
        error instanceof Error ? error.message : 'Failed to resume squad.'
      );
    } finally {
      setIsStarting(false);
    }
  }, [isStarting, refresh, snapshot]);

  useEffect(() => {
    setFollowLatestMessages(true);
  }, [pane, selectedItem?.id, snapshot?.squad.id]);

  useEffect(() => {
    setActiveSection('sidebar');
  }, [pane]);

  useEffect(() => {
    if (followLatestMessages) {
      setMessageScrollOffset(maxMessageScrollOffset);
      return;
    }

    setMessageScrollOffset((current) =>
      Math.min(current, maxMessageScrollOffset)
    );
  }, [followLatestMessages, maxMessageScrollOffset]);

  const scrollMessagesUp = useCallback(
    (amount: number) => {
      if (renderedMessages.length === 0) {
        return;
      }

      setFollowLatestMessages(false);
      setMessageScrollOffset((current) => Math.max(0, current - amount));
    },
    [renderedMessages.length]
  );

  const scrollMessagesDown = useCallback(
    (amount: number) => {
      if (renderedMessages.length === 0) {
        return;
      }

      setMessageScrollOffset((current) => {
        const next = Math.min(maxMessageScrollOffset, current + amount);
        setFollowLatestMessages(next >= maxMessageScrollOffset);
        return next;
      });
    },
    [maxMessageScrollOffset, renderedMessages.length]
  );

  const jumpMessagesToTop = useCallback(() => {
    if (renderedMessages.length === 0) {
      return;
    }

    setFollowLatestMessages(false);
    setMessageScrollOffset(0);
  }, [renderedMessages.length]);

  const jumpMessagesToBottom = useCallback(() => {
    setFollowLatestMessages(true);
    setMessageScrollOffset(maxMessageScrollOffset);
  }, [maxMessageScrollOffset]);

  useKeypressHandler(
    (_input, key) => {
      if (
        closeGuardArmedRef.current &&
        shouldResetSquadModeCloseGuard({ input: _input, key })
      ) {
        disarmCloseGuard();
      }

      if (isPlanning) {
        return;
      }

      if (isViewingWorkerDetail) {
        return;
      }

      if (isComposingOrchestratorDm) {
        return;
      }

      if (key.tab) {
        setPane((current) => (current === 'channels' ? 'dms' : 'channels'));
        setSelectedIndex(0);
        return;
      }

      if (key.leftArrow) {
        setActiveSection((current) => {
          if (current === 'agents') {
            return 'messages';
          }

          return 'sidebar';
        });
        return;
      }

      if (key.rightArrow) {
        setActiveSection((current) => {
          if (current === 'sidebar') {
            return 'messages';
          }

          return 'agents';
        });
        return;
      }

      if (key.upArrow || key.pageUp) {
        if (key.upArrow && activeSection === 'sidebar') {
          if (sidebarItems.length === 0) {
            return;
          }

          setSelectedIndex((current) => Math.max(0, current - 1));
          return;
        }

        if (key.upArrow && activeSection === 'agents') {
          if (agentRows.length === 0) {
            return;
          }

          const nextAgent =
            agentRows[Math.max(0, Math.max(selectedAgentIndex, 0) - 1)];
          setSelectedAgentId(nextAgent?.agentId ?? null);
          return;
        }

        setActiveSection('messages');
        scrollMessagesUp(key.pageUp ? messageViewportHeight : 1);
        return;
      }

      if (key.downArrow || key.pageDown) {
        if (key.downArrow && activeSection === 'sidebar') {
          if (sidebarItems.length === 0) {
            return;
          }

          setSelectedIndex((current) =>
            Math.min(sidebarItems.length - 1, current + 1)
          );
          return;
        }

        if (key.downArrow && activeSection === 'agents') {
          if (agentRows.length === 0) {
            return;
          }

          const nextAgent =
            agentRows[
              Math.min(
                agentRows.length - 1,
                Math.max(selectedAgentIndex, 0) + 1
              )
            ];
          setSelectedAgentId(nextAgent?.agentId ?? null);
          return;
        }

        setActiveSection('messages');
        scrollMessagesDown(key.pageDown ? messageViewportHeight : 1);
        return;
      }

      if (_input === 'g') {
        jumpMessagesToTop();
        return;
      }

      if (_input === 'G') {
        jumpMessagesToBottom();
        return;
      }

      if (_input === 'k') {
        if (activeSection === 'agents') {
          if (agentRows.length === 0) {
            return;
          }

          const nextAgent =
            agentRows[Math.max(0, Math.max(selectedAgentIndex, 0) - 1)];
          setSelectedAgentId(nextAgent?.agentId ?? null);
          return;
        }

        if (sidebarItems.length === 0) {
          return;
        }
        setActiveSection('sidebar');
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (_input === 'j') {
        if (activeSection === 'agents') {
          if (agentRows.length === 0) {
            return;
          }

          const nextAgent =
            agentRows[
              Math.min(
                agentRows.length - 1,
                Math.max(selectedAgentIndex, 0) + 1
              )
            ];
          setSelectedAgentId(nextAgent?.agentId ?? null);
          return;
        }

        if (sidebarItems.length === 0) {
          return;
        }
        setActiveSection('sidebar');
        setSelectedIndex((current) =>
          Math.min(sidebarItems.length - 1, current + 1)
        );
        return;
      }

      if (key.return && activeSection === 'agents') {
        if (!selectedAgent) {
          return;
        }

        if (!selectedAgent.sessionId) {
          setStatusMessage(
            `${selectedAgent.name} does not have a live session yet.`
          );
          return;
        }

        setStatusMessage(null);
        setWorkerDetailAgentId(selectedAgent.agentId);
        setActiveSection('agents');
        return;
      }

      if (_input.toLowerCase() === 's' && canStopActiveSquad) {
        void stopCurrentSquad();
        return;
      }

      if (_input.toLowerCase() === 'r' && canResumeActiveSquad) {
        void resumeStoppedSquad();
        return;
      }

      if (
        _input.toLowerCase() === 'm' &&
        snapshot?.squad.status === 'running'
      ) {
        openOrchestratorDmCompose();
        return;
      }

      if (_input.toLowerCase() === 'n' && isStopped) {
        setIsPlanningNewSquad(true);
        setGoal(snapshot?.squad.goal ?? '');
      }
    },
    {
      isActive: !isStopping && !isSendingOrchestratorDm,
    }
  );

  return (
    <Box width={frameWidth} height={terminalHeight} flexDirection="column">
      <HorizontalBorder width={frameWidth} left="┌" right="┐" />
      <FramedRow width={contentWidth}>
        <Box width={contentWidth} height={1}>
          <Box width={headerLeftWidth} height={1} overflow="hidden">
            {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
            <Text> Squad Mode</Text>
          </Box>
          <Box
            width={headerRightWidth}
            height={1}
            justifyContent="flex-end"
            overflow="hidden"
          >
            <Text color={COLORS.text.muted}>
              {truncate(headerRightText, headerRightWidth)}
            </Text>
          </Box>
        </Box>
      </FramedRow>
      <HorizontalBorder width={frameWidth} />
      <Box
        width={frameWidth}
        height={contentAreaHeight}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        flexDirection="column"
        overflow="hidden"
      >
        <Box
          width={contentWidth}
          height={contentAreaHeight}
          flexDirection="column"
          overflow="hidden"
        >
          {isPlanning ? (
            <Box
              width={contentWidth}
              height={contentAreaHeight}
              paddingX={1}
              flexDirection="column"
              overflow="hidden"
            >
              {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
              <Text color={COLORS.text.info}>Create a new squad</Text>
              <Box marginTop={1}>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text color={COLORS.text.muted}>Goal: </Text>
                <TextInput
                  value={goal}
                  onChange={setGoal}
                  onSubmit={handleStartSubmit}
                />
              </Box>
              <Box marginTop={1} flexDirection="column">
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text color={COLORS.text.muted}>Fixed roster</Text>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text>• Orchestrator</Text>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text>• Worker 1</Text>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text>• Worker 2</Text>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text>• Worker 3</Text>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text>• Worker 4</Text>
              </Box>
              <Box marginTop={1} flexDirection="column">
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text color={COLORS.text.muted}>
                  Press Enter to start the squad.
                </Text>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text color={COLORS.text.muted}>
                  Workers will introduce themselves and self-organize over the
                  board.
                </Text>
              </Box>
            </Box>
          ) : isViewingWorkerDetail && workerDetailAgent ? (
            <Box
              width={contentWidth}
              height={contentAreaHeight}
              paddingX={1}
              flexDirection="column"
              overflow="hidden"
            >
              <Text color={COLORS.text.info}>
                {truncate(
                  `${workerDetailAgent.name} live session`,
                  contentWidth - 2
                )}
              </Text>
              <Text color={COLORS.text.muted}>
                {truncate(
                  `${workerDetailAgent.role} • ${workerDetailAgent.status} • ${workerDetailAgent.sessionId ?? 'waiting for session'}`,
                  contentWidth - 2
                )}
              </Text>
              <Box marginTop={1} flexDirection="column" overflow="hidden">
                {workerDetailAgent.sessionId ? (
                  <SessionViewerView
                    sessionId={workerDetailAgent.sessionId}
                    status={
                      workerDetailAgent.status === 'running'
                        ? 'running'
                        : workerDetailAgent.status === 'error'
                          ? 'failed'
                          : undefined
                    }
                    workingDirectory={snapshot?.squad.cwd ?? process.cwd()}
                    viewport={{
                      width: Math.max(20, contentWidth - 2),
                      height: Math.max(8, contentAreaHeight - 4),
                    }}
                    allowInterruptAndChat={false}
                  />
                ) : (
                  // eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable
                  <Text color={COLORS.text.muted}>
                    Transcript will appear once this worker starts running.
                  </Text>
                )}
              </Box>
            </Box>
          ) : (
            <Box
              width={contentWidth}
              height={contentAreaHeight}
              overflow="hidden"
            >
              <Box
                width={sidebarWidth}
                height={contentAreaHeight}
                flexDirection="column"
                paddingX={1}
                overflow="hidden"
              >
                <Text color={COLORS.text.info}>
                  {`${pane === 'channels' ? 'Channels' : 'DMs'}${activeSection === 'sidebar' ? ' • nav' : ''}`}
                </Text>
                <Text color={COLORS.text.muted}>
                  {pane === 'channels'
                    ? 'Tab for DMs • → for board'
                    : 'Tab for channels • → for board'}
                </Text>
                <Box marginTop={1} flexDirection="column">
                  {sidebarItems.length === 0 ? (
                    // eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable
                    <Text color={COLORS.text.muted}>No items.</Text>
                  ) : (
                    sidebarItems.map((item, index) => (
                      <Text
                        key={item.id}
                        color={
                          index === selectedIndex ? COLORS.success : undefined
                        }
                      >
                        {index === selectedIndex ? '› ' : '  '}
                        {truncate(item.label, sidebarWidth - 4)}
                      </Text>
                    ))
                  )}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                  <Text color={COLORS.text.muted}>Actions</Text>
                  {snapshot?.squad.status === 'running' ? (
                    <>
                      {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                      <Text>• Press M to DM orchestrator</Text>
                      {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                      <Text>• Press S to stop the squad</Text>
                    </>
                  ) : snapshot?.squad.status === 'starting' ? (
                    // eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable
                    <Text>• Press S to cancel squad startup</Text>
                  ) : (
                    <>
                      {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                      <Text>• Press R to resume this squad</Text>
                      {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                      <Text>• Press N to plan a new squad</Text>
                    </>
                  )}
                </Box>
              </Box>
              <Text>│</Text>
              <Box
                width={centerWidth}
                height={contentAreaHeight}
                flexDirection="column"
                paddingX={1}
                overflow="hidden"
              >
                <Text color={COLORS.text.info}>
                  {truncate(
                    `${
                      pane === 'channels'
                        ? (selectedItem?.label ?? 'Board')
                        : (selectedItem?.label ?? 'Direct Messages')
                    }${activeSection === 'messages' ? ' • scroll' : ''}`,
                    centerWidth - CENTER_PANE_INFO_WIDTH_PADDING
                  )}
                </Text>
                <Text color={COLORS.text.muted}>
                  {truncate(
                    snapshot?.squad.goal ?? 'No squad goal',
                    centerWidth - CENTER_PANE_INFO_WIDTH_PADDING
                  )}
                </Text>
                <Text color={COLORS.text.muted}>
                  {truncate(
                    messageScrollOffset > 0
                      ? `↑ ${messageScrollOffset} more lines above`
                      : ' ',
                    centerWidth - CENTER_PANE_INFO_WIDTH_PADDING
                  )}
                </Text>
                <Box
                  height={messageBoxHeight}
                  flexDirection="column"
                  overflow="hidden"
                >
                  <HorizontalBorder
                    width={messageBoxInnerWidth + 2}
                    left="┌"
                    right="┐"
                  />
                  <Box flexDirection="column" overflow="hidden">
                    {renderedMessages.length === 0 ? (
                      <>
                        <FramedRow width={messageBoxInnerWidth}>
                          {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                          <Text color={COLORS.text.muted}>
                            No messages yet.
                          </Text>
                        </FramedRow>
                        {Array.from(
                          { length: Math.max(0, messageViewportHeight - 1) },
                          (_, index) => (
                            <FramedRow
                              key={`empty-${index}`}
                              width={messageBoxInnerWidth}
                            />
                          )
                        )}
                      </>
                    ) : (
                      paddedVisibleMessageLines.map((line, index) => (
                        <FramedRow
                          key={`${selectedItem?.id ?? 'line'}-${index}`}
                          width={messageBoxInnerWidth}
                        >
                          <Text
                            color={
                              line.tone === 'meta'
                                ? COLORS.text.info
                                : line.tone === 'spacer'
                                  ? COLORS.text.muted
                                  : undefined
                            }
                          >
                            {line.text}
                          </Text>
                        </FramedRow>
                      ))
                    )}
                  </Box>
                  <HorizontalBorder
                    width={messageBoxInnerWidth + 2}
                    left="└"
                    right="┘"
                  />
                </Box>
                <Text color={COLORS.text.muted}>
                  {truncate(
                    messageScrollOffset + messageViewportHeight <
                      renderedMessages.length
                      ? `↓ ${
                          renderedMessages.length -
                          messageScrollOffset -
                          messageViewportHeight
                        } more lines below`
                      : ' ',
                    centerWidth - CENTER_PANE_INFO_WIDTH_PADDING
                  )}
                </Text>
              </Box>
              <Text>│</Text>
              <Box
                width={rightWidth}
                height={contentAreaHeight}
                flexDirection="column"
                paddingX={1}
                overflow="hidden"
              >
                <Text color={COLORS.text.info}>
                  {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                  {`Agents${activeSection === 'agents' ? ' • nav' : ''}`}
                </Text>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text color={COLORS.text.muted}>
                  ← for board • Enter to zoom
                </Text>
                <Box marginTop={1} flexDirection="column">
                  {agentRows.map((agent, index) => (
                    <Text
                      key={agent.agentId}
                      color={
                        index === selectedAgentIndex
                          ? COLORS.success
                          : undefined
                      }
                    >
                      {index === selectedAgentIndex ? '› ' : '  '}
                      {truncate(
                        `${agent.name}: ${agent.introduced ? 'intro' : 'pending'} • ${agent.pendingNotifications} notif • ${agent.sessionId ? 'live' : 'waiting'} • ${formatTimestamp(agent.lastActivityAt)}`,
                        rightWidth - 4
                      )}
                    </Text>
                  ))}
                </Box>
                {selectedAgent && (
                  <Box marginTop={1} flexDirection="column">
                    {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                    <Text color={COLORS.text.muted}>Selected</Text>
                    <Text>{truncate(selectedAgent.name, rightWidth - 2)}</Text>
                    <Text color={COLORS.text.muted}>
                      {truncate(
                        selectedAgent.sessionId
                          ? 'Press Enter to zoom into this session.'
                          : 'Waiting for this agent session to start.',
                        rightWidth - 2
                      )}
                    </Text>
                  </Box>
                )}
              </Box>
            </Box>
          )}
        </Box>
      </Box>
      <HorizontalBorder width={frameWidth} />
      <FramedRow width={contentWidth}>
        <Box width={contentWidth} height={1}>
          <Box width={footerLeftWidth} height={1} overflow="hidden">
            {isComposingOrchestratorDm ? (
              <Box>
                {/* eslint-disable-next-line industry/no-untranslated-strings -- PLT-76: migrated from file-level disable */}
                <Text color={COLORS.text.muted}>DM orchestrator: </Text>
                <TextInput
                  value={orchestratorDmDraft}
                  onChange={setOrchestratorDmDraft}
                  onSubmit={() => {
                    void handleOrchestratorDmSubmit();
                  }}
                  focus={!isSendingOrchestratorDm}
                  placeholder="Type a message"
                />
              </Box>
            ) : (
              <Text color={COLORS.text.muted}>
                {truncate(
                  isPlanning
                    ? 'Enter start • Esc twice to close'
                    : isViewingWorkerDetail
                      ? 'Esc back • j/k or ↑↓ scroll • [ ] density • g/G top/bottom'
                      : 'Tab switch channels/DMs • ←/→ focus list/board/agents • Enter zoom selected agent • j/k or ↑↓ select • PgUp/PgDn/↑↓ scroll • g/G top/bottom • M message orchestrator • S stop • R resume • N new squad • Esc twice to close',
                  footerLeftWidth
                )}
              </Text>
            )}
          </Box>
          <Box
            width={footerRightWidth}
            height={1}
            justifyContent="flex-end"
            overflow="hidden"
          >
            <Text color={statusMessage ? COLORS.text.info : COLORS.text.muted}>
              {truncate(footerStatusText, footerRightWidth)}
            </Text>
          </Box>
        </Box>
      </FramedRow>
      <HorizontalBorder width={frameWidth} left="└" right="┘" />
    </Box>
  );
});
