/**
 * Hook for managing bash mode in the chat interface
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  BashCommandResult,
  BashModeState,
  UseBashModeResult,
} from '@/hooks/types';
import { getTerminalService } from '@/services/TerminalService';
import {
  detectInteractiveWaitFromOutput,
  detectPreflightInteractiveCommand,
  formatInteractiveCommandBlockedMessage,
  formatInteractiveWaitMessage,
} from '@/tools/executors/client/shell/non-interactive-command-guard';
import { prepareBashResultForStorage } from '@/utils/bash-formatting';

const BASH_COMMAND_POLL_INTERVAL_MS = 50;
const BASH_CANCELLED_EXIT_CODE = 130;
const BASH_FAILURE_EXIT_CODE = 1;

/**
 * Custom hook for bash mode functionality
 */
export function useBashMode(): UseBashModeResult {
  const [bashMode, setBashMode] = useState<BashModeState>({
    isActive: false,
    isExecuting: false,
  });
  const activeTerminalIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelPromiseRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  const updateBashMode = useCallback(
    (updater: BashModeState | ((prev: BashModeState) => BashModeState)) => {
      if (!mountedRef.current) {
        return;
      }
      setBashMode(updater);
    },
    []
  );

  const activateBashMode = useCallback(() => {
    updateBashMode((prev) => ({ ...prev, isActive: true }));
  }, [updateBashMode]);

  const deactivateBashMode = useCallback(() => {
    updateBashMode((prev) => ({ ...prev, isActive: false }));
  }, [updateBashMode]);

  const toggleBashMode = useCallback(() => {
    updateBashMode((prev) => ({ ...prev, isActive: !prev.isActive }));
  }, [updateBashMode]);

  const cancelBashCommand = useCallback(async (): Promise<void> => {
    const terminalId = activeTerminalIdRef.current;
    const controller = abortControllerRef.current;

    if (!terminalId && !controller) {
      return;
    }

    if (cancelPromiseRef.current) {
      await cancelPromiseRef.current;
      return;
    }

    controller?.abort();

    if (!terminalId) {
      return;
    }

    const terminalService = getTerminalService();
    let cancellationPromise: Promise<void> | null = null;
    cancellationPromise = (async () => {
      try {
        await terminalService.kill(terminalId);
        await terminalService.waitForExit(terminalId).catch(() => {});
      } finally {
        if (cancelPromiseRef.current === cancellationPromise) {
          cancelPromiseRef.current = null;
        }
      }
    })();

    cancelPromiseRef.current = cancellationPromise;
    await cancellationPromise;
  }, []);

  useEffect(
    () => () => {
      mountedRef.current = false;
      void cancelBashCommand();
    },
    [cancelBashCommand]
  );

  const executeBashCommand = useCallback(
    async (command: string): Promise<BashCommandResult> => {
      const trimmedCommand = command.trim();
      const interactiveMatch =
        detectPreflightInteractiveCommand(trimmedCommand);
      if (interactiveMatch) {
        return {
          command,
          stdout: '',
          stderr: formatInteractiveCommandBlockedMessage(interactiveMatch),
          exitCode: BASH_FAILURE_EXIT_CODE,
        };
      }

      updateBashMode((prev) => ({ ...prev, isExecuting: true }));

      const terminalService = getTerminalService();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      cancelPromiseRef.current = null;

      let terminalId: string | null = null;
      let combinedOutput = '';
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let autoStoppedMessage: string | null = null;

      try {
        const cwd = process.cwd();
        const createdTerminal = await terminalService.create({
          command: trimmedCommand,
          cwd,
        });
        terminalId = createdTerminal.terminalId;
        activeTerminalIdRef.current = terminalId;

        if (abortController.signal.aborted) {
          await terminalService.kill(terminalId).catch(() => {});
          await terminalService.waitForExit(terminalId).catch(() => {});
          return {
            command,
            stdout: combinedOutput,
            stderr: 'Command cancelled by user.',
            exitCode: BASH_CANCELLED_EXIT_CODE,
          };
        }

        while (!abortController.signal.aborted) {
          const outputResult = await terminalService.getOutput(terminalId);
          combinedOutput = outputResult.output;

          if (outputResult.exitStatus) {
            exitCode = outputResult.exitStatus.exitCode ?? null;
            exitSignal = outputResult.exitStatus.signal ?? null;
            break;
          }

          const interactiveWaitMatch =
            detectInteractiveWaitFromOutput(combinedOutput);
          if (interactiveWaitMatch) {
            autoStoppedMessage =
              formatInteractiveWaitMessage(interactiveWaitMatch);
            await terminalService.kill(terminalId);
            const exitStatus = await terminalService
              .waitForExit(terminalId)
              .catch(() => ({
                exitCode: null,
                signal: 'SIGTERM',
              }));
            exitCode = exitStatus.exitCode ?? null;
            exitSignal = exitStatus.signal ?? null;
            break;
          }

          await new Promise<void>((resolve) => {
            setTimeout(resolve, BASH_COMMAND_POLL_INTERVAL_MS);
          });
        }

        if (abortController.signal.aborted) {
          return {
            command,
            stdout: combinedOutput,
            stderr: 'Command cancelled by user.',
            exitCode: BASH_CANCELLED_EXIT_CODE,
          };
        }

        return {
          command,
          stdout: combinedOutput,
          stderr:
            autoStoppedMessage ??
            (exitSignal ? `Process terminated with signal: ${exitSignal}` : ''),
          exitCode:
            autoStoppedMessage !== null
              ? BASH_FAILURE_EXIT_CODE
              : (exitCode ?? 0),
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Command failed';
        return {
          command,
          stdout: combinedOutput,
          stderr: errorMessage,
          exitCode: BASH_FAILURE_EXIT_CODE,
        };
      } finally {
        activeTerminalIdRef.current = null;
        abortControllerRef.current = null;
        cancelPromiseRef.current = null;

        if (terminalId) {
          await terminalService.release(terminalId).catch(() => {});
        }

        updateBashMode((prev) => ({ ...prev, isExecuting: false }));
      }
    },
    [updateBashMode]
  );

  return {
    bashMode,
    activateBashMode,
    deactivateBashMode,
    toggleBashMode,
    cancelBashCommand,
    executeBashCommand,
  };
}

/**
 * Format bash command result for display
 */
export function formatBashCommandMessage(result: BashCommandResult): string {
  const preparedResult = prepareBashResultForStorage(
    result.command,
    result.stdout || '',
    result.stderr || '',
    result.exitCode || 0,
    {
      truncateCommand: false,
      truncateOutput: false,
    }
  );

  // Return a JSON string that can be parsed by the display component
  return JSON.stringify(preparedResult);
}
