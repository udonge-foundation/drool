/**
 * KeypressProvider-compatible TextInput component.
 *
 * Drop-in replacement for ink-text-input that receives input through
 * KeypressProvider's subscribe/unsubscribe pattern instead of Ink's useInput.
 * This eliminates the stdin conflict where KeypressProvider (flowing mode) and
 * ink-text-input's useInput (paused mode) compete for the same data.
 *
 * Uses the subscriber path (not handlerRef) so it cooperates with the chat
 * input and other KeypressProvider consumers like useEscapeHandler.
 */

import chalk from 'chalk';
import { Text } from 'ink';
import {
  useState,
  useLayoutEffect,
  useCallback,
  useContext,
  useRef,
} from 'react';

import type { TextInputProps } from '@/components/types';
import { KeypressLayer } from '@/contexts/enums';
import { KeypressContext } from '@/contexts/KeypressProvider';
import type { KeyEvent, KeypressContextValue } from '@/contexts/types';
import {
  deleteWordBeforeCursor,
  deleteWordAfterCursor,
  deleteToLineStart,
  deleteToLineEnd,
  findPreviousWordBoundary,
  findNextWordBoundary,
  filterInputChars,
  filterControlChars,
  normalizePasteText,
} from '@/utils/textEditing';

// Home/End ANSI sequences
const HOME_SEQ = '\x1b[H';
const END_SEQ = '\x1b[F';

export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  focus = true,
  showCursor = true,
  mask,
  shouldIgnoreInput,
}: TextInputProps) {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Refs to avoid stale closures in the subscription handler
  const cursorOffsetRef = useRef(cursorOffset);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const shouldIgnoreInputRef = useRef(shouldIgnoreInput);

  const clampedCursor = Math.min(cursorOffset, value.length);
  if (clampedCursor !== cursorOffset) {
    setCursorOffset(clampedCursor);
  }

  cursorOffsetRef.current = clampedCursor;
  valueRef.current = value;
  onChangeRef.current = onChange;
  onSubmitRef.current = onSubmit;
  shouldIgnoreInputRef.current = shouldIgnoreInput;

  const keypressProvider = useContext(KeypressContext) as
    | KeypressContextValue
    | undefined;

  const applyEdit = useCallback(
    (result: { value: string; cursorOffset: number }) => {
      // Update valueRef immediately so subsequent keypress events in the same
      // synchronous batch (e.g. when terminal.write('stripe') delivers all 6
      // chars before React re-renders) see the latest value.
      valueRef.current = result.value;
      cursorOffsetRef.current = result.cursorOffset;
      onChangeRef.current(result.value);
      setCursorOffset(result.cursorOffset);
    },
    []
  );

  const moveCursor = useCallback((newOffset: number) => {
    setCursorOffset(newOffset);
    cursorOffsetRef.current = newOffset;
  }, []);

  const handleKeyEvent = useCallback(
    (event: KeyEvent): boolean => {
      const currentValue = valueRef.current;
      const cursor = cursorOffsetRef.current;
      const { key, input, isPaste } = event;

      // --- Paste ---
      if (isPaste) {
        const cleaned = filterControlChars(normalizePasteText(input));
        if (!cleaned) return false;
        applyEdit({
          value:
            currentValue.slice(0, cursor) +
            cleaned +
            currentValue.slice(cursor),
          cursorOffset: cursor + cleaned.length,
        });
        return true;
      }

      // --- Keys to ignore (parent handles) ---
      if (key.upArrow || key.downArrow) return false;
      if (key.tab) return false;
      if (key.escape) return false;

      // --- Enter ---
      if (key.return) {
        const submitHandler = onSubmitRef.current;
        if (!submitHandler) return false;
        submitHandler(currentValue);
        return true;
      }

      // --- Ctrl combos ---
      if (key.ctrl) {
        if (input === '\x03') return false;
        if (input === '\x17') {
          applyEdit(deleteWordBeforeCursor(currentValue, cursor));
          return true;
        }
        if (input === '\x15') {
          applyEdit(deleteToLineStart(currentValue, cursor));
          return true;
        }
        if (input === '\x0b') {
          applyEdit(deleteToLineEnd(currentValue, cursor));
          return true;
        }
        if (input === '\x01') {
          moveCursor(0);
          return true;
        }
        if (input === '\x05') {
          moveCursor(currentValue.length);
          return true;
        }
        // Ctrl+F - forward one character
        if (input === '\x06') {
          if (showCursor && cursor < currentValue.length)
            moveCursor(cursor + 1);
          return true;
        }
        // Ctrl+B - backward one character
        if (input === '\x02') {
          if (showCursor && cursor > 0) moveCursor(cursor - 1);
          return true;
        }
        // Ctrl+D - forward delete
        if (input === '\x04') {
          if (cursor < currentValue.length) {
            applyEdit({
              value:
                currentValue.slice(0, cursor) + currentValue.slice(cursor + 1),
              cursorOffset: cursor,
            });
          }
          return true;
        }
        // Ctrl+H - backspace
        if (input === '\x08') {
          if (cursor > 0) {
            applyEdit({
              value:
                currentValue.slice(0, cursor - 1) + currentValue.slice(cursor),
              cursorOffset: cursor - 1,
            });
          }
          return true;
        }
        if (key.leftArrow) {
          moveCursor(findPreviousWordBoundary(currentValue, cursor));
          return true;
        }
        if (key.rightArrow) {
          moveCursor(findNextWordBoundary(currentValue, cursor));
          return true;
        }
        if (key.backspace) {
          applyEdit(deleteWordBeforeCursor(currentValue, cursor));
          return true;
        }
        if (key.delete) {
          applyEdit(deleteWordAfterCursor(currentValue, cursor));
          return true;
        }
        return false;
      }

      // --- Meta/Option combos ---
      if (key.meta) {
        if (key.backspace) {
          applyEdit(deleteWordBeforeCursor(currentValue, cursor));
          return true;
        }
        if (key.delete) {
          applyEdit(deleteWordAfterCursor(currentValue, cursor));
          return true;
        }
        if (key.leftArrow) {
          moveCursor(findPreviousWordBoundary(currentValue, cursor));
          return true;
        }
        if (key.rightArrow) {
          moveCursor(findNextWordBoundary(currentValue, cursor));
          return true;
        }
        return false;
      }

      // --- Home/End keys ---
      if (key.sequence === HOME_SEQ) {
        moveCursor(0);
        return true;
      }
      if (key.sequence === END_SEQ) {
        moveCursor(currentValue.length);
        return true;
      }

      // --- Arrow keys ---
      if (key.leftArrow) {
        if (showCursor && cursor > 0) moveCursor(cursor - 1);
        return true;
      }
      if (key.rightArrow) {
        if (showCursor && cursor < currentValue.length) moveCursor(cursor + 1);
        return true;
      }

      // --- Backspace ---
      if (key.backspace) {
        if (cursor > 0) {
          applyEdit({
            value:
              currentValue.slice(0, cursor - 1) + currentValue.slice(cursor),
            cursorOffset: cursor - 1,
          });
        }
        return true;
      }

      // --- Delete ---
      if (key.delete) {
        if (cursor < currentValue.length) {
          applyEdit({
            value:
              currentValue.slice(0, cursor) + currentValue.slice(cursor + 1),
            cursorOffset: cursor,
          });
        }
        return true;
      }

      // --- Regular character input ---
      if (input && input.length > 0) {
        if (shouldIgnoreInputRef.current?.(input, key)) {
          return true;
        }
        const filtered = filterInputChars(input);
        if (filtered.length > 0) {
          applyEdit({
            value:
              currentValue.slice(0, cursor) +
              filtered +
              currentValue.slice(cursor),
            cursorOffset: cursor + filtered.length,
          });
          return true;
        }
      }
      return false;
    },
    [applyEdit, moveCursor, showCursor]
  );

  // Stable reference that delegates to the latest handleKeyEvent
  const stableHandlerRef = useRef(handleKeyEvent);
  stableHandlerRef.current = handleKeyEvent;
  const stableHandler = useCallback(
    (event: KeyEvent) => stableHandlerRef.current(event),
    []
  );

  // Subscribe to KeypressProvider when focused
  useLayoutEffect(() => {
    if (!keypressProvider || !focus) return undefined;

    keypressProvider.subscribe(stableHandler, { layer: KeypressLayer.Input });
    return () => {
      keypressProvider.unsubscribe(stableHandler);
    };
  }, [keypressProvider, focus, stableHandler]);

  // --- Render ---
  const displayValue = mask ? mask.repeat(value.length) : value;

  let renderedValue = displayValue;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(' ');

    if (displayValue.length > 0) {
      renderedValue = '';
      for (let i = 0; i < displayValue.length; i++) {
        renderedValue +=
          i === clampedCursor
            ? chalk.inverse(displayValue[i])
            : displayValue[i];
      }
      if (clampedCursor === displayValue.length) {
        renderedValue += chalk.inverse(' ');
      }
    } else {
      renderedValue = chalk.inverse(' ');
    }
  }

  return (
    <Text>{displayValue.length > 0 ? renderedValue : renderedPlaceholder}</Text>
  );
}
