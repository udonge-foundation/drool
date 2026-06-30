/**
 * KeypressProvider for handling raw keyboard input and paste detection.
 *
 * ## IME (Input Method Editor) Compatibility
 *
 * This provider works correctly when the system IME is active (e.g., Japanese,
 * Chinese, or Korean input). Key behaviors:
 *
 * - **Ctrl+key shortcuts** (Ctrl+C, Ctrl+L, Ctrl+N, Ctrl+O, Ctrl+P, Ctrl+T, Ctrl+X):
 *   These produce ASCII control characters (0x01–0x1A) that are sent by the
 *   terminal emulator BEFORE any IME processing. They always work regardless
 *   of IME state.
 *
 * - **Escape key**: When IME is composing text, the first Esc dismisses the
 *   IME composition window (consumed by IME, not received by the app). The
 *   next Esc is received normally, so repeated-Esc handling still works.
 *
 * - **Shift+Enter**: Produces terminal-specific escape sequences (\\\r\n in
 *   older Drool configs, ESC[13;2u in Kitty protocol, ESC[27;2;13~ in
 *   Ghostty/iTerm2) that bypass IME.
 *
 * - **Tab / Shift+Tab**: Tab (0x09) and Shift+Tab (ESC[Z) bypass IME.
 *
 * - **Pre-edit composition**: Ink does not receive IME composition events.
 *   The terminal handles the IME overlay. Only the final confirmed text is
 *   sent as regular input to this provider.
 */

import readline from 'readline';
import { PassThrough } from 'stream';

import { useStdin } from 'ink';
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
} from 'react';

import { logException } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { ANSI } from '@/components/chat/constants';
import { KeypressLayer } from '@/contexts/enums';
import {
  getTerminalFocusState,
  setTerminalFocusState,
} from '@/contexts/terminalFocusState';
import type {
  KeyEvent,
  KeypressHandler,
  KeypressContextValue,
  ReadlineKey,
} from '@/contexts/types';
import { ESC_27U } from '@/hooks/constants';
import {
  classifyKeyEvent,
  recordInputLatency,
} from '@/utils/inputLatencyMetrics';
import { restoreInteractiveTerminalState } from '@/utils/interactiveTerminalState';
import { disableKittyProtocol } from '@/utils/kittyProtocolDetector';
import {
  extractTerminalClipboardPackets,
  rejectPendingTerminalClipboardRequests,
  resetTerminalClipboardExtractorState,
} from '@/utils/terminalClipboardProtocol';

// ANSI escape sequences for bracketed paste mode
const ESC = '\x1b';
const PASTE_MODE_PREFIX = `${ESC}[200~`;
const PASTE_MODE_SUFFIX = `${ESC}[201~`;
const STANDALONE_ESCAPE_FRAGMENT_TIMEOUT_MS = 400;
const ESCAPE_RUN_FRAGMENT_TIMEOUT_MS = 150;
// Default tmux can deliver ESC ESC, then the third ESC hundreds of ms later.
// Keep this transport grace independent from chat-layer repeated-key timing.
const TMUX_SPLIT_ESCAPE_RUN_GRACE_MS = 650;
const TMUX_SPLIT_ESCAPE_RUN_FLUSH_MS = 20;
const CSI_ESCAPE_SEQUENCE_FRAGMENT_TIMEOUT_MS = 250;
const TERMINAL_SHUTDOWN_QUIET_MS = 30;
const TERMINAL_SHUTDOWN_TIMEOUT_MS = 100;
const KEYPRESS_LAYER_ORDER = [
  KeypressLayer.System,
  KeypressLayer.Overlay,
  KeypressLayer.Navigation,
  KeypressLayer.Input,
  KeypressLayer.AgentControl,
  KeypressLayer.Observer,
] as const;

type IdleEscapeParserState = { kind: 'idle' };
type BufferingEscapeRunParserState = {
  kind: 'buffering-escape-run';
  fragment: string;
  startedAt: number;
  continuationDeadline?: number;
};
type BufferingCsiParserState = {
  kind: 'buffering-csi-sequence';
  fragment: string;
  startedAt: number;
};
type RecentlyEmittedEscapeRunParserState = {
  kind: 'recently-emitted-escape-run';
  emittedAt: number;
};
type BufferingEscapeParserState =
  | BufferingEscapeRunParserState
  | BufferingCsiParserState;
type EscapeParserState =
  | IdleEscapeParserState
  | BufferingEscapeParserState
  | RecentlyEmittedEscapeRunParserState;

const isBufferingEscapeParserState = (
  state: EscapeParserState
): state is BufferingEscapeParserState =>
  state.kind === 'buffering-escape-run' ||
  state.kind === 'buffering-csi-sequence';

export const KeypressContext = createContext<KeypressContextValue | undefined>(
  undefined
);

// Module-level state for terminal focus lives in @/contexts/terminalFocusState
// to keep this file (and ink) out of non-TUI import graphs.
let lastActualScrollInputAt = 0;
let keypressProviderShutdownPromise: Promise<void> = Promise.resolve();
let nextKeypressProviderInstanceId = 1;
let activeKeypressProviderInstanceId = 0;

function setKeypressProviderShutdownPromise(promise: Promise<void>): void {
  keypressProviderShutdownPromise = promise.catch((error) => {
    logException(error, 'KeypressProvider shutdown failed');
  });
}

export function waitForKeypressProviderShutdown(): Promise<void> {
  return keypressProviderShutdownPromise;
}

export function getLastActualScrollInputAt(): number {
  return lastActualScrollInputAt;
}

export function isActualScrollInputEvent(event: KeyEvent): boolean {
  return Boolean(
    event.key.upArrow ||
      event.key.downArrow ||
      event.key.pageUp ||
      event.key.pageDown ||
      event.key.home ||
      event.key.end
  );
}

export function useKeypressProvider() {
  const context = useContext(KeypressContext);
  // In NonInteractiveCLI (exec) we render without the full TUI provider tree.
  // Some hooks read keypress state opportunistically; provide a safe no-op context.
  if (!context) {
    return {
      isEnabled: false,
      subscribe: () => {},
      unsubscribe: () => {},
      setEnabled: () => {},
      setEnabledAndWait: async () => {},
      isTerminalFocused: true,
      getExitSpecModeComment: () => undefined,
      setExitSpecModeComment: () => {},
      getMissionProposalComment: () => undefined,
      setMissionProposalComment: () => {},
      handlerRef: { current: undefined },
    } satisfies KeypressContextValue;
  }
  return context;
}

interface KeypressProviderProps {
  children: React.ReactNode;
  enabled?: boolean;
}

export function KeypressProvider({
  children,
  enabled = true,
}: KeypressProviderProps) {
  const [isEnabled, setIsEnabled] = useState(enabled);
  const { stdin, setRawMode } = useStdin();
  const subscribers = useRef<Map<KeypressHandler, KeypressLayer>>(
    new Map()
  ).current;
  const handlerRef = useRef<KeypressHandler | undefined>(undefined);
  const lastSimpleRef = useRef<{ ch: string; t: number } | null>(null);
  const [isTerminalFocused, setIsTerminalFocused] = useState(true);
  const isUnmountingRef = useRef(false);
  const instanceIdRef = useRef<number>(nextKeypressProviderInstanceId++);
  const currentEnabledRef = useRef(enabled);
  const transitionWaitersRef = useRef<
    Array<{ targetEnabled: boolean; resolve: () => void }>
  >([]);
  const transitionChainRef = useRef(Promise.resolve());
  const exitSpecModeCommentRef = useRef<string | undefined>(undefined);
  const missionProposalCommentRef = useRef<string | undefined>(undefined);

  // Keep this passive and declared above the stdin effect below: React runs
  // passive unmount cleanups in hook declaration order, so this marker flips
  // before the stdin cleanup branches between re-render teardown and real
  // unmount quarantine.
  useEffect(() => {
    isUnmountingRef.current = false;
    activeKeypressProviderInstanceId = instanceIdRef.current;

    return () => {
      isUnmountingRef.current = true;
    };
  }, []);

  // Helper to update both React state and module-level state
  const updateTerminalFocusState = useCallback((focused: boolean) => {
    setTerminalFocusState(focused);
    setIsTerminalFocused(focused);
  }, []);

  const subscribe = useCallback(
    (handler: KeypressHandler, options: { layer?: KeypressLayer } = {}) => {
      subscribers.set(handler, options.layer ?? KeypressLayer.Overlay);
    },
    [subscribers]
  );

  const unsubscribe = useCallback(
    (handler: KeypressHandler) => {
      subscribers.delete(handler);
    },
    [subscribers]
  );

  const resolveTransitionWaiters = useCallback((targetEnabled: boolean) => {
    const waitersToResolve = transitionWaitersRef.current.filter(
      (waiter) => waiter.targetEnabled === targetEnabled
    );
    transitionWaitersRef.current = transitionWaitersRef.current.filter(
      (waiter) => waiter.targetEnabled !== targetEnabled
    );

    for (const waiter of waitersToResolve) {
      waiter.resolve();
    }
  }, []);

  const waitForEnabledState = useCallback((targetEnabled: boolean) => {
    if (currentEnabledRef.current === targetEnabled) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      transitionWaitersRef.current.push({ targetEnabled, resolve });
    });
  }, []);

  const setEnabledAndWait = useCallback(
    (targetEnabled: boolean): Promise<void> => {
      const transition = transitionChainRef.current.then(async () => {
        if (currentEnabledRef.current === targetEnabled) {
          return;
        }

        const waitForTransition = waitForEnabledState(targetEnabled);
        setIsEnabled(targetEnabled);
        await waitForTransition;
      });

      transitionChainRef.current = transition.catch(() => undefined);
      return transition;
    },
    [waitForEnabledState]
  );

  // useEffect required for stdin event listeners - must be set up after mount
  // and cleaned up before unmount to prevent memory leaks
  useEffect(() => {
    // Skip broadcasting if provider is disabled
    if (!isEnabled) {
      stdin.pause();
      currentEnabledRef.current = false;
      resolveTransitionWaiters(false);
      return () => {
        if (!isUnmountingRef.current) {
          stdin.resume();
        }
      };
    }

    restoreInteractiveTerminalState({ setRawMode });
    lastActualScrollInputAt = 0;

    // Always use PassThrough stream for consistent paste handling across all terminals
    const keypressStream = new PassThrough();
    const pasteModePrefixBuffer = Buffer.from(PASTE_MODE_PREFIX);
    const pasteModeSuffixBuffer = Buffer.from(PASTE_MODE_SUFFIX);

    let isPaste = false;
    let pasteBuffer = Buffer.alloc(0);
    let waitingForEnterAfterBackslash = false;
    let backslashTimeout: NodeJS.Timeout | null = null;
    let escapeParserState: EscapeParserState = { kind: 'idle' };
    let pendingEscapeSequenceTimeout: NodeJS.Timeout | null = null;
    let terminalShutdownQuietTimer: NodeJS.Timeout | null = null;
    let terminalShutdownTimeout: NodeJS.Timeout | null = null;
    let isShuttingDown = false;
    let lastShutdownInputAt = 0;
    let rawDataHandler: ((data: Buffer | string) => void) | null = null;
    let rl: readline.Interface | null = null;

    const clearTerminalShutdownTimers = () => {
      if (terminalShutdownQuietTimer) {
        clearTimeout(terminalShutdownQuietTimer);
        terminalShutdownQuietTimer = null;
      }
      if (terminalShutdownTimeout) {
        clearTimeout(terminalShutdownTimeout);
        terminalShutdownTimeout = null;
      }
    };

    const broadcastImmediate = (event: KeyEvent) => {
      if (isShuttingDown) {
        return;
      }

      if (event.receivedAtMs !== undefined) {
        recordInputLatency(
          Metric.CLI_TUI_KEYPRESS_QUEUE_LATENCY,
          performance.now() - event.receivedAtMs,
          { inputKind: classifyKeyEvent(event) }
        );
      }

      // Central dedupe scoped to '@' only to avoid dropping legitimate repeats
      if (!event.isPaste && event.input === '@') {
        const now = Date.now();
        if (
          lastSimpleRef.current &&
          lastSimpleRef.current.ch === '@' &&
          now - lastSimpleRef.current.t < 20
        ) {
          return; // drop accidental duplicate '@'
        }
        lastSimpleRef.current = { ch: '@', t: now };
      }

      for (const layer of KEYPRESS_LAYER_ORDER) {
        for (const [handler, handlerLayer] of subscribers) {
          if (handlerLayer !== layer) {
            continue;
          }

          try {
            const result = handler(event);
            if (result === true || result === 'handled') {
              return;
            }
          } catch (error) {
            // Swallow subscriber errors to keep input pipeline alive
            logException(error, 'KeypressProvider subscriber error');
          }
        }
      }
    };

    // Queue to ensure each keypress gets its own React render cycle.
    // After any keypress that triggers a setState, React schedules a
    // render via MessageChannel. If the next keypress arrives before
    // that render completes, React batches both setState calls and the
    // UI jumps (e.g. cursor skips a menu item). By draining one event
    // per setTimeout(0) — which fires after React's MessageChannel —
    // each keypress gets its own render cycle.
    //
    // The very first keypress is always processed synchronously (no
    // prior render to wait for). Every subsequent keypress goes through
    // the queue so the previous render can complete first.
    const keypressQueue: KeyEvent[] = [];
    let hasPendingRender = false;

    const isBareEscapeEvent = (event: KeyEvent): boolean =>
      Boolean(
        event.key.escape &&
          event.input === ESC &&
          !event.key.ctrl &&
          !event.key.meta &&
          !event.key.shift
      );

    const drainQueue = () => {
      if (isShuttingDown) {
        keypressQueue.length = 0;
        hasPendingRender = false;
        return;
      }

      if (keypressQueue.length === 0) {
        hasPendingRender = false;
        return;
      }
      const event = keypressQueue.shift()!;
      broadcastImmediate(event);
      // Schedule next drain after React's scheduler flushes
      setTimeout(drainQueue, 0);
    };

    const broadcast = (event: KeyEvent) => {
      if (isShuttingDown) {
        return;
      }

      event.receivedAtMs ??= performance.now();

      if (
        !isBareEscapeEvent(event) &&
        escapeParserState.kind === 'recently-emitted-escape-run'
      ) {
        escapeParserState = { kind: 'idle' };
      }

      if (isActualScrollInputEvent(event)) {
        lastActualScrollInputAt = Date.now();
      }

      // Paste events bypass the queue — they're already buffered and
      // should be delivered immediately as a single unit.
      if (event.isPaste) {
        broadcastImmediate(event);
        return;
      }

      if (!hasPendingRender) {
        // No prior keypress waiting to render — process immediately.
        // This is the common case for single keypresses (zero overhead).
        hasPendingRender = true;
        broadcastImmediate(event);
        // Schedule a drain to reset hasPendingRender after React renders.
        // If no more keypresses arrive, drainQueue just resets the flag.
        setTimeout(drainQueue, 0);
      } else {
        // A previous keypress is still waiting for React to render.
        // Enqueue to preserve ordering and give React time to flush.
        keypressQueue.push(event);
      }
    };

    // Transform readline key format to Ink's format
    const transformKey = (
      key: ReadlineKey | undefined
    ): Record<string, unknown> => {
      if (!key) return {};

      const transformed: Record<string, unknown> = {
        ctrl: key.ctrl || false,
        meta: key.meta || false,
        alt: key.alt || key.meta || false,
        shift: key.shift || false,
      };

      // Map key names to boolean properties (Ink's format)
      if (key.name) {
        switch (key.name) {
          case 'tab':
            transformed.tab = true;
            break;
          case 'return':
            transformed.return = true;
            break;
          case 'escape':
            transformed.escape = true;
            break;
          case 'backspace':
            transformed.backspace = true;
            break;
          case 'delete':
            transformed.delete = true;
            break;
          case 'up':
            transformed.upArrow = true;
            break;
          case 'down':
            transformed.downArrow = true;
            break;
          case 'left':
            transformed.leftArrow = true;
            break;
          case 'right':
            transformed.rightArrow = true;
            break;
          case 'pageup':
            transformed.pageUp = true;
            break;
          case 'pagedown':
            transformed.pageDown = true;
            break;
          case 'home':
            transformed.home = true;
            break;
          case 'end':
            transformed.end = true;
            break;
          default:
            // Keep the name for other keys
            transformed.name = key.name;
        }
      }

      // Preserve sequence if present
      if (key.sequence) {
        transformed.sequence = key.sequence;
      }

      return transformed;
    };

    // Handle regular keypress events from readline
    const handleKeypress = (
      input: string | undefined,
      key: ReadlineKey | undefined
    ) => {
      if (isShuttingDown) {
        return;
      }

      // Handle special paste markers
      if (key?.name === 'paste-start') {
        isPaste = true;
        return;
      }
      if (key?.name === 'paste-end') {
        isPaste = false;
        // Send the complete pasted text as a single event
        broadcast({
          key: { name: 'paste', ctrl: false, meta: false, shift: false },
          input: pasteBuffer.toString('utf8'),
          isPaste: true,
        });
        pasteBuffer = Buffer.alloc(0);
        return;
      }

      // Buffer paste content between markers
      if (isPaste) {
        const pasteChunk = input ?? key?.sequence;
        if (pasteChunk) {
          pasteBuffer = Buffer.concat([pasteBuffer, Buffer.from(pasteChunk)]);
        }
        return;
      }

      // Detect Kitty protocol escape key (\x1b[27u or just [27u])
      if (key?.sequence === ANSI.ESC_KITTY || key?.sequence === ESC_27U) {
        if (key) {
          key.name = 'escape';
        }
      }

      // Check for Shift+Enter special sequences that readline doesn't recognize
      // First check if readline properly detected Shift+Enter
      if (key?.name === 'return' && key?.shift) {
        // Readline properly detected Shift+Enter
        broadcast({
          key: { return: true, shift: true, ctrl: false, meta: false },
          input: input || '',
          isPaste: false,
        });
        return;
      }

      // Legacy Drool VSCode terminal-setup sends '\\\r\n' for Shift+Enter.
      // When input is empty: '\\\r\n' comes as a single input.
      // When input has text: '\\\r\n' may come split as '\' then '\r\n'.

      // Handle '\\\r\n' or '\\\r' pattern (empty input case)
      if (input === '\\\r\n' || input === '\\\r') {
        broadcast({
          key: { return: true, shift: true, ctrl: false, meta: false },
          input: '\n',
          isPaste: false,
        });
        return;
      }

      // Handle backslash followed by Enter/CRLF within 5ms (text present case)
      if (
        waitingForEnterAfterBackslash &&
        (key?.name === 'return' || input === '\r\n' || input === '\r')
      ) {
        if (backslashTimeout) {
          clearTimeout(backslashTimeout);
          backslashTimeout = null;
        }
        waitingForEnterAfterBackslash = false;
        broadcast({
          key: { return: true, shift: true, ctrl: false, meta: false },
          input: '\n',
          isPaste: false,
        });
        return;
      }

      // Start waiting for Enter after backslash
      // VSCode sends backslash with different key signatures:
      // - Empty input: no key object (!key)
      // - With text: key object with name=undefined
      if (input === '\\' && (!key || !key.name)) {
        waitingForEnterAfterBackslash = true;
        backslashTimeout = setTimeout(() => {
          // If Enter doesn't arrive within 5ms, treat it as a regular backslash
          waitingForEnterAfterBackslash = false;
          backslashTimeout = null;
          broadcast({
            key: transformKey(key),
            input: '\\',
            isPaste: false,
          });
        }, 5); // 5ms window to detect Shift+Enter pattern
        return;
      }

      // Cancel backslash waiting if any other key arrives
      if (
        waitingForEnterAfterBackslash &&
        key?.name !== 'return' &&
        input !== '\r\n' &&
        input !== '\r'
      ) {
        if (backslashTimeout) {
          clearTimeout(backslashTimeout);
          backslashTimeout = null;
        }
        waitingForEnterAfterBackslash = false;
        // Send the buffered backslash first
        broadcast({
          key: transformKey(undefined),
          input: '\\',
          isPaste: false,
        });
        // Then handle the current key normally (don't return, let it fall through)
      }

      // Regular keypress - forward to subscribers with transformed key
      broadcast({
        key: transformKey(key),
        input: input || '',
        isPaste: false,
      });
    };

    // Decode Kitty CSI-u sequences from raw data. Returns remaining data
    // with CSI-u sequences removed (they are broadcast directly).
    // Format: ESC [ <code> u  or  ESC [ <code> ; <mods> u
    //         ESC [ <code> ; <mods> : <event-type> u
    const parseCsiUSequence = (
      data: string,
      start: number
    ): {
      matchLength: number;
      code: number;
      modParam: number;
      eventType: number;
    } | null => {
      if (data[start] !== ESC || data[start + 1] !== '[') {
        return null;
      }

      let index = start + 2;
      const codeStart = index;
      while (index < data.length && data[index] >= '0' && data[index] <= '9') {
        index++;
      }
      if (
        index === codeStart ||
        (data[index] !== 'u' && data[index] !== ';' && data[index] !== ':')
      ) {
        return null;
      }

      const code = parseInt(data.slice(codeStart, index), 10);
      let modParam = 1;
      let eventType = 1;

      // Optional ignored part: :<...>
      if (data[index] === ':') {
        index++;
        while (
          index < data.length &&
          data[index] !== ';' &&
          data[index] !== 'u'
        ) {
          index++;
        }
      }

      // Optional modifiers: ;<mods>(:<eventType>)?
      if (data[index] === ';') {
        index++;
        const modStart = index;
        while (
          index < data.length &&
          data[index] >= '0' &&
          data[index] <= '9'
        ) {
          index++;
        }
        if (index > modStart) {
          modParam = parseInt(data.slice(modStart, index), 10);
        }

        if (data[index] === ':') {
          index++;
          const eventTypeStart = index;
          while (
            index < data.length &&
            data[index] >= '0' &&
            data[index] <= '9'
          ) {
            index++;
          }
          if (index > eventTypeStart) {
            eventType = parseInt(data.slice(eventTypeStart, index), 10);
          }
        }

        // Optional trailing params: ;<...>
        while (data[index] === ';') {
          index++;
          while (
            index < data.length &&
            data[index] !== ';' &&
            data[index] !== 'u'
          ) {
            index++;
          }
        }
      }

      if (data[index] !== 'u') {
        return null;
      }

      return {
        matchLength: index - start + 1,
        code,
        modParam,
        eventType,
      };
    };

    const decodeCsiUKeyName = (code: number): string | undefined => {
      switch (code) {
        case 13:
        case 57414: // KP_ENTER (Kitty keyboard protocol)
          return 'return';
        case 9:
          return 'tab';
        case 27:
          return 'escape';
        case 127:
        case 8:
          return 'backspace';
        case 57417: // KP_LEFT
          return 'leftArrow';
        case 57418: // KP_RIGHT
          return 'rightArrow';
        case 57419: // KP_UP
          return 'upArrow';
        case 57420: // KP_DOWN
          return 'downArrow';
        case 57421: // KP_PAGE_UP
          return 'pageUp';
        case 57422: // KP_PAGE_DOWN
          return 'pageDown';
        case 57423: // KP_HOME
          return 'home';
        case 57424: // KP_END
          return 'end';
        case 57425: // KP_INSERT
          return 'insert';
        case 57426: // KP_DELETE
          return 'delete';
        default:
          return undefined;
      }
    };

    // Map Kitty keypad digit/operator codes to their text equivalents.
    const decodeCsiUKeypadChar = (code: number): string | undefined => {
      if (code >= 57399 && code <= 57408) {
        return String(code - 57399); // KP_0..KP_9
      }
      switch (code) {
        case 57409:
          return '.'; // KP_DECIMAL
        case 57410:
          return '/'; // KP_DIVIDE
        case 57411:
          return '*'; // KP_MULTIPLY
        case 57412:
          return '-'; // KP_SUBTRACT
        case 57413:
          return '+'; // KP_ADD
        case 57415:
          return '='; // KP_EQUAL
        case 57416:
          return ','; // KP_SEPARATOR
        default:
          return undefined;
      }
    };

    type InputSegment =
      | { type: 'text'; data: string }
      | { type: 'key'; event: KeyEvent };

    const parseXtermModifyOtherKeysSequence = (
      data: string,
      start: number
    ): { matchLength: number; modParam: number; code: number } | null => {
      if (!data.startsWith(`${ESC}[27;`, start)) {
        return null;
      }

      let index = start + 5;
      const modStart = index;
      while (index < data.length && data[index] >= '0' && data[index] <= '9') {
        index++;
      }

      if (index === modStart || data[index] !== ';') {
        return null;
      }

      const modParam = parseInt(data.slice(modStart, index), 10);
      index++;
      const codeStart = index;
      while (index < data.length && data[index] >= '0' && data[index] <= '9') {
        index++;
      }
      if (index === codeStart || data[index] !== '~') {
        return null;
      }
      const code = parseInt(data.slice(codeStart, index), 10);

      return {
        matchLength: index - start + 1,
        modParam,
        code,
      };
    };

    const decodeModifierFlags = (modParam: number, metaMask: number) => {
      const modBits = Math.max(0, modParam - 1);

      return {
        // eslint-disable-next-line no-bitwise
        shift: !!(modBits & 1),
        // eslint-disable-next-line no-bitwise
        alt: !!(modBits & 2),
        // eslint-disable-next-line no-bitwise
        meta: !!(modBits & metaMask),
        // eslint-disable-next-line no-bitwise
        ctrl: !!(modBits & 4),
      };
    };

    const buildXtermModifyOtherKeysEvent = (
      code: number,
      modParam: number
    ): KeyEvent | null => {
      // Keep an explicit Alt bit while preserving the collapsed meta flag for
      // existing callers that treat Alt/Meta/Super as one modifier family.
      const flags = decodeModifierFlags(modParam, 0b1010);
      const keyName = decodeCsiUKeyName(code);
      if (keyName) {
        return {
          key: { ...flags, [keyName]: true },
          input: '',
          isPaste: false,
        };
      }
      if (code >= 32 && code <= 0x10ffff) {
        return {
          key: flags,
          input: String.fromCodePoint(code),
          isPaste: false,
        };
      }
      return null;
    };

    type ModifiedCursorKeyFlag =
      | 'upArrow'
      | 'downArrow'
      | 'rightArrow'
      | 'leftArrow'
      | 'home'
      | 'end';

    const MODIFIED_CURSOR_KEY_FLAGS: Record<string, ModifiedCursorKeyFlag> = {
      A: 'upArrow',
      B: 'downArrow',
      C: 'rightArrow',
      D: 'leftArrow',
      H: 'home',
      F: 'end',
    };

    const parseXtermModifiedCursorSequence = (
      data: string,
      start: number
    ): {
      matchLength: number;
      modParam: number;
      flag: ModifiedCursorKeyFlag;
    } | null => {
      if (!data.startsWith(`${ESC}[`, start)) {
        return null;
      }

      let index = start + 2;
      const prefixStart = index;
      while (index < data.length && data[index] >= '0' && data[index] <= '9') {
        index++;
      }
      if (index === prefixStart || data[index] !== ';') {
        return null;
      }

      index++;
      const modStart = index;
      while (index < data.length && data[index] >= '0' && data[index] <= '9') {
        index++;
      }
      if (index === modStart) {
        return null;
      }

      const flag = MODIFIED_CURSOR_KEY_FLAGS[data[index] ?? ''];
      if (!flag) {
        return null;
      }

      return {
        matchLength: index - start + 1,
        modParam: parseInt(data.slice(modStart, index), 10),
        flag,
      };
    };

    const buildXtermModifiedCursorEvent = (
      flag: ModifiedCursorKeyFlag,
      modParam: number
    ): KeyEvent => {
      const flags = decodeModifierFlags(modParam, 0b1010);
      return {
        key: { ...flags, [flag]: true },
        input: '',
        isPaste: false,
      };
    };

    const splitModifiedEnterSegments = (dataStr: string): InputSegment[] => {
      if (isPaste) return [{ type: 'text', data: dataStr }];

      const segments: InputSegment[] = [];
      let lastEnd = 0;

      for (let i = 0; i < dataStr.length; i++) {
        const parsedCursor = parseXtermModifiedCursorSequence(dataStr, i);
        if (parsedCursor) {
          const { matchLength, modParam, flag } = parsedCursor;
          if (i > lastEnd) {
            segments.push({ type: 'text', data: dataStr.slice(lastEnd, i) });
          }

          segments.push({
            type: 'key',
            event: buildXtermModifiedCursorEvent(flag, modParam),
          });

          lastEnd = i + matchLength;
          i += matchLength - 1;
          continue;
        }

        const parsed = parseXtermModifyOtherKeysSequence(dataStr, i);
        if (!parsed) {
          continue;
        }

        const { matchLength, modParam, code } = parsed;
        const event = buildXtermModifyOtherKeysEvent(code, modParam);
        if (!event) {
          continue;
        }

        if (i > lastEnd) {
          segments.push({ type: 'text', data: dataStr.slice(lastEnd, i) });
        }

        segments.push({ type: 'key', event });

        lastEnd = i + matchLength;
        i += matchLength - 1;
      }

      if (lastEnd < dataStr.length) {
        segments.push({ type: 'text', data: dataStr.slice(lastEnd) });
      }

      return segments;
    };

    // Legacy Alt+arrow / Alt+page sequences. Terminals without Kitty
    // keyboard protocol *and* without xterm modifyOtherKeys=2 — including
    // tuistory's virtual PTY, bare xterm, and Konsole's default profile —
    // emit Alt+<arrow> as a double-escape prefix: the raw ESC byte followed
    // by the plain arrow / page CSI sequence. Readline forwards the whole
    // byte string but never flips the meta flag, so downstream subscribers
    // see a plain arrow event and lose the Alt modifier entirely. We catch
    // those byte patterns here and emit a normalized key event with
    // `meta: true` + the corresponding ink flag set, matching the shape
    // produced by the Kitty CSI-u and xterm modifyOtherKeys paths. The
    // literal suffix bytes come from the same xterm conventions used in
    // `KEY_CODES` throughout tuistory / node-pty, so the list is closed.
    const LEGACY_ALT_ARROW_SUFFIXES: Record<
      string,
      | 'upArrow'
      | 'downArrow'
      | 'rightArrow'
      | 'leftArrow'
      | 'pageUp'
      | 'pageDown'
    > = {
      '[A': 'upArrow',
      '[B': 'downArrow',
      '[C': 'rightArrow',
      '[D': 'leftArrow',
      '[5~': 'pageUp',
      '[6~': 'pageDown',
    };
    const LEGACY_ALT_ARROW_MAX_SUFFIX_LENGTH = 3;

    const parseLegacyAltArrowSequence = (
      data: string,
      start: number
    ): { matchLength: number; flag: string } | null => {
      if (data[start] !== ESC || data[start + 1] !== ESC) {
        return null;
      }

      const suffixStart = start + 2;
      for (
        let length = 2;
        length <= LEGACY_ALT_ARROW_MAX_SUFFIX_LENGTH;
        length++
      ) {
        const suffix = data.slice(suffixStart, suffixStart + length);
        const flag = LEGACY_ALT_ARROW_SUFFIXES[suffix];
        if (flag) {
          return { matchLength: 2 + length, flag };
        }
      }

      return null;
    };

    const splitLegacyAltArrowSegments = (dataStr: string): InputSegment[] => {
      if (isPaste) return [{ type: 'text', data: dataStr }];

      const segments: InputSegment[] = [];
      let lastEnd = 0;

      for (let i = 0; i < dataStr.length; i++) {
        const parsed = parseLegacyAltArrowSequence(dataStr, i);
        if (!parsed) {
          continue;
        }

        const { matchLength, flag } = parsed;

        if (i > lastEnd) {
          segments.push({ type: 'text', data: dataStr.slice(lastEnd, i) });
        }

        segments.push({
          type: 'key',
          event: {
            key: {
              [flag]: true,
              meta: true,
              alt: true,
              ctrl: false,
              shift: false,
            },
            input: '',
            isPaste: false,
          },
        });

        lastEnd = i + matchLength;
        i += matchLength - 1;
      }

      if (lastEnd < dataStr.length) {
        segments.push({ type: 'text', data: dataStr.slice(lastEnd) });
      }

      return segments;
    };

    // Split a data string into interleaved text and CSI-u key segments.
    // Text segments should be passed to readline; key segments should be
    // broadcast directly. Processing them in order ensures that key
    // events like Shift+Enter are applied at the correct cursor position
    // relative to surrounding text.
    const splitCsiUSegments = (dataStr: string): InputSegment[] => {
      if (isPaste) return [{ type: 'text', data: dataStr }];

      const segments: InputSegment[] = [];
      let lastEnd = 0;

      for (let i = 0; i < dataStr.length; i++) {
        const parsed = parseCsiUSequence(dataStr, i);
        if (!parsed) {
          continue;
        }

        const { matchLength, code, modParam, eventType } = parsed;

        // Push any text before this CSI-u sequence
        if (i > lastEnd) {
          segments.push({ type: 'text', data: dataStr.slice(lastEnd, i) });
        }

        lastEnd = i + matchLength;
        i += matchLength - 1;

        // Skip release events (type 3)
        if (eventType === 3) {
          continue;
        }

        // Kitty protocol modifier bits: 0=shift, 1=alt, 2=ctrl, 3=super,
        // 4=hyper, 5=meta. Keep explicit Alt while preserving the collapsed
        // meta flag for shortcuts that intentionally accept the broader family.
        const { shift, alt, meta, ctrl } = decodeModifierFlags(
          modParam,
          0b101010
        );

        const keyName = decodeCsiUKeyName(code);
        if (keyName) {
          segments.push({
            type: 'key',
            event: {
              key: { ctrl, alt, meta, shift, [keyName]: true },
              input: '',
              isPaste: false,
            },
          });
        } else if (code >= 32 && code < 57344) {
          const char = String.fromCodePoint(code);
          segments.push({
            type: 'key',
            event: {
              key: { ctrl, alt, meta, shift },
              input: char,
              isPaste: false,
            },
          });
        } else {
          const kpChar = decodeCsiUKeypadChar(code);
          if (kpChar) {
            segments.push({
              type: 'key',
              event: {
                key: { ctrl, alt, meta, shift },
                input: kpChar,
                isPaste: false,
              },
            });
          }
        }
      }

      // Push any trailing text after the last CSI-u sequence
      if (lastEnd < dataStr.length) {
        segments.push({ type: 'text', data: dataStr.slice(lastEnd) });
      }

      return segments;
    };

    const createEscapeKeyEvent = (): KeyEvent => ({
      key: { escape: true, ctrl: false, meta: false, shift: false },
      input: ESC,
      isPaste: false,
    });

    const isEscapeRun = (value: string): boolean =>
      value.length > 0 && [...value].every((char) => char === ESC);

    const getLeadingEscapeRunLength = (value: string): number => {
      let length = 0;
      while (length < value.length && value[length] === ESC) {
        length++;
      }
      return length;
    };

    const getPendingEscapeSequenceFragment = (): string =>
      isBufferingEscapeParserState(escapeParserState)
        ? escapeParserState.fragment
        : '';

    const getPendingEscapeSequenceStartedAt = (): number =>
      isBufferingEscapeParserState(escapeParserState)
        ? escapeParserState.startedAt
        : 0;

    const clearEscapeParserState = (): void => {
      escapeParserState = { kind: 'idle' };
    };

    const bufferEscapeSequenceFragment = (
      fragment: string,
      options: { startedAt?: number; continuationDeadline?: number } = {}
    ): void => {
      const startedAt = options.startedAt ?? Date.now();

      if (isEscapeRun(fragment)) {
        escapeParserState = {
          kind: 'buffering-escape-run',
          fragment,
          startedAt,
          continuationDeadline: options.continuationDeadline,
        };
        return;
      }

      escapeParserState = {
        kind: 'buffering-csi-sequence',
        fragment,
        startedAt,
      };
    };

    const broadcastEscapeRun = (value: string): void => {
      escapeParserState = {
        kind: 'recently-emitted-escape-run',
        emittedAt: Date.now(),
      };
      for (let i = 0; i < value.length; i++) {
        broadcast(createEscapeKeyEvent());
      }
    };

    const createPasteKeyEvent = (name: 'paste-start' | 'paste-end') => ({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      sequence: '',
    });

    // Longest tail of `data` that is a strict prefix of a bracketed-paste
    // marker (ESC[200~ / ESC[201~). Used while in paste mode to hold back a
    // potentially split marker without delaying any other paste content.
    const getTrailingPasteMarkerPrefixLength = (data: string): number => {
      const maxLength = Math.min(PASTE_MODE_SUFFIX.length - 1, data.length);
      for (let length = maxLength; length > 0; length--) {
        const tail = data.slice(data.length - length);
        if (
          PASTE_MODE_SUFFIX.startsWith(tail) ||
          PASTE_MODE_PREFIX.startsWith(tail)
        ) {
          return length;
        }
      }
      return 0;
    };

    // Helper: write a text buffer through paste-detection and into readline.
    const writeTextToReadline = (textBuf: Buffer) => {
      let pos = 0;
      while (pos < textBuf.length) {
        const prefixPos = textBuf.indexOf(pasteModePrefixBuffer, pos);
        const suffixPos = textBuf.indexOf(pasteModeSuffixBuffer, pos);

        const isPrefixNext =
          prefixPos !== -1 && (suffixPos === -1 || prefixPos < suffixPos);
        const isSuffixNext =
          suffixPos !== -1 && (prefixPos === -1 || suffixPos < prefixPos);

        let nextMarkerPos = -1;
        let markerLength = 0;

        if (isPrefixNext) {
          nextMarkerPos = prefixPos;
          markerLength = pasteModePrefixBuffer.length;
        } else if (isSuffixNext) {
          nextMarkerPos = suffixPos;
          markerLength = pasteModeSuffixBuffer.length;
        }

        if (nextMarkerPos === -1) {
          if (isPaste) {
            pasteBuffer = Buffer.concat([pasteBuffer, textBuf.subarray(pos)]);
          } else {
            keypressStream.write(textBuf.subarray(pos));
          }
          return;
        }

        const nextData = textBuf.subarray(pos, nextMarkerPos);
        if (nextData.length > 0) {
          if (isPaste) {
            pasteBuffer = Buffer.concat([pasteBuffer, nextData]);
          } else {
            keypressStream.write(nextData);
          }
        }

        if (isPrefixNext) {
          handleKeypress(undefined, createPasteKeyEvent('paste-start'));
        } else if (isSuffixNext) {
          handleKeypress(undefined, createPasteKeyEvent('paste-end'));
        }

        pos = nextMarkerPos + markerLength;
      }
    };

    const processDecodedInput = (dataStr: string) => {
      if (dataStr.length === 0) {
        return;
      }

      if (!dataStr.includes(ESC)) {
        writeTextToReadline(Buffer.from(dataStr, 'utf8'));
        return;
      }

      // Process segments in order: legacy-alt-arrow → modified-enter →
      // CSI-u → readline. The legacy-alt-arrow splitter runs first because
      // its byte pattern (ESC ESC + arrow/page tail) is strictly more
      // specific than anything downstream and would otherwise be split by
      // readline into a standalone Esc + plain arrow.
      const topLevelSegments = splitLegacyAltArrowSegments(dataStr);

      for (const topSeg of topLevelSegments) {
        if (topSeg.type === 'key') {
          broadcast(topSeg.event);
          continue;
        }

        const segments = splitModifiedEnterSegments(topSeg.data);

        for (const seg of segments) {
          if (seg.type === 'text') {
            for (const textOrKeySeg of splitCsiUSegments(seg.data)) {
              if (textOrKeySeg.type === 'text') {
                const textBuf = Buffer.from(textOrKeySeg.data, 'utf8');
                if (textBuf.length > 0) {
                  writeTextToReadline(textBuf);
                }
              } else {
                broadcast(textOrKeySeg.event);
              }
            }
          } else {
            broadcast(seg.event);
          }
        }
      }
    };

    const clearPendingEscapeSequenceTimeout = () => {
      if (pendingEscapeSequenceTimeout) {
        clearTimeout(pendingEscapeSequenceTimeout);
        pendingEscapeSequenceTimeout = null;
      }
    };

    const flushPendingEscapeSequenceFragment = () => {
      const fragment = getPendingEscapeSequenceFragment();
      if (fragment.length === 0) {
        return;
      }

      // Never flush a fragment that may be the start of a bracketed-paste
      // marker while a paste is still open: writing it into the paste buffer
      // would corrupt the end marker and leave the provider stuck in paste
      // mode. Keep it buffered so it is reattached to the next stdin chunk.
      if (
        isPaste &&
        getTrailingPasteMarkerPrefixLength(fragment) === fragment.length
      ) {
        clearPendingEscapeSequenceTimeout();
        return;
      }

      clearEscapeParserState();
      clearPendingEscapeSequenceTimeout();

      if (isPaste) {
        processDecodedInput(fragment);
        return;
      }

      if (isEscapeRun(fragment)) {
        broadcastEscapeRun(fragment);
        return;
      }

      if (fragment.startsWith(ESC)) {
        const leadingEscapeRunLength = getLeadingEscapeRunLength(fragment);
        broadcastEscapeRun(fragment.slice(0, leadingEscapeRunLength));
        processDecodedInput(fragment.slice(leadingEscapeRunLength));
        return;
      }

      processDecodedInput(fragment);
    };

    const getPendingEscapeSequenceTimeoutMs = () => {
      if (!isBufferingEscapeParserState(escapeParserState)) {
        return null;
      }

      const { fragment, startedAt } = escapeParserState;
      const elapsedMs = startedAt > 0 ? Date.now() - startedAt : 0;
      const remainingMs = (timeoutMs: number) =>
        Math.max(0, timeoutMs - elapsedMs);

      if (
        escapeParserState.kind === 'buffering-escape-run' &&
        escapeParserState.continuationDeadline !== undefined
      ) {
        const remainingTransportGraceMs =
          escapeParserState.continuationDeadline - Date.now();
        return Math.max(
          0,
          Math.min(
            TMUX_SPLIT_ESCAPE_RUN_FLUSH_MS,
            remainingTransportGraceMs - 1
          )
        );
      }

      if (fragment === ESC) {
        return remainingMs(STANDALONE_ESCAPE_FRAGMENT_TIMEOUT_MS);
      }

      if (isEscapeRun(fragment)) {
        return remainingMs(ESCAPE_RUN_FRAGMENT_TIMEOUT_MS);
      }

      if (fragment.includes(`${ESC}[`)) {
        return remainingMs(CSI_ESCAPE_SEQUENCE_FRAGMENT_TIMEOUT_MS);
      }

      return null;
    };

    const schedulePendingEscapeSequenceFlush = () => {
      if (getPendingEscapeSequenceFragment().length === 0) {
        return;
      }

      const timeoutMs = getPendingEscapeSequenceTimeoutMs();
      if (timeoutMs === null) {
        return;
      }

      clearPendingEscapeSequenceTimeout();
      if (timeoutMs <= 0) {
        flushPendingEscapeSequenceFragment();
        return;
      }

      pendingEscapeSequenceTimeout = setTimeout(() => {
        pendingEscapeSequenceTimeout = null;
        flushPendingEscapeSequenceFragment();
      }, timeoutMs);
      pendingEscapeSequenceTimeout.unref?.();
    };

    const writeTerminalSequence = async (sequence: string): Promise<void> => {
      if (!process.stdout.isTTY) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, TERMINAL_SHUTDOWN_QUIET_MS);
        timeout.unref?.();

        process.stdout.write(sequence, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    };

    const disableTmuxExtendedKeyMode = (): Promise<void> =>
      process.env.TMUX
        ? writeTerminalSequence(ANSI.DISABLE_XTERM_MODIFY_OTHER_KEYS)
        : Promise.resolve();

    const clearBackslashTimeout = () => {
      if (backslashTimeout) {
        clearTimeout(backslashTimeout);
        backslashTimeout = null;
      }
    };

    const flushPendingPasteBuffer = () => {
      if (isPaste && pasteBuffer.length > 0 && !isShuttingDown) {
        broadcast({
          key: { name: 'paste', ctrl: false, meta: false, shift: false },
          input: pasteBuffer.toString('utf8'),
          isPaste: true,
        });
      }
      isPaste = false;
      pasteBuffer = Buffer.alloc(0);
    };

    const resetBufferedInputState = ({
      flushPendingPaste = false,
    }: {
      flushPendingPaste?: boolean;
    } = {}) => {
      keypressQueue.length = 0;
      hasPendingRender = false;
      clearBackslashTimeout();
      clearPendingEscapeSequenceTimeout();
      clearEscapeParserState();
      waitingForEnterAfterBackslash = false;
      if (flushPendingPaste) {
        flushPendingPasteBuffer();
      } else {
        isPaste = false;
        pasteBuffer = Buffer.alloc(0);
      }
    };

    const finalizeInputCleanup = ({
      flushPendingPaste = false,
    }: {
      flushPendingPaste?: boolean;
    } = {}) => {
      clearTerminalShutdownTimers();
      (keypressStream as NodeJS.EventEmitter).removeListener(
        'keypress',
        handleKeypress
      );
      if (rawDataHandler) {
        stdin.removeListener('data', rawDataHandler);
      }
      stdin.pause();
      rl?.close();
      setRawMode(false);
      resetBufferedInputState({ flushPendingPaste });
      rejectPendingTerminalClipboardRequests(
        'KeypressProvider unmounted before clipboard response arrived'
      );
      resetTerminalClipboardExtractorState();
      if (activeKeypressProviderInstanceId === instanceIdRef.current) {
        setTerminalFocusState(true);
        lastActualScrollInputAt = 0;
      }
    };

    const waitForTerminalQuietPeriod = () =>
      new Promise<void>((resolve) => {
        const maybeResolve = () => {
          const elapsed = Date.now() - lastShutdownInputAt;
          if (elapsed >= TERMINAL_SHUTDOWN_QUIET_MS) {
            clearTerminalShutdownTimers();
            resolve();
            return;
          }

          terminalShutdownQuietTimer = setTimeout(
            maybeResolve,
            TERMINAL_SHUTDOWN_QUIET_MS - elapsed
          );
          terminalShutdownQuietTimer.unref?.();
        };

        terminalShutdownQuietTimer = setTimeout(
          maybeResolve,
          TERMINAL_SHUTDOWN_QUIET_MS
        );
        terminalShutdownQuietTimer.unref?.();

        terminalShutdownTimeout = setTimeout(() => {
          clearTerminalShutdownTimers();
          resolve();
        }, TERMINAL_SHUTDOWN_TIMEOUT_MS);
        terminalShutdownTimeout.unref?.();
      });

    const startTerminalShutdownQuarantine = async () => {
      isShuttingDown = true;
      lastShutdownInputAt = Date.now();
      if (activeKeypressProviderInstanceId === instanceIdRef.current) {
        setTerminalFocusState(true);
        lastActualScrollInputAt = 0;
      }
      resetBufferedInputState();

      await Promise.allSettled([
        disableKittyProtocol({ force: true }),
        disableTmuxExtendedKeyMode(),
        writeTerminalSequence(ANSI.DISABLE_FOCUS_REPORTING),
        writeTerminalSequence(ANSI.DISABLE_BRACKETED_PASTE),
      ]);

      await waitForTerminalQuietPeriod();
      finalizeInputCleanup();
    };

    // Keep incomplete escape-sequence fragments across raw-data chunks so split
    // sequences like "\x1b" + "[13;2u", "\x1b[13;" + "2u", or
    // "\x1b[27;2;" + "13~" are decoded correctly before readline can break
    // them apart.
    const extractTrailingIncompleteEscapeSequence = (
      dataStr: string
    ): { completePart: string; incompletePart: string } => {
      let trailingEscapeRunStart = dataStr.length;
      while (
        trailingEscapeRunStart > 0 &&
        dataStr[trailingEscapeRunStart - 1] === ESC
      ) {
        trailingEscapeRunStart--;
      }
      if (trailingEscapeRunStart < dataStr.length) {
        return {
          completePart: dataStr.slice(0, trailingEscapeRunStart),
          incompletePart: dataStr.slice(trailingEscapeRunStart),
        };
      }

      const seqStart = dataStr.lastIndexOf(`${ESC}[`);
      if (seqStart === -1) {
        return { completePart: dataStr, incompletePart: '' };
      }

      const tail = dataStr.slice(seqStart);
      // Incomplete CSI-like shape: ESC [ digits/;/: ... (without its final
      // terminator yet). This covers both Kitty CSI-u and modifyOtherKeys
      // variants such as ESC[27;2;13~.
      const isIncompleteCsiLikeSequence =
        tail.startsWith(`${ESC}[`) &&
        tail.length >= 2 &&
        [...tail.slice(2)].every(
          (char) => (char >= '0' && char <= '9') || char === ';' || char === ':'
        );
      if (isIncompleteCsiLikeSequence) {
        let incompleteStart = seqStart;
        while (incompleteStart > 0 && dataStr[incompleteStart - 1] === ESC) {
          incompleteStart--;
        }
        return {
          completePart: dataStr.slice(0, incompleteStart),
          incompletePart: dataStr.slice(incompleteStart),
        };
      }

      return { completePart: dataStr, incompletePart: '' };
    };

    // Handle raw data for bracketed paste detection and focus events
    const handleRawData = (data: Buffer | string) => {
      if (isShuttingDown) {
        lastShutdownInputAt = Date.now();
        return;
      }

      const rawDataStr = Buffer.isBuffer(data) ? data.toString('utf8') : data;

      // Intercept OSC 5522 terminal clipboard packets before any other parsing.
      // Complete packets are dispatched to the clipboard protocol; incomplete
      // ones are buffered inside the extractor until the next chunk arrives.
      // The cleaned string has every complete packet removed so bracketed
      // paste / readline / CSI-u decoding never sees them.
      const { cleaned: dataStr } = extractTerminalClipboardPackets(rawDataStr);

      if (dataStr.length === 0) {
        return;
      }

      if (isPaste) {
        clearPendingEscapeSequenceTimeout();
        const pasteData = getPendingEscapeSequenceFragment() + dataStr;
        clearEscapeParserState();
        // Bracketed-paste markers can be split across stdin reads (e.g. VS Code
        // writes large pastes in a single pty write and the kernel pty buffer
        // chunks the reads). Hold back a trailing fragment that could be the
        // start of an ESC[200~/ESC[201~ marker so it can be reassembled with
        // the next chunk. While paste mode stays open the fragment is not
        // flushed on a timer — flushing it into the paste buffer would corrupt
        // the end marker and leave the provider stuck in paste mode.
        const markerPrefixLength =
          getTrailingPasteMarkerPrefixLength(pasteData);
        const completePart = pasteData.slice(
          0,
          pasteData.length - markerPrefixLength
        );
        const incompletePart = pasteData.slice(
          pasteData.length - markerPrefixLength
        );
        if (completePart.length > 0) {
          writeTextToReadline(Buffer.from(completePart, 'utf8'));
        }
        if (incompletePart) {
          bufferEscapeSequenceFragment(incompletePart);
          if (!isPaste) {
            // The complete part closed the paste; the leftover fragment now
            // belongs to regular (non-paste) input handling.
            schedulePendingEscapeSequenceFlush();
          }
        }
        return;
      }

      const pendingFragment = getPendingEscapeSequenceFragment();
      const pendingFragmentIsEscapeRun = isEscapeRun(pendingFragment);
      if (!isPaste && pendingFragmentIsEscapeRun && isEscapeRun(dataStr)) {
        bufferEscapeSequenceFragment(pendingFragment + dataStr, {
          startedAt: getPendingEscapeSequenceStartedAt() || Date.now(),
        });
        if (!getTerminalFocusState()) {
          updateTerminalFocusState(true);
        }
        schedulePendingEscapeSequenceFlush();
        return;
      }

      if (
        escapeParserState.kind === 'recently-emitted-escape-run' &&
        Date.now() - escapeParserState.emittedAt <
          TMUX_SPLIT_ESCAPE_RUN_GRACE_MS &&
        isEscapeRun(dataStr) &&
        pendingFragment.length === 0
      ) {
        bufferEscapeSequenceFragment(dataStr, {
          continuationDeadline:
            escapeParserState.emittedAt + TMUX_SPLIT_ESCAPE_RUN_GRACE_MS,
        });
        if (!getTerminalFocusState()) {
          updateTerminalFocusState(true);
        }
        schedulePendingEscapeSequenceFlush();
        return;
      }

      if (
        pendingFragmentIsEscapeRun &&
        !dataStr.startsWith('[') &&
        !dataStr.startsWith('\r')
      ) {
        flushPendingEscapeSequenceFragment();
      } else {
        clearPendingEscapeSequenceTimeout();
      }

      let combinedDataStr = getPendingEscapeSequenceFragment() + dataStr;
      if (getPendingEscapeSequenceFragment().length > 0) {
        clearEscapeParserState();
      }

      // Check for focus/blur events (CSI I for focus, CSI O for blur).
      //
      // Process focus markers in byte order and treat each as a conditional
      // transition, not a unconditional state write. This serves two needs:
      //   1. Swallow duplicate focus-in events — some terminals (e.g. Ghostty)
      //      echo CSI I in response to CSI ? 1004 h, creating a feedback loop
      //      where restoreInteractiveTerminalState re-issues that escape and
      //      the terminal echoes CSI I again, ad infinitum.
      //   2. Preserve ordering when the terminal coalesces a blur+refocus
      //      into one stdin chunk (e.g. '\x1b[O\x1b[I'); handling the two
      //      markers with independent `includes` checks would process focus
      //      before blur regardless of byte order, leaving the TUI marked as
      //      unfocused after a real refocus.
      // Only re-assert terminal state on a real unfocused->focused transition.
      if (
        combinedDataStr.includes('\x1b[I') ||
        combinedDataStr.includes('\x1b[O')
      ) {
        // eslint-disable-next-line no-control-regex
        const focusEventRegex = /\x1b\[(I|O)/g;
        let focused = getTerminalFocusState();

        for (const match of combinedDataStr.matchAll(focusEventRegex)) {
          const nextFocused = match[1] === 'I';
          if (nextFocused === focused) {
            continue;
          }

          focused = nextFocused;
          updateTerminalFocusState(nextFocused);
          if (nextFocused) {
            restoreInteractiveTerminalState({ setRawMode });
          }
        }

        combinedDataStr = combinedDataStr
          .replaceAll('\x1b[I', '')
          .replaceAll('\x1b[O', '');
      }

      // Activity-based focus recovery: if the terminal is marked as
      // unfocused but we receive real (non-focus-sequence) input, the
      // focus-in event was likely missed. Restore focus so the soft
      // cursor reappears without requiring a manual click cycle.
      if (!getTerminalFocusState() && combinedDataStr.length > 0 && !isPaste) {
        updateTerminalFocusState(true);
      }

      if (combinedDataStr.length === 0) {
        return;
      }

      // Decode Kitty CSI-u sequences, splitting the buffer into interleaved
      // text and key-event segments. Text is forwarded to readline; key
      // events are broadcast directly. Processing in order ensures
      // keystrokes like Shift+Enter land at the correct cursor position.
      const { completePart, incompletePart } =
        extractTrailingIncompleteEscapeSequence(combinedDataStr);
      if (incompletePart) {
        bufferEscapeSequenceFragment(incompletePart);
        schedulePendingEscapeSequenceFlush();
      }

      processDecodedInput(completePart);
    };
    rawDataHandler = handleRawData;

    // Set up readline interface with PassThrough stream
    const readlineInterface = readline.createInterface({
      input: keypressStream as NodeJS.ReadableStream,
      escapeCodeTimeout: 0,
    });
    rl = readlineInterface;
    readline.emitKeypressEvents(
      keypressStream as NodeJS.ReadableStream,
      readlineInterface
    );
    (keypressStream as NodeJS.EventEmitter).on('keypress', handleKeypress);
    stdin.on('data', handleRawData);
    currentEnabledRef.current = true;
    resolveTransitionWaiters(true);

    return () => {
      if (isUnmountingRef.current) {
        setKeypressProviderShutdownPromise(startTerminalShutdownQuarantine());
        return;
      }

      void Promise.allSettled([
        disableKittyProtocol(),
        disableTmuxExtendedKeyMode(),
        writeTerminalSequence(ANSI.DISABLE_FOCUS_REPORTING),
        writeTerminalSequence(ANSI.DISABLE_BRACKETED_PASTE),
      ]);
      finalizeInputCleanup({ flushPendingPaste: true });
    };
  }, [stdin, setRawMode, subscribers, updateTerminalFocusState, isEnabled]);

  const contextValue = useMemo(
    () => ({
      subscribe,
      unsubscribe,
      handlerRef,
      isTerminalFocused,
      setEnabled: setIsEnabled,
      setEnabledAndWait,
      isEnabled,
      setExitSpecModeComment: (comment: string | undefined) => {
        exitSpecModeCommentRef.current = comment;
      },
      getExitSpecModeComment: () => exitSpecModeCommentRef.current,
      setMissionProposalComment: (comment: string | undefined) => {
        missionProposalCommentRef.current = comment;
      },
      getMissionProposalComment: () => missionProposalCommentRef.current,
    }),
    [subscribe, unsubscribe, isTerminalFocused, setEnabledAndWait, isEnabled]
  );

  return (
    <KeypressContext.Provider value={contextValue}>
      {children}
    </KeypressContext.Provider>
  );
}
