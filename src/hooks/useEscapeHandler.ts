import { useContext, useEffect } from 'react';

import { KeypressLayer } from '@/contexts/enums';
import { KeypressContext } from '@/contexts/KeypressProvider';
import type { KeyEvent, KeypressContextValue } from '@/contexts/types';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';

interface UseEscapeHandlerOptions {
  isActive?: boolean;
}

/**
 * Reusable hook that handles ESC key via KeypressProvider.
 * Works even when TextInput has focus, because it intercepts at the raw stdin level.
 *
 * This solves the problem where ink-text-input's TextInput component captures ESC
 * internally and doesn't propagate it to parent useInput handlers.
 *
 * @param onEscape - Callback to invoke when ESC is pressed
 * @param options - Optional configuration
 * @param options.isActive - Whether the handler is active (default: true)
 */
export function useEscapeHandler(
  onEscape: () => void,
  options: UseEscapeHandlerOptions = {}
): void {
  const { isActive = true } = options;

  // Use useContext directly so we can handle undefined gracefully
  // (when not wrapped in KeypressProvider, e.g., during tests without full context)
  const keypressProvider = useContext(KeypressContext) as
    | KeypressContextValue
    | undefined;

  useEffect(() => {
    if (!keypressProvider || !isActive) return;

    const handler = (event: KeyEvent) => {
      if (matchKeyboardChord(event, 'escape')) {
        onEscape();
        return true;
      }
      return false;
    };

    keypressProvider.subscribe(handler, { layer: KeypressLayer.Overlay });
    return () => {
      keypressProvider.unsubscribe(handler);
    };
  }, [keypressProvider, onEscape, isActive]);
}
