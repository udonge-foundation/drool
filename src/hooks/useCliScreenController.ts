import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

import { ANSI } from '@/components/chat/constants';
import { getConversationStateManager } from '@/services/ConversationStateManager';
import { getClearTerminalSequence } from '@/utils/clearTerminal';
import {
  enterMissionControlInkIsolation,
  exitMissionControlInkIsolation,
  preloadMissionControlInkIsolation,
} from '@/utils/missionControlInkIsolation';

type CliScreenState =
  | { name: 'chat' }
  | { name: 'transcript' }
  | {
      name: 'approvalDetails';
      requestKey: string;
      returnTo: 'chat' | 'transcript';
    }
  | { name: 'missionControl' }
  | { name: 'restoredChatBuffer' };

interface UseCliScreenControllerParams {
  stdout: NodeJS.WriteStream;
  writeToStdout: (data: string) => void;
}

interface UseCliScreenControllerResult {
  currentScreen: CliScreenState['name'];
  isChatScreen: boolean;
  isTranscriptScreen: boolean;
  isApprovalDetailsScreen: boolean;
  isMissionControlScreen: boolean;
  isRestoredChatBuffer: boolean;
  approvalDetailsRequestKey: string | null;
  missionControlScreenRef: MutableRefObject<boolean>;
  pendingMissionControlExit: boolean;
  openTranscript: () => void;
  closeTranscript: () => void;
  toggleTranscript: () => void;
  openApprovalDetails: (requestKey: string) => void;
  closeApprovalDetails: () => void;
  openMissionControl: () => void;
  closeMissionControl: () => void;
  unfreezeRestoredChat: () => void;
}

export function useCliScreenController({
  stdout,
  writeToStdout,
}: UseCliScreenControllerParams): UseCliScreenControllerResult {
  const [screenState, setScreenState] = useState<CliScreenState>({
    name: 'chat',
  });
  const [pendingMissionControlExit, setPendingMissionControlExit] =
    useState(false);
  const missionControlScreenRef = useRef(false);
  const clearTerminalSeq = useMemo(() => getClearTerminalSequence(), []);
  const currentScreen = screenState.name;

  useEffect(() => {
    preloadMissionControlInkIsolation();
  }, []);

  const openTranscript = useCallback(() => {
    setScreenState((screen) => {
      if (
        screen.name === 'missionControl' ||
        screen.name === 'approvalDetails'
      ) {
        return screen;
      }
      return { name: 'transcript' };
    });
  }, []);

  const closeTranscript = useCallback(() => {
    setScreenState((screen) =>
      screen.name === 'transcript' ? { name: 'chat' } : screen
    );
  }, []);

  const toggleTranscript = useCallback(() => {
    setScreenState((screen) => {
      if (
        screen.name === 'missionControl' ||
        screen.name === 'approvalDetails'
      ) {
        return screen;
      }
      return screen.name === 'transcript'
        ? { name: 'chat' }
        : { name: 'transcript' };
    });
  }, []);

  const openApprovalDetails = useCallback((requestKey: string) => {
    setScreenState((screen) => {
      if (screen.name === 'missionControl') {
        return screen;
      }
      return {
        name: 'approvalDetails',
        requestKey,
        returnTo: screen.name === 'transcript' ? 'transcript' : 'chat',
      };
    });
  }, []);

  const closeApprovalDetails = useCallback(() => {
    setScreenState((screen) => {
      if (screen.name !== 'approvalDetails') {
        return screen;
      }
      return { name: screen.returnTo };
    });
  }, []);

  const openMissionControl = useCallback(() => {
    setPendingMissionControlExit(false);
    getConversationStateManager().setUiUpdatesSuspended(true);
    void enterMissionControlInkIsolation(stdout);
    missionControlScreenRef.current = true;
    setScreenState({ name: 'missionControl' });
    writeToStdout(ANSI.ENTER_ALTERNATE_SCREEN + clearTerminalSeq);
  }, [clearTerminalSeq, stdout, writeToStdout]);

  const closeMissionControl = useCallback(() => {
    setPendingMissionControlExit(true);
    setScreenState((screen) =>
      screen.name === 'missionControl' ? { name: 'restoredChatBuffer' } : screen
    );
    getConversationStateManager().setUiUpdatesSuspended(false);
  }, []);

  const unfreezeRestoredChat = useCallback(() => {
    setScreenState((screen) =>
      screen.name === 'restoredChatBuffer' ? { name: 'chat' } : screen
    );
  }, []);

  useEffect(() => {
    if (!pendingMissionControlExit || screenState.name === 'missionControl') {
      return;
    }

    writeToStdout(ANSI.EXIT_ALTERNATE_SCREEN + clearTerminalSeq);
    void exitMissionControlInkIsolation(stdout);
    missionControlScreenRef.current = false;
    setPendingMissionControlExit(false);
  }, [
    clearTerminalSeq,
    pendingMissionControlExit,
    screenState.name,
    stdout,
    writeToStdout,
  ]);

  return {
    currentScreen,
    isChatScreen: screenState.name === 'chat',
    isTranscriptScreen: screenState.name === 'transcript',
    isApprovalDetailsScreen: screenState.name === 'approvalDetails',
    isMissionControlScreen: screenState.name === 'missionControl',
    isRestoredChatBuffer: screenState.name === 'restoredChatBuffer',
    approvalDetailsRequestKey:
      screenState.name === 'approvalDetails' ? screenState.requestKey : null,
    missionControlScreenRef,
    pendingMissionControlExit,
    openTranscript,
    closeTranscript,
    toggleTranscript,
    openApprovalDetails,
    closeApprovalDetails,
    openMissionControl,
    closeMissionControl,
    unfreezeRestoredChat,
  };
}
