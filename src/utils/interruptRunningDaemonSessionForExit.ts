import { logWarn } from '@industry/logging';

import { AgentStatusState } from '@/hooks/enums';

interface InterruptRunningDaemonSessionForExitOptions {
  sessionId?: string | null;
  sessionStatus: AgentStatusState;
  interruptSession: (sessionId: string) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_INTERRUPT_TIMEOUT_MS = 750;

export async function interruptRunningDaemonSessionForExit({
  sessionId,
  sessionStatus,
  interruptSession,
  timeoutMs = DEFAULT_INTERRUPT_TIMEOUT_MS,
}: InterruptRunningDaemonSessionForExitOptions): Promise<void> {
  if (!sessionId || sessionStatus === AgentStatusState.Idle) {
    return;
  }

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
  });

  try {
    await Promise.race([
      interruptSession(sessionId).catch((error) => {
        logWarn('[App] Failed to interrupt daemon session during Ctrl+C exit', {
          sessionId,
          cause: error,
        });
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
