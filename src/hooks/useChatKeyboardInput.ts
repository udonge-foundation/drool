/**
 * Custom hook for handling complex keyboard input in chat components
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { QueuePlacement } from '@industry/drool-sdk-ext/protocol/drool';
import { logWarn } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { ANSI, CHAR_CODES, DEFAULTS } from '@/components/chat/constants';
import { wrapText } from '@/components/chat/wrapText';
import { KeypressLayer } from '@/contexts/enums';
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import type { KeyEvent } from '@/contexts/types';
import {
  getNonTmuxRepeatedKeySequenceResetMs,
  getRepeatedKeySequenceTimeoutMs,
} from '@/hooks/repeatedKeySequence';
import {
  ChatInputLayout,
  ChatKeyboardInputParams,
  ChatKeyboardInputResult,
  RepeatedKeyId,
  RepeatedKeyResolution,
} from '@/hooks/types';
import { useMountEffect } from '@/hooks/useMountEffect';
import { getI18n } from '@/i18n';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { getEditorService } from '@/services/EditorService';
import type { OpenTextInEditorResult } from '@/services/types';
import { looksLikeImageFilePath, readFromClipboard } from '@/utils/clipboard';
import { selectSlashCommandForCompletion } from '@/utils/commandMatching';
import { displayWidth as getDisplayWidth } from '@/utils/displayWidth';
import { detectEditor } from '@/utils/editorDetection';
import {
  classifyKeyEvent,
  flushInputLatencyMetrics,
  recordInputLatency,
} from '@/utils/inputLatencyMetrics';
import {
  deleteWordAfterCursor as deleteWordAfterCursorUtil,
  deleteWordBeforeCursor as deleteWordBeforeCursorUtil,
  findNextWordBoundary,
  findPreviousWordBoundary,
} from '@/utils/textEditing';

interface KeyObject {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  tab?: boolean;
  return?: boolean;
  shift?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  sequence?: string;
  name?: string;
}

type PendingEditorState = Extract<
  OpenTextInEditorResult,
  { success: true; isAsyncEditor: true }
>;

// Platform detection
const isWindows = process.platform === 'win32';

const MACOS_TERMINAL_OPTION_TEXT_ALIASES = {
  '∫': 'b',
  '∂': 'd',
  ƒ: 'f',
  å: 'a',
  Å: 'a',
  '´': 'e',
} as const;

type MacosTerminalOptionTextAlias =
  (typeof MACOS_TERMINAL_OPTION_TEXT_ALIASES)[keyof typeof MACOS_TERMINAL_OPTION_TEXT_ALIASES];

function getMacosTerminalOptionTextAlias({
  input,
  key,
  isPaste,
}: {
  input?: string;
  key?: KeyObject;
  isPaste?: boolean;
}): MacosTerminalOptionTextAlias | null {
  if (isPaste || !input || key?.ctrl || key?.meta || key?.name) {
    return null;
  }

  return (
    MACOS_TERMINAL_OPTION_TEXT_ALIASES[
      input as keyof typeof MACOS_TERMINAL_OPTION_TEXT_ALIASES
    ] ?? null
  );
}

function getExactCommandTextFromInput(
  inputText: string,
  commands: ChatKeyboardInputParams['filteredCommands']
): string | null {
  const match = inputText.match(/^\/([^\s]+)([\s\S]*)$/);
  if (!match) {
    return null;
  }

  const exactCommand = commands?.find(
    (command) => command.name.toLowerCase() === match[1].toLowerCase()
  );
  if (!exactCommand) {
    return null;
  }

  return `/${exactCommand.name}${match[2]}`;
}

function calculateChatInputMaxLineWidth(width?: number): number {
  return width ? Math.max(width - 10, 1) : 80;
}

export function prunePastedBlocksMissingFromInput(
  pastedBlocks: Map<string, string>,
  input: string
): Map<string, string> {
  let nextPastedBlocks: Map<string, string> | undefined;

  for (const placeholder of pastedBlocks.keys()) {
    if (!input.includes(placeholder)) {
      nextPastedBlocks ??= new Map(pastedBlocks);
      nextPastedBlocks.delete(placeholder);
    }
  }

  return nextPastedBlocks ?? pastedBlocks;
}

function sanitizePastedTextForDisplay(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return !(
        (code >= 0 && code <= 8) ||
        (code >= 14 && code <= 31) ||
        code === 127
      );
    })
    .join('')
    .replace(/\[[\d;]*[a-zA-Z]/g, '');
}

/**
 * Custom hook for handling keyboard input in the chat interface
 */
export function useChatKeyboardInput({
  showSuggestions,
  showCommands,
  suggestions,
  selectedSuggestionIndex,
  waitingForEscapeChar,
  setSelectedSuggestionIndex,
  setShowSuggestions,
  setShowCommands,
  setWaitingForEscapeChar,
  selectSuggestion,
  updateSuggestions,
  onSubmit,
  onEscape,
  onRewindShortcut,
  isFocused = true,
  showHelpHints,
  setShowHelpHints,
  filteredCommands = [],
  availableCommands = filteredCommands,
  isBashMode = false,
  enableQueuedMessages = false,
  onBashSubmit,
  onModeToggle,
  onAutonomyLevelCycle,
  onModelCycle,
  onReasoningCycle,
  historyService,
  onToggleBashMode,
  handleImagePaste,
  handleImageFilePathPaste,
  attachedImages,
  clearImages,
  initialValue = '',
  initialCursorPosition,
  onInputChange,
  onCursorPositionChange,
  onEditorInputApplied,
  width,
  onDownArrowAtBottom,
  onQueuedMessagesReviewShortcut,
  onPullQueuedMessageShortcut,
  onWarning,
}: ChatKeyboardInputParams): ChatKeyboardInputResult {
  // Internal state management for input and cursor position
  const [input, setInputState] = useState(initialValue);
  const setInput = useCallback((value: string | ((prev: string) => string)) => {
    setInputState((prev) =>
      typeof value === 'function'
        ? (value as (prevValue: string) => string)(prev)
        : value
    );
  }, []);
  const [cursorPosition, setCursorPositionState] = useState(() =>
    Math.max(0, Math.min(initialCursorPosition ?? 0, initialValue.length))
  );
  const cursorPositionRef = useRef(cursorPosition);
  const onCursorPositionChangeRef = useRef(onCursorPositionChange);
  onCursorPositionChangeRef.current = onCursorPositionChange;
  const setCursorPosition = useCallback(
    (value: number | ((prev: number) => number)) => {
      const next =
        typeof value === 'function' ? value(cursorPositionRef.current) : value;
      cursorPositionRef.current = next;
      setCursorPositionState(next);
      onCursorPositionChangeRef.current?.(next);
    },
    []
  );
  const ignoredInputChangeValueRef = useRef<string | undefined>(undefined);
  const ignoredClearedInputChangeRef = useRef(false);

  useEffect(() => {
    if (ignoredClearedInputChangeRef.current && input === '') {
      ignoredClearedInputChangeRef.current = false;
      return;
    }

    if (ignoredInputChangeValueRef.current !== undefined) {
      if (ignoredInputChangeValueRef.current === input) {
        ignoredInputChangeValueRef.current = undefined;
        return;
      }

      ignoredInputChangeValueRef.current = undefined;
      ignoredClearedInputChangeRef.current = false;
    }

    if (onInputChange) {
      onInputChange(input);
    }
  }, [input, onInputChange]);

  const ignoreSubmittedInputChangeEffects = useCallback(
    (submittedInput: string) => {
      ignoredInputChangeValueRef.current = submittedInput;
      ignoredClearedInputChangeRef.current = true;
    },
    []
  );

  // Track pasted text blocks
  const [, setPastedBlocksState] = useState<Map<string, string>>(new Map());
  const pastedBlocksRef = useRef<Map<string, string>>(new Map());
  const setPastedBlocks = useCallback(
    (
      value:
        | Map<string, string>
        | ((prev: Map<string, string>) => Map<string, string>)
    ) => {
      const nextValue =
        typeof value === 'function' ? value(pastedBlocksRef.current) : value;
      pastedBlocksRef.current = nextValue;
      setPastedBlocksState(nextValue);
    },
    []
  );
  const pastedBlockCounter = useRef(0);

  const createPastedBlockPlaceholder = useCallback(
    (preview: string, lineCount: number): string => {
      const basePlaceholder = `[${preview}... ${lineCount} lines]`;
      const pastedBlocks = pastedBlocksRef.current;
      if (!pastedBlocks.has(basePlaceholder)) {
        return basePlaceholder;
      }

      let placeholder: string;
      do {
        pastedBlockCounter.current += 1;
        placeholder = `[${preview}... ${lineCount} lines, paste ${pastedBlockCounter.current}]`;
      } while (pastedBlocks.has(placeholder));

      return placeholder;
    },
    []
  );

  const prunePastedBlocksForInput = useCallback(
    (nextInput: string): void => {
      setPastedBlocks((prev) =>
        prunePastedBlocksMissingFromInput(prev, nextInput)
      );
    },
    [setPastedBlocks]
  );

  // Track ongoing paste operation to prevent accidental message sending
  const [isPasting, setIsPasting] = useState(false);
  const isPastingRef = useRef(false);
  const pasteResetTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  // Reference for timeout to detect standalone ESC key presses
  const escapeTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const repeatedKeySequenceRef = useRef<RepeatedKeyResolution | undefined>(
    undefined
  );
  const repeatedKeySequenceTimerRef = useRef<NodeJS.Timeout | undefined>(
    undefined
  );
  const clearedDraftBeforeDoubleEscapeRef = useRef<
    { input: string; cursorPosition: number } | undefined
  >(undefined);

  // Log hook initialization only once
  const isInitializedRef = useRef(false);
  if (!isInitializedRef.current) {
    isInitializedRef.current = true;
  }

  // Check if KeypressProvider is available
  let keypressProvider: ReturnType<typeof useKeypressProvider> | null = null;
  try {
    keypressProvider = useKeypressProvider();
  } catch {
    // KeypressProvider not available
  }

  // Refs to track the latest input and cursor position
  const inputRef = useRef(input);
  const waitingForEscapeCharRef = useRef(waitingForEscapeChar);
  // Dedupe moved to KeypressProvider
  const keyHandlerRef = useRef<(raw: string, key: unknown) => boolean | void>(
    () => false
  );
  const insertTextAtCursorRef = useRef<
    ((text: string, isPasted?: boolean) => void) | undefined
  >(undefined);
  const pendingCommitMetricRef = useRef<
    { startedAtMs: number; inputKind: string } | undefined
  >(undefined);
  const pendingCommitClearTimerRef = useRef<NodeJS.Timeout | undefined>(
    undefined
  );
  const pendingEditorRef = useRef<PendingEditorState | null>(null);
  const [pendingEditorState, setPendingEditorState] =
    useState<PendingEditorState | null>(null);
  const [isOpeningEditor, setIsOpeningEditor] = useState(false);
  const isOpeningEditorRef = useRef(false);
  const [editorGuidance, setEditorGuidance] = useState<string | null>(null);

  const setPendingEditor = useCallback((next: PendingEditorState | null) => {
    pendingEditorRef.current = next;
    setPendingEditorState(next);
  }, []);

  const markPasteInProgress = useCallback(() => {
    isPastingRef.current = true;
    setIsPasting(true);
    if (pasteResetTimeoutRef.current) {
      clearTimeout(pasteResetTimeoutRef.current);
    }
    pasteResetTimeoutRef.current = setTimeout(() => {
      isPastingRef.current = false;
      setIsPasting(false);
      pasteResetTimeoutRef.current = undefined;
    }, 100);
  }, []);

  useMountEffect(() => () => {
    if (pasteResetTimeoutRef.current) {
      clearTimeout(pasteResetTimeoutRef.current);
    }
    if (pendingCommitClearTimerRef.current) {
      clearTimeout(pendingCommitClearTimerRef.current);
    }
    const pendingEditor = pendingEditorRef.current;
    pendingEditorRef.current = null;
    if (pendingEditor) {
      void pendingEditor.cleanup().catch((error) => {
        logWarn(
          '[useChatKeyboardInput] Failed to clean up pending editor on unmount',
          {
            error,
          }
        );
      });
    }
    flushInputLatencyMetrics();
  });

  // Update refs when state changes
  inputRef.current = input;
  waitingForEscapeCharRef.current = waitingForEscapeChar;

  useLayoutEffect(() => {
    const pending = pendingCommitMetricRef.current;
    if (!pending) return;
    pendingCommitMetricRef.current = undefined;
    if (pendingCommitClearTimerRef.current) {
      clearTimeout(pendingCommitClearTimerRef.current);
      pendingCommitClearTimerRef.current = undefined;
    }
    const committedAtMs = performance.now();
    recordInputLatency(
      Metric.CLI_TUI_INPUT_COMMIT_LATENCY,
      committedAtMs - pending.startedAtMs,
      { inputKind: pending.inputKind }
    );
    const timer = setTimeout(() => {
      recordInputLatency(
        Metric.CLI_TUI_INPUT_FRAME_LATENCY,
        performance.now() - committedAtMs,
        { inputKind: pending.inputKind }
      );
    }, 0);
    timer.unref?.();
  }, [input, cursorPosition, showCommands, showSuggestions]);

  // ===== UTILITY FUNCTIONS =====

  /**
   * Jump to previous word
   * Uses CJK-aware word boundary detection: CJK characters are navigated
   * one at a time since CJK languages don't use space-separated words.
   */
  const jumpToPreviousWord = useCallback((): void => {
    if (cursorPosition === 0) {
      return;
    }

    const newPos = findPreviousWordBoundary(input, cursorPosition);
    setCursorPosition(Math.max(0, newPos));
  }, [cursorPosition, input, setCursorPosition]);

  /**
   * Jump to next word
   * Uses CJK-aware word boundary detection: CJK characters are navigated
   * one at a time since CJK languages don't use space-separated words.
   */
  const jumpToNextWord = useCallback((): void => {
    if (cursorPosition >= input.length) {
      return;
    }

    const newPos = findNextWordBoundary(input, cursorPosition);
    setCursorPosition(Math.min(input.length, newPos));
  }, [cursorPosition, input, setCursorPosition]);

  /**
   * Jump to start of current line
   */
  const jumpToLineStart = useCallback((): void => {
    const lines = input.split('\n');
    let currentLine = 0;
    let charCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (charCount + lines[i].length >= cursorPosition) {
        currentLine = i;
        break;
      }
      charCount += lines[i].length + 1;
    }

    let newPosition = 0;
    for (let i = 0; i < currentLine; i++) {
      newPosition += lines[i].length + 1;
    }
    setCursorPosition(newPosition);
    void updateSuggestions(input, newPosition);
  }, [input, cursorPosition, setCursorPosition, updateSuggestions]);

  /**
   * Jump to end of current line
   */
  const jumpToLineEnd = useCallback((): void => {
    const lines = input.split('\n');
    let currentLine = 0;
    let charCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (charCount + lines[i].length >= cursorPosition) {
        currentLine = i;
        break;
      }
      charCount += lines[i].length + 1;
    }

    let newPosition = 0;
    for (let i = 0; i <= currentLine; i++) {
      newPosition += lines[i].length;
      if (i < currentLine) {
        newPosition += 1;
      }
    }
    setCursorPosition(newPosition);
    void updateSuggestions(input, newPosition);
  }, [input, cursorPosition, setCursorPosition, updateSuggestions]);

  const jumpToInputEnd = useCallback((): void => {
    if (cursorPosition === input.length) {
      return;
    }

    const newPosition = input.length;
    setCursorPosition(newPosition);
    void updateSuggestions(input, newPosition);
  }, [input, cursorPosition, setCursorPosition, updateSuggestions]);

  // Memoize wrapped layout once so rendering and navigation can share it.
  const displayLayout = useMemo<
    Pick<ChatInputLayout, 'displayLines' | 'lineMapping'>
  >(() => {
    const maxLineWidth = calculateChatInputMaxLineWidth(width);
    const rawLines = input ? input.split('\n') : [''];
    const displayLines: ChatInputLayout['displayLines'] = [];
    const lineMapping: ChatInputLayout['lineMapping'] = [];

    let bufferPos = 0;
    for (let rawIndex = 0; rawIndex < rawLines.length; rawIndex++) {
      const rawLine = rawLines[rawIndex] ?? '';
      const wrappedLines =
        getDisplayWidth(rawLine) > maxLineWidth
          ? wrapText(rawLine, maxLineWidth)
          : [rawLine];

      let lineOffset = 0;
      for (
        let wrappedIndex = 0;
        wrappedIndex < wrappedLines.length;
        wrappedIndex++
      ) {
        const wrappedLine = wrappedLines[wrappedIndex] ?? '';
        displayLines.push(wrappedLine);
        lineMapping.push({
          rawLineIndex: rawIndex,
          isWrapped: wrappedLines.length > 1,
          bufferStart: bufferPos + lineOffset,
        });
        lineOffset += wrappedLine.length;
      }

      bufferPos += rawLine.length + 1;
    }

    return { displayLines, lineMapping };
  }, [input, width]);

  const { cursorLine, cursorCol } = useMemo(() => {
    const { displayLines, lineMapping } = displayLayout;

    for (let index = 0; index < displayLines.length; index++) {
      const line = displayLines[index] ?? '';
      const lineMeta = lineMapping[index];

      if (!lineMeta) {
        continue;
      }

      const lineEnd = lineMeta.bufferStart + line.length;
      if (cursorPosition <= lineEnd) {
        return {
          cursorLine: index,
          cursorCol: Math.max(0, cursorPosition - lineMeta.bufferStart),
        };
      }
    }

    const lastLineIndex = Math.max(displayLayout.displayLines.length - 1, 0);
    const lastLine = displayLayout.displayLines[lastLineIndex] ?? '';
    const lastLineMeta = displayLayout.lineMapping[lastLineIndex];

    if (!lastLineMeta) {
      return {
        cursorLine: 0,
        cursorCol: cursorPosition,
      };
    }

    return {
      cursorLine: lastLineIndex,
      cursorCol: Math.max(
        0,
        Math.min(cursorPosition - lastLineMeta.bufferStart, lastLine.length)
      ),
    };
  }, [displayLayout, cursorPosition]);

  const layout = useMemo<ChatInputLayout>(
    () => ({
      ...displayLayout,
      cursorLine,
      cursorCol,
    }),
    [displayLayout, cursorLine, cursorCol]
  );

  /**
   * Navigate through multiline text with arrow keys
   * Handles both actual newlines AND visually wrapped lines
   */
  const navigateMultilineWithArrows = useCallback(
    (key: KeyObject): boolean => {
      const {
        displayLines,
        lineMapping,
        cursorLine: currentCursorLine,
        cursorCol: currentCursorCol,
      } = layout;

      if (key.upArrow && currentCursorLine > 0) {
        const targetLine = displayLines[currentCursorLine - 1] ?? '';
        const targetLineMeta = lineMapping[currentCursorLine - 1];
        if (!targetLineMeta) {
          return false;
        }
        const targetCol = Math.min(currentCursorCol, targetLine.length);
        const newPosition = targetLineMeta.bufferStart + targetCol;
        setCursorPosition(newPosition);
        void updateSuggestions(input, newPosition);
        return true;
      }

      if (key.downArrow) {
        if (currentCursorLine < displayLines.length - 1) {
          const targetLine = displayLines[currentCursorLine + 1] ?? '';
          const targetLineMeta = lineMapping[currentCursorLine + 1];
          if (!targetLineMeta) {
            return false;
          }
          const targetCol = Math.min(currentCursorCol, targetLine.length);
          const newPosition = targetLineMeta.bufferStart + targetCol;
          setCursorPosition(newPosition);
          void updateSuggestions(input, newPosition);
          return true;
        }
      }

      return false;
    },
    [layout, setCursorPosition, updateSuggestions, input]
  );

  /**
   * Delete character before cursor
   */
  const deleteCharBeforeCursor = useCallback((): void => {
    // Get current values from refs to ensure we have the latest state
    const currentInput = inputRef.current;
    const currentCursorPos = cursorPositionRef.current;

    if (currentCursorPos > 0) {
      const before = currentInput.substring(0, currentCursorPos - 1);
      const after = currentInput.substring(currentCursorPos);
      const newInput = before + after;
      const newPos = currentCursorPos - 1;

      prunePastedBlocksForInput(newInput);

      inputRef.current = newInput;
      cursorPositionRef.current = newPos;

      // Update React state
      setInput(newInput);
      setCursorPosition(newPos);

      // Update suggestions after deletion
      void updateSuggestions(newInput, newPos);
    }
  }, [
    setInput,
    setCursorPosition,
    updateSuggestions,
    prunePastedBlocksForInput,
  ]);

  /**
   * Delete character after cursor (forward delete)
   */
  const deleteCharAfterCursor = useCallback((): void => {
    // Get current values from refs to ensure we have the latest state
    const currentInput = inputRef.current;
    const currentCursorPos = cursorPositionRef.current;

    if (currentCursorPos < currentInput.length) {
      const before = currentInput.substring(0, currentCursorPos);
      const after = currentInput.substring(currentCursorPos + 1);
      const newInput = before + after;
      // Cursor position stays the same for forward delete

      prunePastedBlocksForInput(newInput);

      inputRef.current = newInput;
      // Keep cursor at same position for forward delete
      cursorPositionRef.current = currentCursorPos;

      // Update React state
      setInput(newInput);
      setCursorPosition(currentCursorPos);

      // Update suggestions after deletion
      void updateSuggestions(newInput, currentCursorPos);
    }
  }, [
    setInput,
    setCursorPosition,
    updateSuggestions,
    prunePastedBlocksForInput,
  ]);

  /**
   * Delete word before cursor
   * Uses CJK-aware word deletion: CJK characters are deleted one at a time
   * since CJK languages don't use space-separated words.
   */
  const deleteWordBeforeCursor = useCallback((): void => {
    const currentInput = inputRef.current;
    const currentCursorPos = cursorPositionRef.current;

    if (currentCursorPos === 0) {
      return;
    }

    const result = deleteWordBeforeCursorUtil(currentInput, currentCursorPos);
    const newInput = result.value;
    const deleteStart = result.cursorOffset;

    // Update refs immediately
    inputRef.current = newInput;
    cursorPositionRef.current = deleteStart;
    prunePastedBlocksForInput(newInput);

    setInput(newInput);
    setCursorPosition(deleteStart);
    // Update suggestions after deletion
    void updateSuggestions(newInput, deleteStart);
  }, [
    setInput,
    setCursorPosition,
    updateSuggestions,
    prunePastedBlocksForInput,
  ]);

  /**
   * Delete word after cursor (Option+D / ESC d)
   * Uses CJK-aware word deletion: CJK characters are deleted one at a time
   * since CJK languages don't use space-separated words.
   */
  const deleteWordAfterCursor = useCallback((): void => {
    const currentInput = inputRef.current;
    const currentCursorPos = cursorPositionRef.current;

    if (currentCursorPos >= currentInput.length) {
      return;
    }

    const result = deleteWordAfterCursorUtil(currentInput, currentCursorPos);
    const newInput = result.value;
    const newCursorPos = result.cursorOffset;

    inputRef.current = newInput;
    cursorPositionRef.current = newCursorPos;
    prunePastedBlocksForInput(newInput);

    setInput(newInput);
    setCursorPosition(newCursorPos);
    void updateSuggestions(newInput, newCursorPos);
  }, [
    setInput,
    setCursorPosition,
    updateSuggestions,
    prunePastedBlocksForInput,
  ]);

  /**
   * Delete to start of current line (Cmd/Ctrl+Backspace/Delete semantics)
   * - Deletes only content to the left of the cursor
   * - If cursor is at start of the line, remove the preceding newline (join with previous line)
   */
  const deleteCurrentLine = useCallback((): void => {
    if (input.length === 0) return;

    // Find start of current line
    const beforeCursor = input.substring(0, cursorPosition);
    const lastNewline = beforeCursor.lastIndexOf('\n');
    const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;

    // If at start of line, remove the newline before it (join with previous line)
    if (cursorPosition === lineStart) {
      if (lineStart > 0) {
        const newInput =
          input.substring(0, lineStart - 1) + input.substring(lineStart);
        const newCursorPosition = lineStart - 1;

        inputRef.current = newInput;
        cursorPositionRef.current = newCursorPosition;
        prunePastedBlocksForInput(newInput);
        setInput(newInput);
        setCursorPosition(newCursorPosition);
        void updateSuggestions(newInput, newCursorPosition);
      }
      // If at very start of input, nothing to delete
      return;
    }

    // Delete from line start to cursor (left side only)
    const before = input.substring(0, lineStart);
    const after = input.substring(cursorPosition);
    const newInput = before + after;
    const newCursorPosition = lineStart;

    inputRef.current = newInput;
    cursorPositionRef.current = newCursorPosition;
    prunePastedBlocksForInput(newInput);
    setInput(newInput);
    setCursorPosition(newCursorPosition);
    void updateSuggestions(newInput, newCursorPosition);
  }, [
    input,
    cursorPosition,
    setInput,
    setCursorPosition,
    updateSuggestions,
    prunePastedBlocksForInput,
  ]);

  /**
   * Delete from cursor to end of line
   */
  const deleteToEndOfLine = useCallback((): void => {
    if (input.length === 0 || cursorPosition >= input.length) {
      return;
    }

    // Find end of current line
    const afterCursor = input.substring(cursorPosition);
    const nextNewline = afterCursor.indexOf('\n');
    const lineEnd =
      nextNewline === -1 ? input.length : cursorPosition + nextNewline;

    // Delete from cursor to end of line
    const before = input.substring(0, cursorPosition);
    const after = input.substring(lineEnd);
    const newInput = before + after;

    prunePastedBlocksForInput(newInput);
    setInput(newInput);
    // Keep cursor at same position
    setCursorPosition(cursorPosition);
    void updateSuggestions(newInput, cursorPosition);
  }, [
    input,
    cursorPosition,
    setInput,
    setCursorPosition,
    updateSuggestions,
    prunePastedBlocksForInput,
  ]);

  /**
   * Helper function to insert text at cursor position
   */
  const insertTextAtCursor = useCallback(
    (textToInsert: string, isPasted: boolean = false) => {
      const currentInput = inputRef.current;
      const currentCursorPos = cursorPositionRef.current;
      const safeCurrentPosition = Math.max(
        0,
        Math.min(currentCursorPos, currentInput.length)
      );
      const before = currentInput.substring(0, safeCurrentPosition);
      const after = currentInput.substring(safeCurrentPosition);

      let displayText = textToInsert;

      // If this is pasted text, check if it should be shortened
      if (isPasted) {
        // Keep the original text for storage (before any sanitization)
        const originalText = textToInsert;

        // Sanitize pasted text to prevent control sequences in display
        displayText = sanitizePastedTextForDisplay(textToInsert);

        // Set paste flag to prevent Enter key processing during paste
        markPasteInProgress();

        // Check if text should be wrapped with [...] format
        const charCount = originalText.length;
        const rawLineCount = originalText.split('\n').length;

        // Only wrap if text is > 400 characters OR > 8 lines
        const shouldWrap = charCount > 400 || rawLineCount > 8;

        if (shouldWrap) {
          let lineCount = 0;

          if (width) {
            // Calculate how many visual lines the text would occupy
            // Use display width to handle wide characters (CJK, emoji, etc.)
            const allLines = originalText
              .split('\n')
              .flatMap((line) =>
                getDisplayWidth(line) > width ? wrapText(line, width) : [line]
              );
            lineCount = allLines.length;
          } else {
            // Use raw line count when width not available
            lineCount = rawLineCount;
          }

          // Get first 50 characters for preview (from sanitized text for clean display)
          // Convert tabs to spaces in preview to avoid display issues
          const preview = displayText
            .substring(0, 50)
            .replace(/\n/g, ' ')
            .replace(/\t/g, ' ')
            .trim();
          const wrappedText = createPastedBlockPlaceholder(preview, lineCount);

          // CRITICAL: Store the ORIGINAL FULL TEXT in the map, not the sanitized version
          // This ensures the full content is sent to the LLM when expanded
          setPastedBlocks((prev) => {
            const newMap = new Map(prev);
            newMap.set(wrappedText, originalText);
            return newMap;
          });

          displayText = wrappedText;
        }
      }

      const newInput = before + displayText + after;
      const newCursorPosition = before.length + displayText.length;

      // Update refs immediately
      inputRef.current = newInput;
      cursorPositionRef.current = newCursorPosition;

      // Apply the changes
      setInput(newInput);
      setCursorPosition(newCursorPosition);

      // Small delay to ensure state is updated before updating suggestions
      setTimeout(() => {
        void updateSuggestions(newInput, newCursorPosition);
      }, 0);
    },
    [
      width,
      setInput,
      setCursorPosition,
      updateSuggestions,
      setPastedBlocks,
      markPasteInProgress,
      createPastedBlockPlaceholder,
    ]
  );

  /**
   * Paste text from clipboard at cursor position
   */
  const pasteFromClipboard = useCallback(async (): Promise<boolean> => {
    const clipboardText = await readFromClipboard();
    if (!clipboardText) {
      return false;
    }

    // Use insertTextAtCursor with isPasted flag to handle large pastes
    insertTextAtCursor(clipboardText, true);
    return true;
  }, [insertTextAtCursor]);

  const tryPasteImageFromClipboard = useCallback(async (): Promise<boolean> => {
    if (!handleImagePaste) {
      return false;
    }

    return await handleImagePaste();
  }, [handleImagePaste]);

  const pasteFromClipboardWithImageFallback =
    useCallback(async (): Promise<void> => {
      if (await pasteFromClipboard()) {
        return;
      }

      await tryPasteImageFromClipboard();
    }, [pasteFromClipboard, tryPasteImageFromClipboard]);

  // ===== HANDLER IMPLEMENTATIONS =====

  const closeAutocompleteMenus = useCallback((): void => {
    setShowSuggestions(false);
    setShowCommands(false);
  }, [setShowSuggestions, setShowCommands]);

  const clearRepeatedKeySequenceTimer = useCallback((): void => {
    if (repeatedKeySequenceTimerRef.current) {
      clearTimeout(repeatedKeySequenceTimerRef.current);
      repeatedKeySequenceTimerRef.current = undefined;
    }
  }, []);

  const resetRepeatedKeySequence = useCallback((): void => {
    repeatedKeySequenceRef.current = undefined;
    clearedDraftBeforeDoubleEscapeRef.current = undefined;
    clearRepeatedKeySequenceTimer();
  }, [clearRepeatedKeySequenceTimer]);

  const resolveEscapeSequence = useCallback(
    (count: number): void => {
      if (count === 1) {
        return;
      }

      if (count === 2) {
        if (inputRef.current.length === 0) {
          return;
        }

        clearedDraftBeforeDoubleEscapeRef.current = {
          input: inputRef.current,
          cursorPosition: cursorPositionRef.current,
        };
        inputRef.current = '';
        cursorPositionRef.current = 0;
        setInput('');
        setCursorPosition(0);
        void updateSuggestions('', 0);
        return;
      }

      if (count >= 3) {
        const clearedDraft = clearedDraftBeforeDoubleEscapeRef.current;
        if (clearedDraft) {
          ignoredInputChangeValueRef.current = '';
          inputRef.current = clearedDraft.input;
          cursorPositionRef.current = clearedDraft.cursorPosition;
          setInput(clearedDraft.input);
          setCursorPosition(clearedDraft.cursorPosition);
          onInputChange?.(clearedDraft.input);
          void updateSuggestions(
            clearedDraft.input,
            clearedDraft.cursorPosition
          );
        }
        void onRewindShortcut?.({ keyId: 'escape', count });
      }
    },
    [
      onInputChange,
      onRewindShortcut,
      setInput,
      setCursorPosition,
      updateSuggestions,
    ]
  );

  const resolveRepeatedKeySequence = useCallback(
    ({ keyId, count }: RepeatedKeyResolution): void => {
      switch (keyId) {
        case 'escape':
          resolveEscapeSequence(count);
          return;
        default: {
          const exhaustiveKeyId: never = keyId;
          return exhaustiveKeyId;
        }
      }
    },
    [resolveEscapeSequence]
  );

  const handleRepeatedKeyPress = useCallback(
    (keyId: RepeatedKeyId, onFirstPress?: () => void): boolean => {
      const activeSequence = repeatedKeySequenceRef.current;
      const nextSequence: RepeatedKeyResolution =
        activeSequence?.keyId === keyId
          ? { keyId, count: activeSequence.count + 1 }
          : { keyId, count: 1 };

      repeatedKeySequenceRef.current = nextSequence;
      clearRepeatedKeySequenceTimer();

      if (nextSequence.count === 1) {
        onFirstPress?.();
      }

      const repeatedKeySequenceTimeoutMs = getRepeatedKeySequenceTimeoutMs();
      if (repeatedKeySequenceTimeoutMs === undefined) {
        resolveRepeatedKeySequence(nextSequence);
        if (nextSequence.count >= 3) {
          resetRepeatedKeySequence();
        } else {
          repeatedKeySequenceTimerRef.current = setTimeout(
            resetRepeatedKeySequence,
            getNonTmuxRepeatedKeySequenceResetMs()
          );
        }
        return nextSequence.count > 1;
      }

      repeatedKeySequenceTimerRef.current = setTimeout(() => {
        const pendingSequence = repeatedKeySequenceRef.current;
        repeatedKeySequenceRef.current = undefined;
        repeatedKeySequenceTimerRef.current = undefined;

        if (pendingSequence) {
          resolveRepeatedKeySequence(pendingSequence);
        }
        clearedDraftBeforeDoubleEscapeRef.current = undefined;
      }, repeatedKeySequenceTimeoutMs);

      return nextSequence.count > 1;
    },
    [
      clearRepeatedKeySequenceTimer,
      resetRepeatedKeySequence,
      resolveRepeatedKeySequence,
    ]
  );

  const handleEscSequencePress = useCallback(
    (): boolean => handleRepeatedKeyPress('escape', onEscape),
    [handleRepeatedKeyPress, onEscape]
  );

  useEffect(
    () => () => {
      clearRepeatedKeySequenceTimer();
      if (escapeTimeoutRef.current) {
        clearTimeout(escapeTimeoutRef.current);
        escapeTimeoutRef.current = undefined;
      }
    },
    [clearRepeatedKeySequenceTimer]
  );

  /**
   * Handle navigation in suggestions list
   */
  const handleSuggestionsNavigation = useCallback(
    (_inputChar: string, key: KeyObject): boolean => {
      if (showSuggestions && suggestions.length > 0) {
        if (key.upArrow) {
          setSelectedSuggestionIndex((prev) =>
            prev <= 0 ? suggestions.length - 1 : prev - 1
          );
          return true;
        }
        if (key.downArrow) {
          setSelectedSuggestionIndex((prev) =>
            prev >= suggestions.length - 1 ? 0 : prev + 1
          );
          return true;
        }
        if (
          key.tab ||
          (key.return && !key.shift && (!key.ctrl || !enableQueuedMessages))
        ) {
          selectSuggestion(suggestions[selectedSuggestionIndex]);
          return true;
        }
        if (key.escape) {
          closeAutocompleteMenus();
          return true;
        }
      }
      return false;
    },
    [
      showSuggestions,
      suggestions,
      selectedSuggestionIndex,
      setSelectedSuggestionIndex,
      selectSuggestion,
      closeAutocompleteMenus,
      enableQueuedMessages,
    ]
  );

  /**
   * Handle navigation in commands list
   */
  const handleCommandsNavigation = useCallback(
    (_inputChar: string, key: KeyObject): boolean => {
      if (showCommands && filteredCommands.length > 0) {
        if (key.upArrow) {
          setSelectedSuggestionIndex((prev) =>
            prev <= 0 ? filteredCommands.length - 1 : prev - 1
          );
          return true;
        }
        if (key.downArrow) {
          setSelectedSuggestionIndex((prev) =>
            prev >= filteredCommands.length - 1 ? 0 : prev + 1
          );
          return true;
        }
        if (key.tab) {
          // Tab: Auto-complete the command name without submitting
          const selectedCommand = selectSlashCommandForCompletion({
            input: inputRef.current,
            cursorPosition: cursorPositionRef.current,
            availableCommands,
            displayedCommands: filteredCommands,
            selectedIndex: selectedSuggestionIndex,
          });
          if (!selectedCommand) {
            return true;
          }
          const commandText = `/${selectedCommand.name} `;

          // Update refs immediately to keep them in sync
          inputRef.current = commandText;
          cursorPositionRef.current = commandText.length;

          // Update React state
          setInput(commandText);
          setCursorPosition(commandText.length);
          setShowCommands(false);

          // Refresh suggestions with the new input
          void updateSuggestions(commandText, commandText.length);

          return true;
        }
        if (key.return && !key.shift && (!key.ctrl || !enableQueuedMessages)) {
          // Enter: Select the command and execute it immediately.
          // If the input already contains an exact slash command, submit it
          // instead of the highlighted item; command filtering can lag behind
          // fast terminal input by a render frame.
          const inputText = inputRef.current.trim();
          const exactCommandText = getExactCommandTextFromInput(
            inputText,
            filteredCommands
          );
          // Preserve the full input text when it contains the selected
          // command followed by arguments (e.g. "/fast off"), otherwise
          // fall back to the highlighted suggestion name.
          const selectedCommand = filteredCommands[selectedSuggestionIndex];
          const prefix = `/${selectedCommand.name} `;
          const hasArgs = inputText
            .toLowerCase()
            .startsWith(prefix.toLowerCase());
          const commandText =
            exactCommandText ??
            (hasArgs
              ? `/${selectedCommand.name} ${inputText.slice(prefix.length)}`
              : `/${selectedCommand.name}`);
          ignoreSubmittedInputChangeEffects(inputRef.current);
          inputRef.current = '';
          cursorPositionRef.current = 0;
          setInput('');
          setCursorPosition(0);
          setShowCommands(false);
          onInputChange?.('');

          // Clear pasted blocks when executing command
          setPastedBlocks(new Map());
          pastedBlockCounter.current = 0;

          // Execute the command immediately
          if (onSubmit) {
            void onSubmit(commandText);
          }
          return true;
        }
        if (key.escape) {
          closeAutocompleteMenus();
          return true;
        }
      }
      return false;
    },
    [
      showCommands,
      filteredCommands,
      availableCommands,
      selectedSuggestionIndex,
      setSelectedSuggestionIndex,
      setInput,
      setCursorPosition,
      closeAutocompleteMenus,
      onSubmit,
      onInputChange,
      ignoreSubmittedInputChangeEffects,
      setPastedBlocks,
      updateSuggestions,
      enableQueuedMessages,
    ]
  );

  /**
   * Handle ANSI escape sequences for special key combinations
   */
  const handleAnsiEscapeSequences = useCallback(
    (inputChar: string): boolean => {
      if (
        inputChar &&
        (inputChar.includes(`${ANSI.ESC}[`) || inputChar.startsWith('['))
      ) {
        // Kitty CSI-u: Shift+Tab => ESC[9;2u (also sometimes just [9;2u)
        if (matchKeyboardChord({ input: inputChar }, 'shift-tab')) {
          if (!showSuggestions && !showCommands && onModeToggle) {
            onModeToggle();
            return true;
          }
        }

        // Kitty CSI-u: ESC key => ESC[27u (also sometimes just [27u)
        if (inputChar === ANSI.ESC_KITTY || inputChar === '[27u') {
          // Match behavior of ESC key across UI states
          if (showSuggestions || showCommands) {
            closeAutocompleteMenus();
            return true;
          }

          if (isBashMode && onToggleBashMode) {
            onToggleBashMode();
            return true;
          }

          return handleEscSequencePress();
        }

        // Option+Left Arrow
        if (
          inputChar === ANSI.OPTION_LEFT_ARROW_1 ||
          inputChar === ANSI.OPTION_LEFT_ARROW_2
        ) {
          jumpToPreviousWord();
          return true;
        }

        // Option+Right Arrow
        if (
          inputChar === ANSI.OPTION_RIGHT_ARROW_1 ||
          inputChar === ANSI.OPTION_RIGHT_ARROW_2
        ) {
          jumpToNextWord();
          return true;
        }

        // Ctrl+Left Arrow (common on Windows / xterm)
        if (inputChar === ANSI.CTRL_LEFT_ARROW) {
          jumpToPreviousWord();
          return true;
        }

        // Ctrl+Right Arrow
        if (inputChar === ANSI.CTRL_RIGHT_ARROW) {
          jumpToNextWord();
          return true;
        }

        // Shift+Left Arrow → start of line
        if (inputChar === ANSI.SHIFT_LEFT_ARROW) {
          jumpToLineStart();
          return true;
        }

        // Shift+Right Arrow → end of line
        if (inputChar === ANSI.SHIFT_RIGHT_ARROW) {
          jumpToLineEnd();
          return true;
        }

        // Command+Left Arrow / Home
        if (
          inputChar === ANSI.CMD_LEFT_ARROW_1 ||
          inputChar === ANSI.CMD_LEFT_ARROW_2
        ) {
          jumpToLineStart();
          return true;
        }

        // Command+Right Arrow / End
        if (
          inputChar === ANSI.CMD_RIGHT_ARROW_1 ||
          inputChar === ANSI.CMD_RIGHT_ARROW_2
        ) {
          jumpToInputEnd();
          return true;
        }

        // Command+Delete (delete whole line) — only Ctrl+U variant
        if (inputChar === ANSI.CMD_DELETE_2) {
          deleteCurrentLine();
          return true;
        }

        // Ctrl+Shift+Delete (whole line deletion on many Windows terminals)
        if (
          inputChar === ANSI.CTRL_SHIFT_DELETE ||
          inputChar === '[3;6~' // Some terminals omit the leading ESC
        ) {
          deleteCurrentLine();
          return true;
        }

        // Forward delete key (fn + delete on Mac, Delete on Windows/Linux)
        if (
          inputChar === ANSI.FORWARD_DELETE ||
          inputChar === ANSI.CMD_DELETE_1 ||
          inputChar === ANSI.MAC_FN_DELETE_KITTY ||
          inputChar === ANSI.MAC_FN_DELETE_STANDARD
        ) {
          // On all platforms, forward delete should delete character after cursor
          deleteCharAfterCursor();
          return true;
        }

        // Shift+Enter (terminal-specific escape sequences)
        // Handle both with and without leading ESC character
        if (
          inputChar === ANSI.SHIFT_ENTER_GHOSTTY ||
          inputChar === ANSI.SHIFT_ENTER_XTERM ||
          inputChar === '[27;2;13~' ||
          inputChar === '[13;2u'
        ) {
          // Add newline at cursor position (same as Shift+Enter handling)
          const currentInput = inputRef.current;
          const currentCursorPos = cursorPositionRef.current;
          const before = currentInput.substring(0, currentCursorPos);
          const after = currentInput.substring(currentCursorPos);
          const newInput = `${before}\n${after}`;
          const newPos = currentCursorPos + 1;

          // Update refs immediately
          inputRef.current = newInput;
          cursorPositionRef.current = newPos;

          setInput(newInput);
          setCursorPosition(newPos);
          void updateSuggestions(newInput, newPos);
          return true;
        }
      }
      return false;
    },
    [
      jumpToPreviousWord,
      jumpToNextWord,
      jumpToLineStart,
      jumpToLineEnd,
      jumpToInputEnd,
      deleteCurrentLine,
      deleteCharAfterCursor,
      showSuggestions,
      showCommands,
      closeAutocompleteMenus,
      isBashMode,
      onToggleBashMode,
      onModeToggle,
      setInput,
      setCursorPosition,
      updateSuggestions,
      handleEscSequencePress,
    ]
  );

  /**
   * Handle meta/command key combinations
   */
  const handleMetaKeyCombinations = useCallback(
    (inputChar: string, key: KeyObject): boolean => {
      if (key.return) {
        return false;
      }

      if (key.meta && !key.shift) {
        if (key.leftArrow) {
          jumpToLineStart();
          return true;
        }

        if (key.rightArrow) {
          jumpToInputEnd();
          return true;
        }

        // Handle Option+b (previous word) and Option+f (next word)
        // Note: For ESC-prefix meta keys (e.g. Ghostty sends \x1bb for Option+Left),
        // readline returns ch=undefined so inputChar is ''. Fall back to key.name.
        if (inputChar === 'b' || key.name === 'b') {
          jumpToPreviousWord();
          return true;
        }

        if (inputChar === 'f' || key.name === 'f') {
          jumpToNextWord();
          return true;
        }

        // Handle Option+d (delete word after cursor)
        if (inputChar === 'd' || inputChar === 'D' || key.name === 'd') {
          deleteWordAfterCursor();
          return true;
        }

        // Handle Option+a (jump to line start) and Option+e (jump to line end)
        if (inputChar === 'a' || inputChar === 'A' || key.name === 'a') {
          jumpToLineStart();
          return true;
        }

        if (inputChar === 'e' || inputChar === 'E' || key.name === 'e') {
          jumpToLineEnd();
          return true;
        }

        // Handle Cmd+V paste on Unix systems (Mac, Linux, etc.)
        if (!isWindows && (inputChar === 'v' || inputChar === 'V')) {
          void pasteFromClipboardWithImageFallback();
          return true;
        }

        // Handle Alt+V paste on Windows systems (for images)
        if (isWindows && (inputChar === 'v' || inputChar === 'V')) {
          void pasteFromClipboardWithImageFallback();
          return true;
        }

        // Meta/Option + Backspace/Delete → delete previous word across platforms
        if (key.delete || key.backspace) {
          deleteWordBeforeCursor();
          return true;
        }

        // Swallow any other meta+key combo (e.g. Cmd+C, Cmd+X, Cmd+A).
        // With Kitty protocol, Cmd+key sends CSI-u with super modifier
        // mapped to meta. The terminal handles these at the OS level
        // (copy, cut, select-all); we must not let them fall through
        // to regular character insertion.
        return true;
      }
      return false;
    },
    [
      jumpToLineStart,
      jumpToLineEnd,
      jumpToInputEnd,
      jumpToPreviousWord,
      jumpToNextWord,
      deleteWordBeforeCursor,
      deleteWordAfterCursor,
      pasteFromClipboardWithImageFallback,
    ]
  );

  /**
   * Handle basic arrow key navigation
   */
  const handleArrowKeyNavigation = useCallback(
    (key: KeyObject): boolean => {
      if (key.leftArrow) {
        // Modifier-aware navigation
        if (key.shift) {
          jumpToLineStart();
          return true;
        }
        if (key.ctrl) {
          jumpToPreviousWord();
          return true;
        }

        const newPos = Math.max(0, cursorPosition - 1);
        setCursorPosition(newPos);
        void updateSuggestions(input, newPos);
        return true;
      }
      if (key.rightArrow) {
        if (key.shift) {
          jumpToLineEnd();
          return true;
        }
        if (key.ctrl) {
          jumpToNextWord();
          return true;
        }
        const newPos = Math.min(input.length, cursorPosition + 1);
        setCursorPosition(newPos);
        void updateSuggestions(input, newPos);
        return true;
      }
      if (key.upArrow || key.downArrow) {
        const isMultiline = layout.displayLines.length > 1;
        const isAtLastVisualLine =
          layout.cursorLine >= layout.displayLines.length - 1;

        if (isMultiline && navigateMultilineWithArrows(key)) {
          return true;
        }

        // If not multiline or at boundaries, try history navigation
        if (historyService && key.upArrow) {
          const previousEntry = historyService.navigatePrevious(input);
          if (previousEntry !== null) {
            setInput(previousEntry.command);
            setCursorPosition(0);
            void updateSuggestions(previousEntry.command, 0);

            // Switch to the appropriate mode if needed
            if (
              previousEntry.mode === 'bash' &&
              !isBashMode &&
              onToggleBashMode
            ) {
              onToggleBashMode();
            } else if (
              previousEntry.mode === 'chat' &&
              isBashMode &&
              onToggleBashMode
            ) {
              onToggleBashMode();
            }

            return true;
          }
        }
        if (historyService && key.downArrow && isAtLastVisualLine) {
          const nextEntry = historyService.navigateNext();

          if (nextEntry !== null) {
            setInput(nextEntry.command);
            setCursorPosition(0);
            void updateSuggestions(nextEntry.command, 0);

            // Switch to the appropriate mode if needed
            if (nextEntry.mode === 'bash' && !isBashMode && onToggleBashMode) {
              onToggleBashMode();
            } else if (
              nextEntry.mode === 'chat' &&
              isBashMode &&
              onToggleBashMode
            ) {
              onToggleBashMode();
            }

            return true;
          }
        }

        if (key.downArrow && isAtLastVisualLine && onDownArrowAtBottom) {
          onDownArrowAtBottom();
          return true;
        }

        return false;
      }
      return false;
    },
    [
      input,
      cursorPosition,
      setCursorPosition,
      navigateMultilineWithArrows,
      updateSuggestions,
      setInput,
      historyService,
      layout.displayLines.length,
      onDownArrowAtBottom,
    ]
  );

  /**
   * Helper function to expand pasted text placeholders
   */
  const expandPastedText = useCallback((text: string): string => {
    let expandedText = text;
    const pastedBlocks = pastedBlocksRef.current;

    for (const [placeholder, actualText] of pastedBlocks) {
      if (expandedText.includes(placeholder)) {
        expandedText = expandedText.split(placeholder).join(actualText);
      }
    }

    return expandedText;
  }, []);

  /**
   * Expand any pasted-block placeholders currently present in the input back
   * into their original content, in-place. Used by Alt+Shift+V so users can
   * inspect/edit a truncated paste without leaving the CLI.
   */
  const expandPastedBlocksInline = useCallback((): boolean => {
    const pastedBlocks = pastedBlocksRef.current;
    if (pastedBlocks.size === 0) {
      return false;
    }

    const currentInput = inputRef.current;
    const currentCursorPos = cursorPositionRef.current;

    let newInput = currentInput;
    let newCursor = currentCursorPos;
    const expandedPlaceholders: string[] = [];

    for (const [placeholder, actualText] of pastedBlocks) {
      let searchFrom = 0;
      while (true) {
        const idx = newInput.indexOf(placeholder, searchFrom);
        if (idx === -1) break;
        const displayText = sanitizePastedTextForDisplay(actualText);
        newInput =
          newInput.slice(0, idx) +
          displayText +
          newInput.slice(idx + placeholder.length);
        const delta = displayText.length - placeholder.length;
        if (idx < newCursor) {
          if (idx + placeholder.length <= newCursor) {
            newCursor += delta;
          } else {
            newCursor = idx + displayText.length;
          }
        }
        searchFrom = idx + displayText.length;
        expandedPlaceholders.push(placeholder);
      }
    }

    if (expandedPlaceholders.length === 0) {
      return false;
    }

    setPastedBlocks((prev) => {
      const next = new Map(prev);
      for (const placeholder of expandedPlaceholders) {
        next.delete(placeholder);
      }
      return next;
    });

    inputRef.current = newInput;
    cursorPositionRef.current = newCursor;
    setInput(newInput);
    setCursorPosition(newCursor);
    void updateSuggestions(newInput, newCursor);
    return true;
  }, [setPastedBlocks, setInput, setCursorPosition, updateSuggestions]);

  const applyEditedInput = useCallback(
    (editedInput: string): void => {
      const normalizedInput = editedInput.replace(/\r?\n$/, '');
      inputRef.current = normalizedInput;
      cursorPositionRef.current = normalizedInput.length;
      setInput(normalizedInput);
      setCursorPosition(normalizedInput.length);
      setPastedBlocks(new Map());
      pastedBlockCounter.current = 0;
      historyService?.resetPosition();
      void onEditorInputApplied?.(normalizedInput);
      void updateSuggestions(normalizedInput, normalizedInput.length);
    },
    [
      historyService,
      onEditorInputApplied,
      setInput,
      setCursorPosition,
      setPastedBlocks,
      updateSuggestions,
    ]
  );

  const cleanupPendingEditor = useCallback(async (): Promise<void> => {
    const pendingEditor = pendingEditorRef.current;
    setPendingEditor(null);
    setEditorGuidance(null);
    if (pendingEditor) {
      try {
        await pendingEditor.cleanup();
      } catch (error) {
        logWarn('[useChatKeyboardInput] Failed to clean up pending editor', {
          error,
        });
      }
    }
  }, [setPendingEditor]);

  const confirmPendingEditor = useCallback(async (): Promise<void> => {
    const pendingEditor = pendingEditorRef.current;
    if (!pendingEditor) {
      return;
    }

    try {
      const editedInput = await pendingEditor.readContent();
      await cleanupPendingEditor();
      applyEditedInput(editedInput);
    } catch (error) {
      await cleanupPendingEditor();
      onWarning?.(
        getI18n().t('common:chatInput.editorOpenError', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }, [applyEditedInput, cleanupPendingEditor, onWarning]);

  const openInputInEditor = useCallback(async (): Promise<void> => {
    if (isOpeningEditorRef.current || pendingEditorRef.current) {
      return;
    }

    isOpeningEditorRef.current = true;
    setIsOpeningEditor(true);
    closeAutocompleteMenus();
    const editorInfo = detectEditor();
    const editorName = editorInfo.editor;
    setEditorGuidance(getI18n().t('common:chatInput.editorOpening'));

    try {
      if (editorInfo.isSync && !onEditorInputApplied) {
        setEditorGuidance(null);
        onWarning?.(
          getI18n().t('common:chatInput.editorOpenError', {
            error: getI18n().t('common:chatInput.editorUnavailable'),
          })
        );
        return;
      }

      const editorResult = await getEditorService().openTextAndWait({
        content: expandPastedText(inputRef.current),
        fileName: isBashMode ? 'command.sh' : 'prompt.md',
        tempDirPrefix: 'industry-input-edit-',
      });

      if (!editorResult.success) {
        setEditorGuidance(null);
        onWarning?.(
          getI18n().t('common:chatInput.editorOpenError', {
            error: editorResult.error,
          })
        );
        return;
      }

      if (editorResult.isAsyncEditor) {
        setPendingEditor(editorResult);
        setEditorGuidance(
          getI18n().t('common:chatInput.editorOpenGuidance', {
            editor: editorName,
            filePath: editorResult.filePath,
          })
        );
        return;
      }

      setEditorGuidance(null);
      applyEditedInput(editorResult.content);
    } catch (error) {
      setEditorGuidance(null);
      onWarning?.(
        getI18n().t('common:chatInput.editorOpenError', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      isOpeningEditorRef.current = false;
      setIsOpeningEditor(false);
    }
  }, [
    applyEditedInput,
    closeAutocompleteMenus,
    expandPastedText,
    isBashMode,
    onEditorInputApplied,
    onWarning,
    setPendingEditor,
  ]);

  const handlePendingEditorConfirmation = useCallback(
    (inputChar: string, key: KeyObject): boolean => {
      if (!pendingEditorRef.current) {
        return false;
      }

      if (key.return) {
        void confirmPendingEditor();
        return true;
      }

      if (matchKeyboardChord({ key, input: inputChar }, 'escape')) {
        void cleanupPendingEditor();
        return true;
      }

      return true;
    },
    [cleanupPendingEditor, confirmPendingEditor]
  );

  /**
   * Handle Enter key
   */
  const handleEnterKey = useCallback(
    (key: KeyObject): boolean => {
      if (key.return) {
        // Don't process Enter key during active paste operation
        if (isPastingRef.current || isPasting) {
          return true;
        }

        if (key.shift) {
          // Shift+Enter: add newline at cursor position
          const currentInput = inputRef.current;
          const currentCursorPos = cursorPositionRef.current;
          const before = currentInput.substring(0, currentCursorPos);
          const after = currentInput.substring(currentCursorPos);
          const newInput = `${before}\n${after}`;
          const newPos = currentCursorPos + 1;

          // Update refs immediately
          inputRef.current = newInput;
          cursorPositionRef.current = newPos;

          setInput(newInput);
          setCursorPosition(newPos);
          void updateSuggestions(newInput, newPos);
        } else if (!showSuggestions) {
          // If previous char is a backslash, interpret Enter as newline (replace backslash)
          const currentInput = inputRef.current;
          const currentCursorPos = cursorPositionRef.current;
          const before = currentInput.substring(0, currentCursorPos);
          const after = currentInput.substring(currentCursorPos);
          const isEndOfLoopSubmit =
            enableQueuedMessages &&
            matchKeyboardChord({ key, input: '' }, 'ctrl-enter');
          if (!isEndOfLoopSubmit && before.endsWith('\\')) {
            const newBefore = before.slice(0, -1);
            const newInput = `${newBefore}\n${after}`;
            const newPos = newBefore.length + 1;

            inputRef.current = newInput;
            cursorPositionRef.current = newPos;

            setInput(newInput);
            setCursorPosition(newPos);
            void updateSuggestions(newInput, newPos);
            return true;
          }
          // Regular Enter: submit
          const currentInputValue = inputRef.current;
          const trimmed = currentInputValue.trim();
          if (trimmed) {
            // Expand any pasted text placeholders before submitting
            const expandedText = expandPastedText(trimmed);

            // Add to history before submitting (use expanded text)
            if (historyService) {
              const commandType = expandedText.startsWith('/')
                ? 'slash_command'
                : isBashMode
                  ? 'bash_command'
                  : 'message';
              const mode = isBashMode ? 'bash' : 'chat';
              historyService.addCommand(expandedText, commandType, mode);
            }

            // Hide help menu on submit
            if (showHelpHints && setShowHelpHints) {
              setShowHelpHints(false);
            }

            // Queue submits (Ctrl+Enter) bypass the menu navigation handlers,
            // so close the autocomplete menus here or their stale state would
            // execute the highlighted command on the next plain Enter.
            closeAutocompleteMenus();

            // Clear pasted blocks after submission
            setPastedBlocks(new Map());
            pastedBlockCounter.current = 0;

            // Update refs before submit because slash commands can unmount the
            // input synchronously when opening an overlay.
            ignoreSubmittedInputChangeEffects(currentInputValue);
            inputRef.current = '';
            cursorPositionRef.current = 0;
            setInput('');
            setCursorPosition(0);
            onInputChange?.('');

            // If in bash mode, use bash submit handler
            if (isBashMode && onBashSubmit) {
              onBashSubmit(expandedText);
            } else if (onSubmit) {
              if (isEndOfLoopSubmit) {
                void onSubmit(expandedText, {
                  queuePlacement: QueuePlacement.EndOfLoop,
                });
              } else {
                void onSubmit(expandedText);
              }
            }

            // Reset history position after submission
            if (historyService) {
              historyService.resetPosition();
            }
          }
        }
        return true;
      }
      return false;
    },
    [
      isPasting,
      showSuggestions,
      onSubmit,
      onBashSubmit,
      isBashMode,
      enableQueuedMessages,
      setInput,
      setCursorPosition,
      updateSuggestions,
      historyService,
      expandPastedText,
      setPastedBlocks,
      showHelpHints,
      setShowHelpHints,
      onInputChange,
      ignoreSubmittedInputChangeEffects,
      closeAutocompleteMenus,
    ]
  );

  /**
   * Handle backspace and delete keys
   */
  const handleBackspaceAndDelete = useCallback(
    (key: KeyObject, inputChar: string): boolean => {
      /* ---------- modifier combinations (handle first) ---------- */
      // Shift + Delete → forward delete one character (mac fn+shift+delete)
      if (key.delete && key.shift) {
        deleteCharAfterCursor();
        return true;
      }

      // Ctrl + Backspace  → delete previous word
      if (key.backspace && key.ctrl) {
        deleteWordBeforeCursor();
        return true;
      }

      // Shift + Backspace → delete character before cursor (same as regular Backspace)
      if (key.backspace && key.shift) {
        deleteCharBeforeCursor();
        return true;
      }

      // Ctrl + Delete     → delete word forward (mirrors ESC+d / Option+d)
      if (key.delete && key.ctrl) {
        deleteWordAfterCursor();
        return true;
      }

      // Regular backspace
      if (key.backspace) {
        if (cursorPosition > 0) {
          deleteCharBeforeCursor();
        }
        return true;
      }

      // Delete key behavior varies by platform
      if (key.delete) {
        if (isWindows || process.platform === 'linux') {
          // On Windows and Linux, delete key removes character after cursor
          deleteCharAfterCursor();
        } else if (cursorPosition > 0) {
          // Otherwise, the "delete" key acts like backspace (removes character before cursor)
          deleteCharBeforeCursor();
        }
        return true;
      }

      // Special control characters that might be delete (acts as backspace on Mac)
      // \x08 is Ctrl+H (BS) and \x7F is the DEL character used by modern terminals for backspace.
      // Ctrl+Backspace (word delete) is handled above via key.backspace && key.ctrl.
      if (inputChar === ANSI.BACKSPACE || inputChar === '\x08') {
        if (cursorPosition > 0) {
          deleteCharBeforeCursor();
        }
        return true;
      }

      // Handle Option+Delete (delete word before cursor)
      if (inputChar === ANSI.OPTION_DELETE_1 || inputChar === ANSI.CTRL_W) {
        if (cursorPosition > 0) {
          deleteWordBeforeCursor();
        }
        return true;
      }

      return false;
    },
    [
      cursorPosition,
      input,
      deleteCharBeforeCursor,
      deleteCharAfterCursor,
      deleteWordBeforeCursor,
      deleteWordAfterCursor,
      deleteCurrentLine,
      setInput,
      updateSuggestions,
    ]
  );

  /**
   * Handle ESC key (including ESC sequences for cancel/clear/rewind)
   */
  const handleEscapeKey = useCallback(
    (key: KeyObject): boolean => {
      if (key.escape && !showSuggestions && !showCommands) {
        // If in bash mode, exit bash mode
        if (isBashMode && onToggleBashMode) {
          onToggleBashMode();
          return true;
        }

        return handleEscSequencePress();
      }
      return false;
    },
    [
      showSuggestions,
      showCommands,
      isBashMode,
      onToggleBashMode,
      handleEscSequencePress,
    ]
  );

  /**
   * Handle Tab key (including Shift+Tab for mode toggle)
   */
  const handleTabKey = useCallback(
    (key: KeyObject): boolean => {
      // Shift+Tab: Toggle interaction mode (Auto -> Spec -> Mission -> Auto)
      if (
        matchKeyboardChord({ key }, 'mode-toggle') &&
        !showSuggestions &&
        !showCommands
      ) {
        if (onModeToggle) {
          onModeToggle();
        }
        return true;
      }

      // Regular Tab: Cycle reasoning level
      if (
        matchKeyboardChord({ key }, 'reasoning-cycle') &&
        !showSuggestions &&
        !showCommands
      ) {
        if (onReasoningCycle) {
          onReasoningCycle();
          return true;
        }
      }

      // Regular Tab is handled elsewhere for suggestions
      return false;
    },
    [showSuggestions, showCommands, onModeToggle, onReasoningCycle]
  );

  /**
   * Handle Shift+Enter detected as special character
   * Note: We no longer treat raw backslash as Shift+Enter.
   */
  const handleShiftEnter = useCallback(
    (_inputChar: string): boolean => false,
    []
  );

  const handleStandaloneEscape = useCallback((): void => {
    if (showSuggestions || showCommands) {
      closeAutocompleteMenus();
      return;
    }

    if (isBashMode && onToggleBashMode) {
      onToggleBashMode();
      return;
    }

    handleEscSequencePress();
  }, [
    showSuggestions,
    showCommands,
    closeAutocompleteMenus,
    isBashMode,
    onToggleBashMode,
    handleEscSequencePress,
  ]);

  const scheduleStandaloneEscape = useCallback((): void => {
    waitingForEscapeCharRef.current = true;
    setWaitingForEscapeChar(true);

    if (escapeTimeoutRef.current) {
      clearTimeout(escapeTimeoutRef.current);
    }

    escapeTimeoutRef.current = setTimeout(() => {
      waitingForEscapeCharRef.current = false;
      setWaitingForEscapeChar(false);
      handleStandaloneEscape();
    }, DEFAULTS.ESC_TIMEOUT_MS);
  }, [setWaitingForEscapeChar, handleStandaloneEscape]);

  /**
   * Handle escape sequences for Option key combinations
   */
  const handleEscapeSequences = useCallback(
    (inputChar: string): boolean => {
      if (waitingForEscapeCharRef.current && inputChar) {
        clearTimeout(escapeTimeoutRef.current);
        waitingForEscapeCharRef.current = false;
        setWaitingForEscapeChar(false);

        if (inputChar === ANSI.ESC) {
          handleStandaloneEscape();
          scheduleStandaloneEscape();
          return true;
        }

        if (
          inputChar === ANSI.OPTION_B ||
          inputChar === ANSI.OPTION_B.toUpperCase()
        ) {
          jumpToPreviousWord();
          return true;
        }

        if (
          inputChar === ANSI.OPTION_F ||
          inputChar === ANSI.OPTION_F.toUpperCase()
        ) {
          jumpToNextWord();
          return true;
        }

        if (inputChar === ANSI.BACKSPACE) {
          deleteWordBeforeCursor();
          return true;
        }

        if (
          inputChar === ANSI.OPTION_D ||
          inputChar === ANSI.OPTION_D.toUpperCase()
        ) {
          deleteWordAfterCursor();
          return true;
        }

        // Handle line navigation with ESC+a (start) and ESC+e (end)
        if (
          inputChar === ANSI.OPTION_A ||
          inputChar === ANSI.OPTION_A.toUpperCase()
        ) {
          jumpToLineStart();
          return true;
        }

        if (
          inputChar === ANSI.OPTION_E ||
          inputChar === ANSI.OPTION_E.toUpperCase()
        ) {
          jumpToLineEnd();
          return true;
        }

        // Handle Alt+V (after ESC) for image pasting on Windows
        if (
          isWindows &&
          (inputChar === ANSI.ALT_V_ESC ||
            inputChar === ANSI.ALT_V_ESC.toUpperCase())
        ) {
          void pasteFromClipboardWithImageFallback();
          return true;
        }
      }
      return false;
    },
    [
      setWaitingForEscapeChar,
      jumpToPreviousWord,
      jumpToNextWord,
      deleteWordBeforeCursor,
      deleteWordAfterCursor,
      jumpToLineStart,
      jumpToLineEnd,
      handleStandaloneEscape,
      scheduleStandaloneEscape,
      pasteFromClipboardWithImageFallback,
    ]
  );

  /**
   * Check for ESC key to start escape sequence
   */
  const handleEscapeStart = useCallback(
    (inputChar: string): boolean => {
      if (inputChar === ANSI.ESC && !waitingForEscapeCharRef.current) {
        scheduleStandaloneEscape();
        return true;
      }
      return false;
    },
    [scheduleStandaloneEscape]
  );

  /**
   * Handle alternative Option key detection for different terminals
   */
  const handleAlternativeOptionKeys = useCallback(
    (inputChar: string): boolean => {
      if (inputChar && inputChar.length === 2 && inputChar[0] === ANSI.ESC) {
        const secondChar = inputChar[1];

        if (secondChar === 'b') {
          jumpToPreviousWord();
          return true;
        }

        if (secondChar === 'f') {
          jumpToNextWord();
          return true;
        }

        if (secondChar === 'd') {
          deleteWordAfterCursor();
          return true;
        }

        // Handle Alt+V (ESC + v) on Windows for image pasting
        if (isWindows && (secondChar === 'v' || secondChar === 'V')) {
          void pasteFromClipboardWithImageFallback();
          return true;
        }
      }
      return false;
    },
    [
      jumpToPreviousWord,
      jumpToNextWord,
      deleteWordAfterCursor,
      pasteFromClipboardWithImageFallback,
    ]
  );

  const handleMacosTerminalOptionTextAliases = useCallback(
    (inputChar: string, key: KeyObject): boolean => {
      const alias = getMacosTerminalOptionTextAlias({
        key,
        input: inputChar,
      });
      if (!alias) {
        return false;
      }

      if (alias === 'b') {
        jumpToPreviousWord();
        return true;
      }

      if (alias === 'f') {
        jumpToNextWord();
        return true;
      }

      if (alias === 'd') {
        deleteWordAfterCursor();
        return true;
      }

      if (alias === 'a') {
        jumpToLineStart();
        return true;
      }

      if (alias === 'e') {
        jumpToLineEnd();
        return true;
      }

      return false;
    },
    [
      deleteWordAfterCursor,
      jumpToLineEnd,
      jumpToLineStart,
      jumpToNextWord,
      jumpToPreviousWord,
    ]
  );

  /**
   * Handle Ctrl key combinations
   */
  const handleCtrlKeyCombinations = useCallback(
    (key: KeyObject, inputChar: string): boolean => {
      if (
        matchKeyboardChord({ key, input: inputChar }, 'ctrl-r') &&
        onQueuedMessagesReviewShortcut &&
        !showSuggestions &&
        !showCommands
      ) {
        onQueuedMessagesReviewShortcut();
        return true;
      }

      if (
        matchKeyboardChord({ key, input: inputChar }, 'ctrl-g') &&
        onPullQueuedMessageShortcut &&
        !showSuggestions &&
        !showCommands
      ) {
        onPullQueuedMessageShortcut();
        return true;
      }

      if (
        matchKeyboardChord({ key, input: inputChar }, 'ctrl-p') &&
        !showSuggestions &&
        !showCommands
      ) {
        void openInputInEditor();
        return true;
      }

      if (key.ctrl) {
        // Ctrl+W - delete word before cursor (standard terminal binding)
        // Handle both 'w' (from Ink) and '\x17' (control character from KeypressProvider)
        if (inputChar === 'w' || inputChar === 'W' || inputChar === '\x17') {
          deleteWordBeforeCursor();
          return true;
        }

        // Ctrl+A - move to line start
        // Handle both 'a' (from Ink) and '\x01' (control character from KeypressProvider)
        if (inputChar === 'a' || inputChar === 'A' || inputChar === '\x01') {
          jumpToLineStart();
          return true;
        }

        // Ctrl+E - move to line end
        // Handle both 'e' (from Ink) and '\x05' (control character from KeypressProvider)
        if (inputChar === 'e' || inputChar === 'E' || inputChar === '\x05') {
          jumpToLineEnd();
          return true;
        }

        // Ctrl+U - delete whole line (standard terminal binding, often triggered by Cmd+Delete)
        // Handle both 'u' (from Ink) and '\x15' (control character from KeypressProvider)
        if (inputChar === 'u' || inputChar === 'U' || inputChar === '\x15') {
          deleteCurrentLine();
          return true;
        }

        // Ctrl+K - delete from cursor to end of line (standard terminal binding)
        // Handle both 'k' (from Ink) and '\x0b' (control character from KeypressProvider)
        if (inputChar === 'k' || inputChar === 'K' || inputChar === '\x0b') {
          deleteToEndOfLine();
          return true;
        }

        // Ctrl+C is now handled at the app level for exit
        // Don't intercept it here to avoid conflicts
        if (inputChar === 'c' || inputChar === 'C') {
          return false; // Let it bubble up to the app-level handler
        }

        // Ctrl+V - paste from clipboard
        // Note: Ctrl+V might come as '\x16' (SYN character) on some Windows terminals
        if (inputChar === 'v' || inputChar === 'V' || inputChar === '\x16') {
          void pasteFromClipboardWithImageFallback();
          return true;
        }

        // Ctrl+F - move cursor forward one character
        if (inputChar === 'f' || inputChar === 'F' || inputChar === '\x06') {
          const currentCursorPos = cursorPositionRef.current;
          const currentInput = inputRef.current;
          if (currentCursorPos < currentInput.length) {
            const newPos = currentCursorPos + 1;
            cursorPositionRef.current = newPos;
            setCursorPosition(newPos);
            void updateSuggestions(currentInput, newPos);
          }
          return true;
        }

        // Ctrl+B - move cursor backward one character
        if (inputChar === 'b' || inputChar === 'B' || inputChar === '\x02') {
          const currentCursorPos = cursorPositionRef.current;
          const currentInput = inputRef.current;
          if (currentCursorPos > 0) {
            const newPos = currentCursorPos - 1;
            cursorPositionRef.current = newPos;
            setCursorPosition(newPos);
            void updateSuggestions(currentInput, newPos);
          }
          return true;
        }

        // Ctrl+D - clear all attached images, or forward delete if no images
        // Handle both 'd' (from Ink) and '\x04' (control character from KeypressProvider)
        if (inputChar === 'd' || inputChar === 'D' || inputChar === '\x04') {
          if (clearImages && attachedImages && attachedImages.length > 0) {
            void (async () => {
              await clearImages();
            })();
            return true;
          }
          deleteCharAfterCursor();
          return true;
        }

        // Ctrl+H - backspace (delete character before cursor)
        if (inputChar === 'h' || inputChar === 'H' || inputChar === '\x08') {
          deleteCharBeforeCursor();
          return true;
        }

        // Ctrl+N - cycle through available models
        if (matchKeyboardChord({ key, input: inputChar }, 'model-cycle')) {
          if (onModelCycle && !showSuggestions && !showCommands) {
            onModelCycle();
            return true;
          }
        }

        // Ctrl+L - cycle autonomy level
        if (matchKeyboardChord({ key, input: inputChar }, 'autonomy-cycle')) {
          if (onAutonomyLevelCycle && !showSuggestions && !showCommands) {
            onAutonomyLevelCycle();
            return true;
          }
        }

        // Ctrl+/ - toggle help menu (works even when input is non-empty)
        // Ctrl+/ sends \x1f (unit separator) in most terminals
        if (inputChar === '\x1f') {
          if (setShowHelpHints) {
            setShowHelpHints(!showHelpHints);
          }
          return true;
        }
      }
      return false;
    },
    [
      onModeToggle,
      openInputInEditor,
      showSuggestions,
      showCommands,
      deleteWordBeforeCursor,
      jumpToLineStart,
      jumpToLineEnd,
      deleteCurrentLine,
      deleteToEndOfLine,
      pasteFromClipboardWithImageFallback,
      clearImages,
      attachedImages,
      onQueuedMessagesReviewShortcut,
      onPullQueuedMessageShortcut,
      onModelCycle,
      onAutonomyLevelCycle,
      setCursorPosition,
      updateSuggestions,
      deleteCharAfterCursor,
      deleteCharBeforeCursor,
      showHelpHints,
      setShowHelpHints,
    ]
  );

  /**
   * Handle regular character input
   */
  const handleRegularCharacterInput = useCallback(
    (inputChar: string, key: KeyObject): void => {
      // Accept single characters (length 1) and surrogate pairs (length 2, for rare CJK Extension B chars)
      if (
        inputChar &&
        (inputChar.length === 1 ||
          (inputChar.length === 2 &&
            inputChar.charCodeAt(0) >= 0xd800 &&
            inputChar.charCodeAt(0) <= 0xdbff)) &&
        !key.ctrl &&
        !key.meta
      ) {
        // Special handling for '?' key when input is empty
        if (inputChar === '?' && inputRef.current.length === 0) {
          // Toggle help hints without adding '?' to input
          if (setShowHelpHints) {
            setShowHelpHints(!showHelpHints);
          }
          return;
        }

        // Special handling for '!' key when input is empty to toggle bash mode
        if (inputChar === '!' && inputRef.current.length === 0) {
          // Toggle bash mode without adding '!' to input
          if (onToggleBashMode) {
            onToggleBashMode();
          }
          return;
        }

        const charCode = inputChar.charCodeAt(0);
        // Allow printable characters (including backslash) except DEL
        // CJK characters and surrogate pairs always have charCode >= 32
        if (charCode >= CHAR_CODES.MIN_PRINTABLE && charCode !== 127) {
          // Get current values from refs to ensure we have the latest state
          const currentInput = inputRef.current;
          const currentCursorPos = cursorPositionRef.current;

          const before = currentInput.substring(0, currentCursorPos);
          const after = currentInput.substring(currentCursorPos);
          const newInput = before + inputChar + after;
          const newCursorPos = currentCursorPos + inputChar.length;

          // Update refs immediately
          inputRef.current = newInput;
          cursorPositionRef.current = newCursorPos;

          // Update React state
          setInput(newInput);
          setCursorPosition(newCursorPos);

          // Reset history position when user types
          if (historyService) {
            historyService.resetPosition();
          }

          // Update suggestions after character input
          void updateSuggestions(newInput, newCursorPos);
        }
      }
    },
    [
      setInput,
      setCursorPosition,
      updateSuggestions,
      showHelpHints,
      setShowHelpHints,
      historyService,
      onToggleBashMode,
    ]
  );

  // Main keyboard input handler
  const handleKeyboardInput = useCallback(
    (inputChar: string, key: unknown): boolean => {
      // Only process input if this component is focused
      if (!isFocused) {
        return false;
      }

      const keyObj = key as KeyObject;
      // Prefer raw escape sequence when present (from KeypressProvider)
      // This enables detection of Option+Arrow and other CSI/u sequences
      let effectiveInput = inputChar;
      if (
        (!effectiveInput || effectiveInput.length === 0) &&
        keyObj?.sequence
      ) {
        effectiveInput = keyObj.sequence;
      }

      // Transcript scroll shortcuts (Alt+Up/Down/PgUp/PgDn) are handled by a
      // global keypress subscriber at the app level. Ignore them here so they
      // do not accidentally trigger prompt-history navigation (Up/Down) or
      // other text-input behavior in the chat input.
      if (
        matchKeyboardChord(
          { key: keyObj, input: effectiveInput },
          'transcript-scroll-any'
        )
      ) {
        return false;
      }

      if (handlePendingEditorConfirmation(effectiveInput, keyObj)) {
        return true;
      }

      // Alt+Shift+V - expand the truncated [preview... N lines] paste
      // placeholders currently in the input back into their full content,
      // so users can inspect/edit pasted text without leaving the CLI.
      if (
        matchKeyboardChord(
          { key: keyObj, input: effectiveInput },
          'paste-expansion'
        )
      ) {
        if (expandPastedBlocksInline()) {
          return true;
        }
      }

      const isEscapeSequenceInput =
        keyObj.escape ||
        effectiveInput === ANSI.ESC ||
        effectiveInput === ANSI.ESC_KITTY ||
        effectiveInput === '[27u';

      if (repeatedKeySequenceRef.current && !isEscapeSequenceInput) {
        resetRepeatedKeySequence();
      }

      // Dedupe handled centrally in KeypressProvider

      // Handle raw newline
      if (effectiveInput === ANSI.NEWLINE) {
        insertTextAtCursor('\n');
        return true;
      }

      // Skip bracketed paste detection if using KeypressProvider
      // The provider handles this at a lower level for better reliability

      // Check for multi-character input (direct paste on Windows)
      // This happens with right-click paste or some terminal paste methods
      // This MUST come after bracketed paste handling
      // Don't treat backslash combinations as paste (Shift+Enter on some terminals)
      // Don't treat escape sequences starting with [ as paste content
      if (
        effectiveInput.length > 1 &&
        !effectiveInput.includes('\x1b') &&
        !effectiveInput.includes('[200~') &&
        !effectiveInput.includes('[201~') &&
        !effectiveInput.startsWith('[') &&
        !(effectiveInput.length === 2 && effectiveInput[0] === '\\') // Exclude \\r, \\n, etc.
      ) {
        // Check if this looks like an image file path (drag-and-drop fallback)
        if (looksLikeImageFilePath(effectiveInput)) {
          void (async () => {
            if (handleImageFilePathPaste) {
              const handled = await handleImageFilePathPaste(effectiveInput);
              if (handled) {
                return; // Image was loaded successfully
              }
            }
            // Failed to load as image, insert as text
            insertTextAtCursor(effectiveInput);
          })();
          return true;
        }

        // Regular multi-character input
        insertTextAtCursor(effectiveInput);
        return true;
      }

      // ===== SUGGESTIONS AND COMMANDS NAVIGATION =====
      if (handleSuggestionsNavigation(inputChar, keyObj)) {
        return true;
      }

      if (handleCommandsNavigation(inputChar, keyObj)) {
        return true;
      }

      // ===== CURSOR NAVIGATION =====
      // Left/right arrow navigation should work even when suggestions are visible
      // to allow cursor movement within the input text (e.g., editing @path queries)
      // Only up/down arrows are blocked here since they navigate the suggestion list
      if (!showSuggestions && !showCommands) {
        // Handle ANSI escape sequences for special key combinations
        if (handleAnsiEscapeSequences(effectiveInput)) {
          return true;
        }

        // Handle meta/command key combinations
        if (handleMetaKeyCombinations(inputChar, keyObj)) {
          return true;
        }

        // Handle basic arrow key navigation (all directions)
        if (handleArrowKeyNavigation(keyObj)) {
          return true;
        }
      } else if (keyObj.leftArrow || keyObj.rightArrow) {
        // When suggestions/commands are visible, still allow left/right arrow navigation
        // for cursor movement within the input text
        if (handleArrowKeyNavigation(keyObj)) {
          return true;
        }
      }

      // ===== TEXT EDITING =====

      // Handle Enter key
      if (handleEnterKey(keyObj)) {
        return true;
      }

      // Handle backspace and delete
      if (handleBackspaceAndDelete(keyObj, effectiveInput)) {
        return true;
      }

      // Handle ESC key
      const didHandleEscape = handleEscapeKey(keyObj);
      if (didHandleEscape) {
        return true;
      }
      if (isEscapeSequenceInput) {
        return false;
      }

      // Handle Tab key (including Shift+Tab for mode toggle)
      if (handleTabKey(keyObj)) {
        return true;
      }

      // Handle Shift+Enter detected as special character
      if (handleShiftEnter(inputChar)) {
        return true;
      }

      // ===== ESCAPE SEQUENCES =====

      // Handle escape sequences for Option key combinations
      if (handleEscapeSequences(effectiveInput)) {
        return true;
      }

      // Check for ESC key to start escape sequence
      const didScheduleEscape = handleEscapeStart(effectiveInput);
      if (didScheduleEscape) {
        return false;
      }

      // Handle alternative Option key detection for different terminals
      if (handleAlternativeOptionKeys(effectiveInput)) {
        return true;
      }

      // Handle macOS Terminal Option text aliases in the chat input only.
      if (handleMacosTerminalOptionTextAliases(effectiveInput, keyObj)) {
        return true;
      }

      // Handle Ctrl key combinations
      if (handleCtrlKeyCombinations(keyObj, effectiveInput)) {
        return true;
      }
      if (
        keyObj.ctrl &&
        (effectiveInput === 'c' ||
          effectiveInput === 'C' ||
          effectiveInput === '\x03')
      ) {
        return false;
      }

      // ===== REGULAR CHARACTER INPUT =====
      handleRegularCharacterInput(effectiveInput, keyObj);
      return true;
    },
    [
      isFocused,
      input,
      cursorPosition,
      showSuggestions,
      showCommands,
      suggestions,
      selectedSuggestionIndex,
      waitingForEscapeChar,
      resetRepeatedKeySequence,
      handleSuggestionsNavigation,
      handleCommandsNavigation,
      handleAnsiEscapeSequences,
      handleMetaKeyCombinations,
      handleArrowKeyNavigation,
      handleEnterKey,
      handleBackspaceAndDelete,
      handleEscapeKey,
      handleTabKey,
      handleShiftEnter,
      handleEscapeSequences,
      handleEscapeStart,
      handleAlternativeOptionKeys,
      handleMacosTerminalOptionTextAliases,
      handleCtrlKeyCombinations,
      handlePendingEditorConfirmation,
      expandPastedBlocksInline,
      handleRegularCharacterInput,
      attachedImages, // Added to track when images are attached
    ]
  );

  // Keep latest handlers/helpers in refs without effects (render-time assignment)
  keyHandlerRef.current = handleKeyboardInput;
  insertTextAtCursorRef.current = insertTextAtCursor;

  // Provide a stable input-layer handler to the KeypressProvider.
  const providerEventHandler = useCallback(
    (event: KeyEvent): boolean => {
      const handlerStartedAtMs = performance.now();
      const inputKind = classifyKeyEvent(event);
      pendingCommitMetricRef.current = {
        startedAtMs: handlerStartedAtMs,
        inputKind,
      };
      if (pendingCommitClearTimerRef.current) {
        clearTimeout(pendingCommitClearTimerRef.current);
      }
      pendingCommitClearTimerRef.current = setTimeout(() => {
        pendingCommitMetricRef.current = undefined;
        pendingCommitClearTimerRef.current = undefined;
      }, 250);
      pendingCommitClearTimerRef.current.unref?.();
      const recordHandlerLatency = () => {
        recordInputLatency(
          Metric.CLI_TUI_INPUT_HANDLER_LATENCY,
          performance.now() - handlerStartedAtMs,
          { inputKind }
        );
      };

      if (event.isPaste) {
        try {
          // Normalize all newline variations and escape special sequences
          const pastedContent = event.input
            .replace(/\r\n/g, '\n') // Windows CRLF
            .replace(/\r/g, '\n') // Old Mac CR
            .replace(/\u2028/g, '\n') // Line separator
            .replace(/\u2029/g, '\n') // Paragraph separator
            .replace(/\v/g, '\n') // Vertical tab (\x0b)
            .replace(/\f/g, '\n') // Form feed (\x0c)
            .trim();
          // If user pasted with Cmd+V (or equivalent) and the terminal sent no text
          // (common when the clipboard holds an image), attempt image paste.
          if (!pastedContent || pastedContent.length === 0) {
            void (async () => {
              await tryPasteImageFromClipboard();
              // No textual content to insert; nothing else to do.
            })();
            return true;
          }
          // Check if the pasted content looks like an image file path (drag-and-drop)
          if (looksLikeImageFilePath(pastedContent)) {
            // Don't insert text yet - try to load as image first
            void (async () => {
              if (handleImageFilePathPaste) {
                const handled = await handleImageFilePathPaste(pastedContent);
                if (handled) {
                  return; // Image was loaded successfully
                }
              }
              // Failed to load as image, insert as text instead
              insertTextAtCursorRef.current?.(pastedContent, true);
            })();
            return true;
          }

          // Regular text paste
          if (pastedContent.length > 0) {
            insertTextAtCursorRef.current?.(pastedContent, true);
          }
          return true;
        } finally {
          recordHandlerLatency();
        }
      }
      try {
        return keyHandlerRef.current?.(event.input, event.key) === true;
      } finally {
        recordHandlerLatency();
      }
    },
    [handleImageFilePathPaste, tryPasteImageFromClipboard]
  );

  // Manage input-layer registration with proper cleanup.
  useLayoutEffect(() => {
    if (!keypressProvider) return undefined;

    if (isFocused) {
      keypressProvider.subscribe(providerEventHandler, {
        layer: KeypressLayer.Input,
      });
      return () => {
        keypressProvider.unsubscribe(providerEventHandler);
      };
    }

    return undefined;
  }, [keypressProvider, isFocused, providerEventHandler]);

  // Return the input state and setters for the component to use
  return {
    input,
    cursorPosition,
    layout,
    setInput,
    setCursorPosition,
    isAwaitingEditorConfirm: pendingEditorState !== null,
    isOpeningEditor,
    editorGuidance,
  };
}
