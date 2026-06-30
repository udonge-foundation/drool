/**
 * Kitty keyboard protocol detector and enabler.
 *
 * This mirrors Google Gemini CLI's approach: detect support once at startup,
 * then enable the protocol for zero‑config modified key handling on
 * supported terminals (Ghostty, iTerm2, WezTerm, Kitty, Alacritty, Foot, rio).
 *
 * Spec: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

import { logInfo } from '@industry/logging';

import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

let detectionComplete = false;
let protocolSupported = false;
let protocolEnabled = false;

type StdoutLike = {
  isTTY?: boolean;
  write: (text: string, callback?: () => void) => unknown;
};

interface KittyProtocolWriteOptions {
  stdout?: StdoutLike;
}

interface DisableKittyProtocolOptions extends KittyProtocolWriteOptions {
  force?: boolean;
}

async function writeProtocolSequence(
  sequence: string,
  stdout: StdoutLike = process.stdout
): Promise<void> {
  if (!stdout.isTTY) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 25);
    timeout.unref?.();

    stdout.write(sequence, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function enableKittyProtocol({
  stdout,
}: KittyProtocolWriteOptions = {}): Promise<void> {
  protocolEnabled = true;
  await writeProtocolSequence('\u001b[>1u', stdout);
}

export async function disableKittyProtocol({
  force = false,
  stdout,
}: DisableKittyProtocolOptions = {}): Promise<void> {
  if (!force && !protocolEnabled) {
    return;
  }

  protocolEnabled = false;
  await writeProtocolSequence('\u001b[<u', stdout);
}

/**
 * Detects Kitty keyboard protocol support and enables it if available.
 * Should be called once at app startup before rendering the UI.
 */
export async function detectAndEnableKittyProtocol(): Promise<boolean> {
  // DISABLE KITTY PROTOCOL FOR GHOSTTY ON LINUX
  // This fixes keyboard input issues where arrow keys show as 9A, 9B, 9C, 9D
  // and other keys like Enter, Tab, Backspace show as 9u, 13u, 127u
  if (
    process.platform === 'linux' &&
    process.env.TERM_PROGRAM?.toLowerCase() === 'ghostty'
  ) {
    logInfo('Ghostty on Linux detected - Kitty protocol disabled');
    detectionComplete = true;
    protocolSupported = false;
    protocolEnabled = false;
    return false;
  }

  if (detectionComplete) return protocolSupported;

  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      detectionComplete = true;
      resolve(false);
      return;
    }

    const originalRawMode = (process.stdin as unknown as { isRaw?: boolean })
      .isRaw;
    if (!originalRawMode) {
      // Enable raw mode to receive immediate key responses
      process.stdin.setRawMode?.(true);
    }

    let responseBuffer = '';
    let progressiveEnhancementReceived = false;
    let checkFinished = false;

    const handleData = (data: Buffer) => {
      responseBuffer += data.toString();

      // Progressive enhancement response: CSI ? <flags> u
      if (responseBuffer.includes('\u001b[') && responseBuffer.includes('u')) {
        progressiveEnhancementReceived = true;
      }

      // Device attributes response: CSI ? <attrs> c
      if (responseBuffer.includes('\u001b[') && responseBuffer.includes('c')) {
        if (!checkFinished) {
          checkFinished = true;
          process.stdin.removeListener('data', handleData);

          if (!originalRawMode) {
            process.stdin.setRawMode?.(false);
          }

          if (progressiveEnhancementReceived) {
            // Enable the protocol (progressive enhancement mode)
            void enableKittyProtocol();
            protocolSupported = true;

            // Disable on exit
            const shutdownCoordinator = getShutdownCoordinator();
            shutdownCoordinator.registerHook(
              'kitty-protocol',
              async () => {
                await disableKittyProtocol({ force: true });
              },
              { priority: SHUTDOWN_HOOK_PRIORITY.KittyProtocol }
            );
            // ShutdownCoordinator owns cleanup; `exit` is synchronous, so avoid fallback handlers.
          }

          detectionComplete = true;
          resolve(protocolSupported);
        }
      }
    };

    process.stdin.on('data', handleData);

    // Query progressive enhancement and device attributes
    process.stdout.write('\u001b[?u'); // Query support
    process.stdout.write('\u001b[c'); // DA query

    setTimeout(() => {
      if (!checkFinished) {
        process.stdin.removeListener('data', handleData);
        if (!originalRawMode) {
          process.stdin.setRawMode?.(false);
        }
        detectionComplete = true;
        resolve(false);
      }
    }, 150);
  });
}

export function isKittyProtocolEnabled(): boolean {
  return protocolEnabled;
}
