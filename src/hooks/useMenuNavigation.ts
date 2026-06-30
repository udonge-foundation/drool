import { useCallback, useEffect, useRef, useState } from 'react';

import { KeypressLayer } from '@/contexts/enums';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

interface UseMenuNavigationOptions<T> {
  items: T[];
  onSelect: (item: T, index: number) => void;
  onCancel: () => void;
  initialIndex?: number;
  isSelectable?: (item: T, index: number) => boolean;
  wrapAround?: boolean;
  additionalKeys?: {
    [key: string]: () => void;
  };
  isActive?: boolean;
  onIndexChange?: (newIndex: number, prevIndex: number) => void;
  enableCharKeys?: boolean;
}

interface UseMenuNavigationResult<T> {
  selectedIndex: number;
  selectedItem: T | null;
  setSelectedIndex: (index: number) => void;
}

export function useMenuNavigation<T>({
  items,
  onSelect,
  onCancel,
  initialIndex = 0,
  isSelectable,
  wrapAround = false,
  additionalKeys = {},
  isActive = true,
  onIndexChange,
  enableCharKeys = true,
}: UseMenuNavigationOptions<T>): UseMenuNavigationResult<T> {
  const getFirstSelectableIndex = useCallback(() => {
    for (let i = 0; i < items.length; i++) {
      if (!isSelectable || isSelectable(items[i], i)) {
        return i;
      }
    }
    return 0;
  }, [items, isSelectable]);

  const [selectedIndex, setSelectedIndex] = useState(() => {
    // Try to use initialIndex if valid and selectable
    if (initialIndex >= 0 && initialIndex < items.length) {
      if (!isSelectable || isSelectable(items[initialIndex], initialIndex)) {
        return initialIndex;
      }
    }
    return getFirstSelectableIndex();
  });

  // Track if user has manually navigated
  const hasUserNavigatedRef = useRef(false);
  // Track the previous items length to detect when new items load
  const prevItemsLengthRef = useRef(items.length);

  // Update selectedIndex when initialIndex changes (e.g., when custom models load)
  // but only if the user hasn't manually navigated yet
  useEffect(() => {
    // Detect if items changed (e.g., custom models loaded)
    const itemsChanged = prevItemsLengthRef.current !== items.length;
    prevItemsLengthRef.current = items.length;

    if (itemsChanged && selectedIndex >= items.length) {
      setSelectedIndex(Math.max(0, items.length - 1));
      return;
    }

    // Only auto-update if:
    // 1. Items changed (new data loaded)
    // 2. User hasn't manually navigated yet
    // 3. initialIndex is valid and different from current selection
    if (
      itemsChanged &&
      !hasUserNavigatedRef.current &&
      initialIndex >= 0 &&
      initialIndex < items.length &&
      initialIndex !== selectedIndex
    ) {
      if (!isSelectable || isSelectable(items[initialIndex], initialIndex)) {
        setSelectedIndex(initialIndex);
      }
    }
  }, [initialIndex, items.length, selectedIndex, items, isSelectable]);

  const findNextSelectableIndex = useCallback(
    (currentIndex: number, direction: 1 | -1): number => {
      const length = items.length;
      if (length === 0) return 0;

      let next = currentIndex + direction;
      let iterations = 0;

      while (iterations < length) {
        if (wrapAround) {
          if (next < 0) next = length - 1;
          if (next >= length) next = 0;
        } else {
          if (next < 0) return currentIndex;
          if (next >= length) return currentIndex;
        }

        if (!isSelectable || isSelectable(items[next], next)) {
          return next;
        }

        next += direction;
        iterations++;
      }

      return currentIndex;
    },
    [items, isSelectable, wrapAround]
  );

  useKeypressHandler(
    (input, key) => {
      if (key.escape || (enableCharKeys && input === 'q')) {
        onCancel();
        return true;
      }

      if (key.return) {
        const item = items[selectedIndex];
        if (item && (!isSelectable || isSelectable(item, selectedIndex))) {
          onSelect(item, selectedIndex);
          return true;
        }
        return false;
      }

      if (key.upArrow || (enableCharKeys && input === 'k')) {
        const next = findNextSelectableIndex(selectedIndex, -1);
        if (next === selectedIndex) {
          return false;
        }
        hasUserNavigatedRef.current = true;
        setSelectedIndex(next);
        onIndexChange?.(next, selectedIndex);
        return true;
      }

      if (key.downArrow || (enableCharKeys && input === 'j')) {
        const next = findNextSelectableIndex(selectedIndex, 1);
        if (next === selectedIndex) {
          return false;
        }
        hasUserNavigatedRef.current = true;
        setSelectedIndex(next);
        onIndexChange?.(next, selectedIndex);
        return true;
      }

      if (input in additionalKeys) {
        additionalKeys[input]();
        return true;
      }

      if (key.tab && additionalKeys.tab) {
        additionalKeys.tab();
        return true;
      }

      return false;
    },
    { isActive, layer: KeypressLayer.Navigation }
  );

  const setSelectedIndexWrapper = useCallback((index: number) => {
    hasUserNavigatedRef.current = true;
    setSelectedIndex(index);
  }, []);

  return {
    selectedIndex,
    selectedItem: items[selectedIndex] ?? null,
    setSelectedIndex: setSelectedIndexWrapper,
  };
}
