import { resolveSignatureRecoveryRawAnchorIndex } from '@industry/drool-core/llms/client/message-preparation';
import { SYSTEM_REMINDER_START } from '@industry/drool-sdk-ext/protocol/drool';
import { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';
import { approxTokensFromChars } from '@industry/utils/llm';

import { attachExistingSummary } from '@/hooks/compaction/CompactionManager';
import { CompactionSummaryKind } from '@/hooks/compaction/enums';
import { serializeConversation } from '@/hooks/compaction/messageSerializer';
import { toLastSummaryMeta } from '@/hooks/compaction/summaryMeta';
import type { LastSummaryMeta } from '@/hooks/compaction/types';
import { getSessionService } from '@/services/SessionService';
import { getSystemInfo } from '@/utils/systemInfo';
import { SystemInfo } from '@/utils/types';

type SessionService = ReturnType<
  typeof import('@/services/SessionService').getSessionService
>;

// Returns last summary meta. If there is no anchor message, returns anchorIndex = -1 (inject at start at load time).
export async function getLatestSummaryMetaFromSession(
  sessionService: SessionService,
  sessionId?: string
): Promise<LastSummaryMeta | undefined> {
  const latest = await sessionService.loadLatestCompactionSummary(sessionId);
  if (!latest) return undefined;
  return toLastSummaryMeta(latest);
}

export function isAnchoredAtLastMessage(
  lastSummary: LastSummaryMeta | undefined,
  messagesLength: number
): boolean {
  if (!lastSummary) return false;
  if (messagesLength <= 0) return false;
  return lastSummary.anchorIndex >= messagesLength - 1;
}

function isInitialUserSystemInfoReminder(text: string): boolean {
  return (
    text.includes(SYSTEM_REMINDER_START) &&
    text.includes('User system info') &&
    text.includes(
      'The commands below were executed at the start of all sessions'
    )
  );
}

function stripInitialUserSystemInfoReminderFromMessages(
  messages: IndustryDroolMessage[]
): IndustryDroolMessage[] {
  const first = messages[0];
  if (!first || first.role !== 'user') return messages;
  if (!Array.isArray(first.content)) return messages;

  const firstBlock = first.content[0];
  if (!firstBlock || firstBlock.type !== 'text') return messages;
  if (!isInitialUserSystemInfoReminder(firstBlock.text)) return messages;

  const nextContent = first.content.slice(1);
  if (nextContent.length === 0) return messages.slice(1);

  return [{ ...first, content: nextContent }, ...messages.slice(1)];
}

/**
 * Creates a serialized context for provider switch without calling an LLM.
 * This instantly converts the conversation to a text summary that can be
 * injected as context for the new provider. Natural compaction will handle
 * any context limit issues after the switch.
 */
export async function serializeAndPersistForProviderSwitch(
  sessionService: SessionService,
  params: {
    sessionId: string;
    messages: IndustryDroolMessage[];
  }
): Promise<LastSummaryMeta | undefined> {
  const { sessionId, messages } = params;
  if (messages.length === 0) return undefined;

  const modelId = getSessionService().getModel();
  const isByok = modelId ? modelId.startsWith('custom:').toString() : 'false';

  const startTime = performance.now();
  logInfo('[ProviderSwitch] Serializing conversation for provider switch', {
    eventType: 'provider_switch',
    state: 'start',
    source: 'providerSwitchUtils',
    messageCount: messages.length,
    modelId,
    isByok,
    sessionId,
  });

  // Capture system info
  let systemInfo: SystemInfo | undefined;
  try {
    systemInfo = await getSystemInfo();
  } catch (e) {
    logException(
      e,
      '[serializeAndPersistForProviderSwitch] Failed to fetch system info'
    );
  }

  // Serialize the conversation without calling the LLM.
  // To match how we build main LLM calls, we only serialize:
  //   (latest compaction summary) + (messages after that summary's anchor).
  // We respect ANY compaction boundary (LLM summary or prior provider-switch
  // serialization) to avoid re-serializing the entire history.
  const latestEvent =
    await sessionService.loadLatestCompactionSummary(sessionId);
  const latest = latestEvent ? toLastSummaryMeta(latestEvent) : undefined;

  // The first user message usually contains a large system reminder snapshot that we also
  // reinject after the serialized transcript; strip only that initial snapshot to avoid duplication.
  const sanitizedMessages = systemInfo
    ? stripInitialUserSystemInfoReminderFromMessages(messages)
    : messages;

  const messagesWithSummary = latest
    ? attachExistingSummary({
        messages: sanitizedMessages,
        lastSummary: {
          ...latest,
          systemInfo: undefined, // Do not include system info from prior summary either to avoid duplication
        },
      })
    : sanitizedMessages;

  const serializedText = serializeConversation(messagesWithSummary);
  const serializedTokens = approxTokensFromChars(serializedText.length);

  // Anchor at the last message
  const anchorIndex = messages.length - 1;
  const anchorId = messages[anchorIndex]?.id;

  // Save as a compaction summary
  const id = sessionService.saveCompactionSummary({
    summaryText: serializedText,
    summaryTokens: serializedTokens,
    summaryKind: CompactionSummaryKind.ProviderSwitchSerialization,
    anchorMessage: {
      id: anchorId,
      index: anchorIndex,
    },
    removedCount: messages.length,
    systemInfo,
  });

  const durationMs = performance.now() - startTime;
  logInfo('[ProviderSwitch] Serialization complete', {
    eventType: 'provider_switch',
    state: 'end',
    source: 'providerSwitchUtils',
    succeeded: true,
    durationMs,
    messageCount: messages.length,
    serializedTokens,
    modelId,
    isByok,
  });

  return {
    id,
    text: serializedText,
    anchorId,
    anchorIndex,
    tokens: serializedTokens,
    removedCount: messages.length,
    systemInfo,
    summaryKind: CompactionSummaryKind.ProviderSwitchSerialization,
  };
}

/**
 * Persists a recovery serialization boundary after a successful thinking
 * signature retry. The cleaned view (with bad signatures already stripped)
 * is serialized and saved as a compaction summary so subsequent turns
 * load the clean boundary instead of the corrupted JSONL history.
 *
 * Takes the already-cleaned historyWithSummary (which has any prior
 * compaction summary attached and head-truncated) rather than re-loading
 * and re-attaching summaries internally.
 */
export function serializeForSignatureRecovery(
  sessionService: SessionService,
  params: {
    cleanedHistoryWithSummary: IndustryDroolMessage[];
    rawHistoryLength: number;
    anchorId: string | undefined;
  }
): LastSummaryMeta | undefined {
  const { cleanedHistoryWithSummary, rawHistoryLength, anchorId } = params;
  if (cleanedHistoryWithSummary.length === 0) return undefined;

  const serializedText = serializeConversation(cleanedHistoryWithSummary);
  const serializedTokens = approxTokensFromChars(serializedText.length);
  const anchorIndex = rawHistoryLength - 1;

  const id = sessionService.saveCompactionSummary({
    summaryText: serializedText,
    summaryTokens: serializedTokens,
    summaryKind: CompactionSummaryKind.ProviderSwitchSerialization,
    anchorMessage: {
      id: anchorId,
      index: anchorIndex,
    },
    removedCount: rawHistoryLength,
  });

  logInfo('[SignatureRecovery] Persisted recovery serialization boundary', {
    eventType: 'signature_recovery',
    source: 'providerSwitchUtils',
    messageCount: cleanedHistoryWithSummary.length,
    serializedTokens,
    adjustedIndex: anchorIndex,
  });

  return {
    id,
    text: serializedText,
    anchorId,
    anchorIndex,
    tokens: serializedTokens,
    removedCount: rawHistoryLength,
    summaryKind: CompactionSummaryKind.ProviderSwitchSerialization,
  };
}

export function persistSignatureRecoveryBoundary(
  sessionService: SessionService,
  params: {
    rawHistory: IndustryDroolMessage[];
    cleanedHistoryWithSummary: IndustryDroolMessage[];
    lastStrippedMessageIndex: number | undefined;
    lastSummary: LastSummaryMeta | undefined;
  }
): LastSummaryMeta | undefined {
  const {
    rawHistory,
    cleanedHistoryWithSummary,
    lastStrippedMessageIndex,
    lastSummary,
  } = params;
  const rawAnchorIndex = resolveSignatureRecoveryRawAnchorIndex({
    rawHistory,
    cleanedHistoryWithSummary,
    lastStrippedMessageIndex,
    lastSummary,
  });
  const anchorIndex = rawAnchorIndex ?? rawHistory.length - 1;
  const lastMsg = rawHistory[anchorIndex];

  return serializeForSignatureRecovery(sessionService, {
    cleanedHistoryWithSummary:
      lastStrippedMessageIndex !== undefined
        ? cleanedHistoryWithSummary.slice(0, lastStrippedMessageIndex + 1)
        : cleanedHistoryWithSummary,
    rawHistoryLength: anchorIndex + 1,
    anchorId: lastMsg?.id,
  });
}
