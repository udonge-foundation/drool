import {
  QueuedUserMessageKind,
  isDaemonQueuedMessageKind,
  type QueuedUserMessageState,
} from '@industry/daemon-client';
import { QueuePlacement } from '@industry/drool-sdk-ext/protocol/drool';

export function shouldRestoreLocalPausedQueuedHeadAfterInterrupt(
  queuedMessages: Pick<QueuedUserMessageState, 'kind'>[]
): boolean {
  return (
    queuedMessages.some(
      (message) => message.kind === QueuedUserMessageKind.LocalPausedAfterEsc
    ) &&
    !queuedMessages.some((message) => isDaemonQueuedMessageKind(message.kind))
  );
}

export function shouldQueueBehindLocalPausedMessages({
  hasLocalPausedMessages,
  isSlashCommand,
  isRestoredQueuedHeadSubmission,
  isAgentRunning,
  isCancelling,
  queuePlacement,
}: {
  hasLocalPausedMessages: boolean;
  isSlashCommand: boolean;
  isRestoredQueuedHeadSubmission: boolean;
  isAgentRunning: boolean;
  isCancelling: boolean;
  queuePlacement: QueuePlacement;
}): boolean {
  return (
    hasLocalPausedMessages &&
    queuePlacement === QueuePlacement.EndOfLoop &&
    !isSlashCommand &&
    !isRestoredQueuedHeadSubmission &&
    (isAgentRunning || isCancelling)
  );
}

export function shouldArmLocalPausedAutoDrain({
  isRestoredQueuedHeadSubmission,
  hasLocalPausedMessages,
}: {
  isRestoredQueuedHeadSubmission: boolean;
  hasLocalPausedMessages: boolean;
}): boolean {
  return isRestoredQueuedHeadSubmission && hasLocalPausedMessages;
}

export function shouldAutoDrainLocalPausedMessage({
  isAutoDrainArmed,
  isSessionIdle,
  isCancelling,
  hasLocalDeferredMessages,
  hasLocalPausedMessages,
  hasDraftText,
  isQueuedReviewActive,
  isDrainInFlight,
  isAwaitingQueuedTurn,
}: {
  isAutoDrainArmed: boolean;
  isSessionIdle: boolean;
  isCancelling: boolean;
  hasLocalDeferredMessages: boolean;
  hasLocalPausedMessages: boolean;
  hasDraftText: boolean;
  isQueuedReviewActive: boolean;
  isDrainInFlight: boolean;
  isAwaitingQueuedTurn: boolean;
}): boolean {
  return (
    isAutoDrainArmed &&
    isSessionIdle &&
    !isCancelling &&
    !hasLocalDeferredMessages &&
    hasLocalPausedMessages &&
    !hasDraftText &&
    !isQueuedReviewActive &&
    !isDrainInFlight &&
    !isAwaitingQueuedTurn
  );
}
