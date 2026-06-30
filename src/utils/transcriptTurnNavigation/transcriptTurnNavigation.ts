import { MessageRole } from '@/hooks/enums';
import type { HistoryMessage } from '@/hooks/types';
import { DEFAULT_TRANSCRIPT_ANCHOR_SLICE_SIZE } from '@/utils/transcriptTurnNavigation/constants';
import { TranscriptAnchorMode } from '@/utils/transcriptTurnNavigation/enums';
import type {
  TranscriptAnchor,
  TranscriptItem,
} from '@/utils/transcriptTurnNavigation/types';

function isHistoryMessage(item: TranscriptItem): item is HistoryMessage {
  return 'role' in item;
}

function anchorRole(
  item: TranscriptItem
): MessageRole.User | MessageRole.Assistant | null {
  if (!isHistoryMessage(item)) return null;
  if (item.role === MessageRole.User) return MessageRole.User;
  if (item.role === MessageRole.Assistant) return MessageRole.Assistant;
  return null;
}

/**
 * Build the list of navigable turn anchors. "User turn" = any HistoryMessage
 * with role=user. "Any turn" = user or assistant messages. Tool executions and
 * system messages are not navigation stops but are still rendered in the
 * resulting slice.
 */
export function buildTurnAnchors(
  items: readonly TranscriptItem[],
  options: { mode: TranscriptAnchorMode }
): TranscriptAnchor[] {
  const anchors: TranscriptAnchor[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;
    const role = anchorRole(item);
    if (role === null) continue;
    if (
      options.mode === TranscriptAnchorMode.UserOnly &&
      role !== MessageRole.User
    ) {
      continue;
    }
    anchors.push({ index, role });
  }
  return anchors;
}

/**
 * Return the previous anchor strictly before `currentIndex`, or null if none.
 * When `currentIndex` is -1 (i.e. "no anchor selected yet"), this returns the
 * last anchor in the list (i.e. anchors the viewport at the newest turn).
 */
export function resolvePreviousAnchor(
  anchors: readonly TranscriptAnchor[],
  currentIndex: number
): TranscriptAnchor | null {
  if (anchors.length === 0) return null;

  if (currentIndex < 0) {
    return anchors[anchors.length - 1] ?? null;
  }

  for (let i = anchors.length - 1; i >= 0; i--) {
    const anchor = anchors[i];
    if (anchor && anchor.index < currentIndex) {
      return anchor;
    }
  }
  return null;
}

/**
 * Return the next anchor strictly after `currentIndex`. When `currentIndex`
 * has no later anchor, return null so the caller can exit scroll mode and
 * resume live chat.
 */
export function resolveNextAnchor(
  anchors: readonly TranscriptAnchor[],
  currentIndex: number
): TranscriptAnchor | null {
  if (anchors.length === 0) return null;

  if (currentIndex < 0) {
    return null;
  }

  for (const anchor of anchors) {
    if (anchor.index > currentIndex) {
      return anchor;
    }
  }
  return null;
}

/**
 * Return a bounded slice of items ending at (and including) the anchor index.
 * Showing the anchor near the bottom of the slice keeps the selected turn
 * adjacent to the input area, mimicking how a live chat stream scrolls.
 */
export function sliceAroundAnchor(
  items: readonly TranscriptItem[],
  anchorIndex: number,
  maxCount: number = DEFAULT_TRANSCRIPT_ANCHOR_SLICE_SIZE
): { items: TranscriptItem[]; startIndex: number; endIndex: number } {
  if (anchorIndex < 0 || anchorIndex >= items.length) {
    return { items: [], startIndex: -1, endIndex: -1 };
  }

  const safeCount = Math.max(1, Math.floor(maxCount));
  const endIndex = anchorIndex;
  const startIndex = Math.max(0, endIndex - safeCount + 1);

  return {
    items: items.slice(startIndex, endIndex + 1),
    startIndex,
    endIndex,
  };
}
