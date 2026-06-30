import { CompactionSummaryKind } from '@/hooks/compaction/enums';
import type { LastSummaryMeta } from '@/hooks/compaction/types';
import type { CompactionStateEvent } from '@/services/types';

type SessionService = ReturnType<
  typeof import('@/services/SessionService').getSessionService
>;

export function toLastSummaryMeta(
  event: CompactionStateEvent
): LastSummaryMeta {
  return {
    id: event.id,
    text: event.summaryText,
    anchorId: event.anchorMessage?.id,
    anchorIndex: event.anchorMessage?.index ?? -1,
    tokens: event.summaryTokens,
    removedCount: event.removedCount ?? 0,
    systemInfo: event.systemInfo,
    summaryKind: event.summaryKind ?? CompactionSummaryKind.LlmSummary,
  };
}

export async function loadLastSummaryMetas(
  sessionService: SessionService,
  sessionId?: string
): Promise<{
  latest?: LastSummaryMeta;
  latestLlm?: LastSummaryMeta;
}> {
  const latestEvent =
    await sessionService.loadLatestCompactionSummary(sessionId);
  if (!latestEvent) {
    return { latest: undefined, latestLlm: undefined };
  }

  const latest = toLastSummaryMeta(latestEvent);
  if (
    (latest.summaryKind ?? CompactionSummaryKind.LlmSummary) ===
    CompactionSummaryKind.LlmSummary
  ) {
    return { latest, latestLlm: latest };
  }

  // If the latest is a provider-switch serialization, check for a more recent
  // LLM summary. If none exists, use the provider-switch serialization as the
  // delta baseline so subsequent compactions don't straddle the boundary
  // (even after session restart).
  const latestLlmEvent =
    await sessionService.loadLatestLlmCompactionSummary(sessionId);
  const latestLlm = latestLlmEvent
    ? toLastSummaryMeta(latestLlmEvent)
    : undefined;
  // If no LLM summary exists after the non-LLM compaction event, use the
  // latest as the delta baseline so compactions don't straddle the boundary.
  return { latest, latestLlm: latestLlm ?? latest };
}
