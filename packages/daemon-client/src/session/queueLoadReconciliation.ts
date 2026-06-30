import {
  QueuePlacement,
  type AddUserMessageParams as AddUserMessageRequestParams,
  type LoadSessionResult,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  MessageRole,
  DocumentSourceType,
  type Base64ImageSource,
  type ContentBlock,
  type DocumentSource,
  type IndustryDroolMessage,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logWarn } from '@industry/logging';
import { buildUserMessageContentBlocks } from '@industry/utils/messages';

import { QueuedUserMessageKind } from './state/enums';
import {
  getQueuedUserMessageKindForQueuePlacement,
  isDaemonQueuedMessageKind,
} from './state/queuedUserMessageHelpers';

import type { IDaemonClient } from '../types';
import type { SessionStateManager } from './state/SessionStateManager';
import type { QueuedUserMessageState } from './state/types';

function getSendableContentFromBlocks(content: ContentBlock[]): {
  text: string;
  images: Base64ImageSource[];
  files: DocumentSource[];
} {
  const images: Base64ImageSource[] = [];
  const files: DocumentSource[] = [];
  const textBlocks: string[] = [];

  for (const block of content) {
    if (block.type === MessageContentBlockType.Image) {
      images.push(block.source);
    } else if (block.type === MessageContentBlockType.Document) {
      files.push(block.source);
    } else if (block.type === MessageContentBlockType.Text) {
      textBlocks.push(block.text);
    }
  }

  return {
    text: textBlocks.join('\n').trim(),
    images,
    files,
  };
}

function getQueuePlacementForQueuedMessageKind(
  kind: QueuedUserMessageKind
): QueuePlacement {
  return kind === QueuedUserMessageKind.DaemonQueuedEndOfLoop
    ? QueuePlacement.EndOfLoop
    : QueuePlacement.EndOfTurn;
}

function documentSourcesMatch(left: DocumentSource, right: DocumentSource) {
  if (left.type !== right.type || left.mediaType !== right.mediaType) {
    return false;
  }

  if (
    left.type === DocumentSourceType.Base64 &&
    right.type === DocumentSourceType.Base64
  ) {
    return (
      left.data === right.data &&
      left.name === right.name &&
      left.parsedData === right.parsedData &&
      left.path === right.path
    );
  }

  if (
    left.type === DocumentSourceType.Text &&
    right.type === DocumentSourceType.Text
  ) {
    return (
      left.data === right.data &&
      left.name === right.name &&
      left.mime === right.mime
    );
  }

  return false;
}

function imageSourcesMatch(left: Base64ImageSource, right: Base64ImageSource) {
  return (
    left.type === right.type &&
    left.data === right.data &&
    left.mediaType === right.mediaType
  );
}

function arrayItemsMatch<T>(
  left: T[],
  right: T[],
  matches: (leftItem: T, rightItem: T) => boolean
) {
  return (
    left.length === right.length &&
    left.every((leftItem, index) => matches(leftItem, right[index]))
  );
}

function sendableContentMatches(
  left: ReturnType<typeof getSendableContentFromBlocks>,
  right: ReturnType<typeof getSendableContentFromBlocks>
) {
  return (
    left.text === right.text &&
    arrayItemsMatch(left.images, right.images, imageSourcesMatch) &&
    arrayItemsMatch(left.files, right.files, documentSourcesMatch)
  );
}

function buildStaleQueuedMessageResubmitParams(
  message: QueuedUserMessageState
): AddUserMessageRequestParams {
  const content = getSendableContentFromBlocks(message.content);

  return {
    text: content.text,
    ...(content.images.length > 0 ? { images: content.images } : {}),
    ...(content.files.length > 0 ? { files: content.files } : {}),
    queuePlacement: getQueuePlacementForQueuedMessageKind(message.kind),
  };
}

function loadedTranscriptHasDeliveredQueuedMessage(params: {
  loadedMessages: IndustryDroolMessage[];
  queuedMessage: QueuedUserMessageState;
}): boolean {
  const queuedContent = getSendableContentFromBlocks(
    params.queuedMessage.content
  );
  if (
    !queuedContent.text &&
    queuedContent.images.length === 0 &&
    queuedContent.files.length === 0
  ) {
    return false;
  }

  return params.loadedMessages.some((message) => {
    if (message.role !== MessageRole.User) {
      return false;
    }

    if (message.id === params.queuedMessage.requestId) {
      return true;
    }

    if (message.createdAt < params.queuedMessage.createdAt) {
      return false;
    }

    return sendableContentMatches(
      getSendableContentFromBlocks(message.content),
      queuedContent
    );
  });
}

export async function reconcileQueuedMessagesAfterLoad(params: {
  daemonClient: IDaemonClient;
  result: LoadSessionResult;
  sessionId: string;
  sessionManager: SessionStateManager | undefined;
}): Promise<void> {
  const { daemonClient, result, sessionId, sessionManager } = params;
  if (!sessionManager) {
    return;
  }

  const previousDaemonQueuedMessages = sessionManager
    .getQueuedMessages()
    .filter((message) => isDaemonQueuedMessageKind(message.kind));
  const restoredDaemonQueuedMessages = (result.queuedMessages ?? []).map(
    (queuedMsg) => {
      const content = buildUserMessageContentBlocks({
        text: queuedMsg.text,
        images: queuedMsg.images,
        files: queuedMsg.files,
      });

      return {
        requestId: queuedMsg.requestId,
        content,
        kind: getQueuedUserMessageKindForQueuePlacement(
          queuedMsg.queuePlacement
        ),
        createdAt: Date.now(),
      };
    }
  );
  const restoredRequestIds = new Set(
    restoredDaemonQueuedMessages.map((message) => message.requestId)
  );
  const retainedDrainedMessages: QueuedUserMessageState[] = [];
  const messagesToResubmit: QueuedUserMessageState[] = [];

  for (const queuedMessage of previousDaemonQueuedMessages) {
    if (restoredRequestIds.has(queuedMessage.requestId)) {
      continue;
    }

    if (
      loadedTranscriptHasDeliveredQueuedMessage({
        loadedMessages: result.session.messages,
        queuedMessage,
      })
    ) {
      continue;
    }

    if (result.isAgentLoopInProgress) {
      retainedDrainedMessages.push(queuedMessage);
      continue;
    }

    messagesToResubmit.push(queuedMessage);
  }

  sessionManager.replaceDaemonQueuedMessages([
    ...restoredDaemonQueuedMessages,
    ...retainedDrainedMessages,
  ]);

  if (restoredDaemonQueuedMessages.length > 0) {
    logInfo('[DaemonSessionController] Restored queued messages on load', {
      sessionId,
      count: restoredDaemonQueuedMessages.length,
    });
  }

  const failedResubmits: QueuedUserMessageState[] = [];

  for (const queuedMessage of messagesToResubmit) {
    try {
      await daemonClient.addUserMessageWithoutSessionLoadGuard(
        {
          ...buildStaleQueuedMessageResubmitParams(queuedMessage),
          sessionId,
        },
        queuedMessage.requestId
      );
      logInfo('[DaemonSessionController] Re-submitted stale queued message', {
        sessionId,
        requestId: queuedMessage.requestId,
      });
    } catch (error) {
      failedResubmits.push({
        ...queuedMessage,
        kind: QueuedUserMessageKind.LocalPausedAfterEsc,
      });
      logWarn(
        '[DaemonSessionController] Failed to re-submit stale queued message',
        {
          sessionId,
          requestId: queuedMessage.requestId,
          cause: error,
        }
      );
    }
  }

  if (failedResubmits.length > 0) {
    sessionManager.restoreQueuedMessagesToFront(failedResubmits);
  }
}
