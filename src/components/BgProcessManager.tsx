import { Box, Text } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useEscapeHandler } from '@/hooks/useEscapeHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { backgroundProcessTracker } from '@/services/BackgroundProcessTracker';
import { getSessionService } from '@/services/SessionService';

interface BgProcessManagerProps {
  onClose: () => void;
}

interface ProcessItem {
  pid: number;
  command: string;
  sessionId?: string;
  age: string;
  isCurrentSession: boolean;
}

export function BgProcessManager({ onClose }: BgProcessManagerProps) {
  const { t } = useTranslation();
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const loadProcesses = useCallback(() => {
    setLoading(true);
    const currentSessionId = getSessionService().getCurrentSessionId();
    const rawProcesses = backgroundProcessTracker.getProcesses();

    const items: ProcessItem[] = rawProcesses.map((p) => {
      const ageMs = Date.now() - p.startTime;
      const ageSec = Math.floor(ageMs / 1000);
      return {
        pid: p.pid,
        command: p.command,
        sessionId: p.sessionId,
        age: `${ageSec}s`,
        isCurrentSession: p.sessionId === currentSessionId,
      };
    });

    setProcesses(items);
    setLoading(false);
  }, []);

  // Initial load on mount
  useEffect(() => {
    loadProcesses();
  }, [loadProcesses]);

  const showMessage = (msg: string, _isError = false) => {
    setMessage(msg);
    // Use a ref or just simple timeout (simpler for this UI)
    setTimeout(() => setMessage(null), 3000);
  };

  const handleKill = async (pid: number) => {
    setLoading(true);
    const success = await backgroundProcessTracker.killProcess(pid);
    if (success) {
      showMessage(t('common:bgProcessManager.killedProcess', { pid }));
      loadProcesses();
    } else {
      showMessage(
        t('common:bgProcessManager.failedKillProcess', { pid }),
        true
      );
      setLoading(false);
    }
  };

  const handleCleanup = () => {
    setLoading(true);
    backgroundProcessTracker.cleanupDeadProcesses();
    showMessage(t('common:bgProcessManager.cleanedUp'));
    loadProcesses();
  };

  const handleKillAll = async () => {
    setLoading(true);
    const count = await backgroundProcessTracker.killAllProcesses();
    showMessage(t('common:bgProcessManager.killedCount', { count }));
    loadProcesses();
  };

  const handleKillSession = async () => {
    const currentSessionId = getSessionService().getCurrentSessionId();
    if (!currentSessionId) {
      showMessage(t('common:bgProcessManager.noActiveSession'), true);
      return;
    }
    setLoading(true);
    const count =
      await backgroundProcessTracker.killSessionProcesses(currentSessionId);
    showMessage(t('common:bgProcessManager.killedSessionCount', { count }));
    loadProcesses();
  };

  // Handle ESC key via KeypressProvider (works on all terminals including Ghostty)
  useEscapeHandler(onClose);

  // Use ref to avoid stale closure in additionalKeys callbacks
  const selectedIndexRef = useRef(0);

  const { selectedIndex } = useMenuNavigation({
    items: processes,
    initialIndex: 0,
    wrapAround: true,
    onSelect: (selected) => {
      void handleKill(selected.pid);
    },
    onCancel: onClose,
    additionalKeys: {
      // Keep lowercase for vim-style navigation in useMenuNavigation (j/k).
      K: () => {
        const selected = processes[selectedIndexRef.current];
        if (selected) void handleKill(selected.pid);
      },
      r: () => loadProcesses(),
      R: () => loadProcesses(),
      c: () => handleCleanup(),
      C: () => handleCleanup(),
      a: () => {
        void handleKillAll();
      },
      A: () => {
        void handleKillAll();
      },
      s: () => {
        void handleKillSession();
      },
      S: () => {
        void handleKillSession();
      },
    },
  });

  // Keep ref in sync with hook's selectedIndex
  selectedIndexRef.current = selectedIndex;

  return (
    <MenuContainer
      title={t('common:bgProcessManager.title')}
      helpText={t('common:bgProcessManager.helpText')}
      showDefaultHelp={false}
    >
      {loading && (
        <Text color={COLORS.text.muted}>
          {t('common:bgProcessManager.loading')}
        </Text>
      )}

      {message && (
        <Box marginBottom={1}>
          <Text
            color={message.includes('Failed') ? COLORS.error : COLORS.success}
          >
            {message}
          </Text>
        </Box>
      )}

      {!loading && processes.length === 0 && (
        <Text color={COLORS.text.muted}>
          {t('common:bgProcessManager.noProcesses')}
        </Text>
      )}

      {!loading && processes.length > 0 && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={COLORS.text.secondary}>
              {t('common:bgProcessManager.columnPid').padEnd(8)}{' '}
              {t('common:bgProcessManager.columnAge').padEnd(8)}{' '}
              {t('common:bgProcessManager.columnSession').padEnd(12)}{' '}
              {t('common:bgProcessManager.columnCommand')}
            </Text>
          </Box>
          {processes.map((process, index) => {
            const isSelected = index === selectedIndex;
            const color = isSelected ? COLORS.primary : undefined;
            const sessionDisplay = process.isCurrentSession
              ? t('common:bgProcessManager.currentSession')
              : process.sessionId?.slice(0, 8) ||
                t('common:bgProcessManager.unknownSession');

            return (
              <Box key={process.pid}>
                <Text color={color}>
                  {isSelected ? '> ' : '  '}
                  {process.pid.toString().padEnd(8)}
                  {process.age.padEnd(8)}
                  {sessionDisplay.padEnd(12)}
                  {process.command.length > 50
                    ? `${process.command.slice(0, 47)}...`
                    : process.command}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </MenuContainer>
  );
}
