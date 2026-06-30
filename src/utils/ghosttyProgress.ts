import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

const ESC_PREFIX = '\u001b]9;4;';
const BEL = '\u0007';
const ST = '\u001b\\';

type GhosttyProgressState = 0 | 1 | 2 | 3;

let supportChecked = false;
let cachedSupport = false;
let useStringTerminator = false;
let lastPayload: string | null = null;
let lastState: GhosttyProgressState | null = null;
let errorTimeoutId: NodeJS.Timeout | null = null;
let refreshIntervalId: ReturnType<typeof setInterval> | null = null;

const supportsGhosttyProgress = (): boolean => {
  if (!supportChecked) {
    const termProgram = process.env.TERM_PROGRAM?.toLowerCase() ?? '';
    cachedSupport = Boolean(
      process.stdout.isTTY && termProgram.includes('ghostty')
    );
    useStringTerminator = Boolean(process.env.GHOSTTY_ENABLE_ST);
    supportChecked = true;
  }
  return cachedSupport;
};

const formatPercent = (value: number) =>
  Math.max(0, Math.min(100, Math.round(value)));

const clearPayloadCache = () => {
  lastPayload = null;
  lastState = null;
};

let shutdownHookRegistered = false;

const writeSequence = (state: GhosttyProgressState, value?: number) => {
  if (!supportsGhosttyProgress()) return;

  if (!shutdownHookRegistered) {
    shutdownHookRegistered = true;
    const shutdownCoordinator = getShutdownCoordinator();
    shutdownCoordinator.registerHook(
      'ghostty-progress',
      async () => {
        if (errorTimeoutId) {
          clearTimeout(errorTimeoutId);
          errorTimeoutId = null;
        }
        if (refreshIntervalId) {
          clearInterval(refreshIntervalId);
          refreshIntervalId = null;
        }
        writeSequence(0);
        clearPayloadCache();
      },
      { priority: SHUTDOWN_HOOK_PRIORITY.GhosttyProgress }
    );
  }

  const payloadBase = `${ESC_PREFIX}${state};${
    value != null ? `${formatPercent(value)}` : ''
  }`;

  // If state changed, always send the update (don't check payload cache)
  // This ensures progress indicators restart properly between commands
  if (state !== lastState) {
    lastState = state;
    lastPayload = payloadBase;
  } else if (payloadBase === lastPayload) {
    // Same state and same payload, skip to avoid duplicate sequences
    return;
  } else {
    lastPayload = payloadBase;
  }

  // Always write with BEL terminator for compatibility
  process.stdout.write(`${payloadBase}${BEL}`);

  // Additionally write with ST terminator if requested
  if (useStringTerminator) {
    process.stdout.write(`${payloadBase}${ST}`);
  }
};

export function ghosttyProgressIsSupported(): boolean {
  return supportsGhosttyProgress();
}

export function ghosttyProgressClear(): void {
  // Clear any pending error timeout
  if (errorTimeoutId) {
    clearTimeout(errorTimeoutId);
    errorTimeoutId = null;
  }

  // Clear any refresh interval
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }

  writeSequence(0);
  clearPayloadCache();
}

export function ghosttyProgressStartIndeterminate(): void {
  // Clear cache to ensure the indeterminate progress always starts fresh
  clearPayloadCache();

  // Clear any existing refresh interval
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }

  // Force clear then start to ensure clean state
  writeSequence(0); // Clear any existing progress
  writeSequence(3); // Start indeterminate

  // Refresh the progress indicator every 5 seconds to keep it alive
  // This helps prevent the indicator from disappearing due to terminal state issues
  refreshIntervalId = setInterval(() => {
    // Force resend the indeterminate state
    lastPayload = null; // Clear cache to force resend
    writeSequence(3);
  }, 5000);
}

export function ghosttyProgressMarkError(): void {
  // Clear any existing error timeout
  if (errorTimeoutId) {
    clearTimeout(errorTimeoutId);
    errorTimeoutId = null;
  }

  writeSequence(2);

  // Auto-clear error state after 1.5 seconds
  errorTimeoutId = setTimeout(() => {
    ghosttyProgressClear();
    errorTimeoutId = null;
  }, 1500);
}
