import { QueuePlacement } from '@industry/drool-sdk-ext/protocol/drool';

import { QueuedUserMessageDisplayGroup, QueuedUserMessageKind } from './enums';

interface QueuedUserMessageKindMetadata {
  daemonBacked?: boolean;
  reviewable?: boolean;
  displayGroup: QueuedUserMessageDisplayGroup;
  reviewPriority?: number;
}

const QUEUED_MESSAGE_KIND_METADATA: Record<
  QueuedUserMessageKind,
  QueuedUserMessageKindMetadata
> = {
  [QueuedUserMessageKind.LocalDeferredAfterEsc]: {
    displayGroup: QueuedUserMessageDisplayGroup.Steering,
  },
  [QueuedUserMessageKind.LocalPausedAfterEsc]: {
    reviewable: true,
    displayGroup: QueuedUserMessageDisplayGroup.Queued,
    reviewPriority: 1,
  },
  [QueuedUserMessageKind.DaemonQueuedDiscardable]: {
    daemonBacked: true,
    reviewable: true,
    displayGroup: QueuedUserMessageDisplayGroup.Steering,
    reviewPriority: 0,
  },
  [QueuedUserMessageKind.DaemonQueuedEndOfLoop]: {
    daemonBacked: true,
    reviewable: true,
    displayGroup: QueuedUserMessageDisplayGroup.Queued,
    reviewPriority: 1,
  },
  [QueuedUserMessageKind.LocalDeferredDuringManualCompaction]: {
    displayGroup: QueuedUserMessageDisplayGroup.Queued,
  },
};

export function isDaemonQueuedMessageKind(
  kind: QueuedUserMessageKind
): boolean {
  return QUEUED_MESSAGE_KIND_METADATA[kind].daemonBacked === true;
}

export function isReviewableQueuedMessageKind(
  kind: QueuedUserMessageKind
): boolean {
  return QUEUED_MESSAGE_KIND_METADATA[kind].reviewable === true;
}

export function getQueuedUserMessageDisplayGroup(
  kind: QueuedUserMessageKind
): QueuedUserMessageDisplayGroup {
  return QUEUED_MESSAGE_KIND_METADATA[kind].displayGroup;
}

export function getQueuedUserMessageReviewPriority(
  kind: QueuedUserMessageKind
): number | null {
  return QUEUED_MESSAGE_KIND_METADATA[kind].reviewPriority ?? null;
}

export function getQueuedUserMessageKindForQueuePlacement(
  queuePlacement?: QueuePlacement
): QueuedUserMessageKind {
  return queuePlacement === QueuePlacement.EndOfLoop
    ? QueuedUserMessageKind.DaemonQueuedEndOfLoop
    : QueuedUserMessageKind.DaemonQueuedDiscardable;
}
