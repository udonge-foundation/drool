import { useCallback, useContext, useLayoutEffect, useRef } from 'react';

import { KeypressLayer } from '@/contexts/enums';
import { KeypressContext } from '@/contexts/KeypressProvider';
import type {
  KeyEvent,
  KeypressContextValue,
  KeypressHandlerResult,
} from '@/contexts/types';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';

type InputHandler = (
  input: string,
  key: KeyEvent['key']
) => KeypressHandlerResult | Promise<KeypressHandlerResult>;

interface UseKeypressHandlerOptions {
  isActive?: boolean;
  layer?: KeypressLayer;
  isPrimary?: boolean;
}

/**
 * Drop-in replacement for Ink's useInput that routes through KeypressProvider.
 *
 * useInput reads stdin directly, which conflicts with KeypressProvider's
 * stdin.on('data') listener -- both compete for the same stream, causing
 * data loss. This hook uses KeypressProvider's subscribe/unsubscribe instead,
 * keeping a single stdin consumer.
 *
 * The callback signature matches useInput: (input: string, key: Key) => void.
 */
export function useKeypressHandler(
  handler: InputHandler,
  options: UseKeypressHandlerOptions = {}
): void {
  const {
    isActive = true,
    layer = KeypressLayer.Input,
    isPrimary = false,
  } = options;

  const keypressProvider = useContext(KeypressContext) as
    | KeypressContextValue
    | undefined;

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const stableHandler = useCallback((event: KeyEvent) => {
    if (!event.isPaste) {
      const normalizedKey = matchKeyboardChord(event, 'escape')
        ? { ...(event.key ?? {}), escape: true }
        : event.key;
      const result = handlerRef.current(event.input, normalizedKey);
      return result instanceof Promise ? true : result;
    }
    return false;
  }, []);

  useLayoutEffect(() => {
    if (!keypressProvider || !isActive) return undefined;

    keypressProvider.subscribe(stableHandler, { layer });
    if (isPrimary) {
      keypressProvider.handlerRef.current = stableHandler;
    }

    return () => {
      keypressProvider.unsubscribe(stableHandler);
      if (isPrimary && keypressProvider.handlerRef.current === stableHandler) {
        keypressProvider.handlerRef.current = undefined;
      }
    };
  }, [keypressProvider, isActive, layer, isPrimary, stableHandler]);
}
