import { extractEmptyResponseTelemetry } from '@industry/drool-core/llms/errors';
import { IndustryDroolMessage } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logException } from '@industry/logging';
import { isAbortError } from '@industry/utils/function';

import { compactAnchoredAtLastMessage } from '@/hooks/compaction/CompactionManager';
import { CompactionSummaryKind } from '@/hooks/compaction/enums';
import { toLastSummaryMeta } from '@/hooks/compaction/summaryMeta';
import { getSessionService } from '@/services/SessionService';
import type { DroolSession } from '@/services/types';
import { CliTelemetryClient } from '@/utils/cliTelemetryClient';
import type { SystemInfo } from '@/utils/types';
import { generateUUID } from '@/utils/uuid';

type SummarizeFn = ReturnType<typeof import('./Summarizer').createSummarizer>;

export async function compactToNewSession(params: {
  sessionId: string;
  messages: IndustryDroolMessage[];
  summarize: SummarizeFn;
  systemInfo?: SystemInfo;
  signal?: AbortSignal;
  customInstructions?: string;
}): Promise<{
  newSessionId: string;
  compactionSummaryId: string;
  newSummaryText: string;
  removedCount: number;
  newSession?: DroolSession;
} | null> {
  const {
    sessionId,
    messages,
    summarize,
    systemInfo,
    signal,
    customInstructions,
  } = params;
  if (messages.length === 0) return null;

  const sessionService = getSessionService();
  const latestEvent =
    await sessionService.loadLatestLlmCompactionSummary(sessionId);
  const latest = latestEvent ? toLastSummaryMeta(latestEvent) : undefined;

  const telemetryClient = CliTelemetryClient.getInstance();
  const modelId = getSessionService().getModel();
  const isByok = modelId ? modelId.startsWith('custom:').toString() : 'false';

  // Tag logs for manual compaction (/compress)
  telemetryClient.setCompactionReason('manual');
  const startTime = performance.now();
  logInfo('[Compaction] Start (manual)', {
    eventType: 'compaction',
    state: 'start',
    reason: 'manual',
    source: 'tui',
    modelId,
    isByok,
  });

  try {
    let result;
    try {
      result = await compactAnchoredAtLastMessage({
        messages,
        sessionId,
        summarize,
        lastSummary: latest
          ? {
              ...latest,
              summaryKind:
                latest.summaryKind ?? CompactionSummaryKind.LlmSummary,
            }
          : undefined,
        signal,
        systemInfo,
        customInstructions,
      });
    } catch (error) {
      const compactionDurationMs = performance.now() - startTime;
      if (isAbortError(error)) {
        logInfo('[Compaction] End (manual aborted)', {
          eventType: 'compaction',
          state: 'end',
          reason: 'manual',
          source: 'tui',
          succeeded: false,
          abortReason: 'user_interrupt',
          compactionDurationMs,
          modelId,
          isByok,
        });
      } else {
        logException(error, '[Compaction] End (manual error)', {
          eventType: 'compaction',
          state: 'end',
          reason: 'manual',
          source: 'tui',
          succeeded: false,
          compactionDurationMs,
          modelId,
          isByok,
          ...(extractEmptyResponseTelemetry(error) ?? {}),
        });
      }
      throw error;
    }

    if (!result.newSummaryText) {
      const compactionDurationMs = performance.now() - startTime;
      logInfo('[Compaction] End (manual no summary)', {
        eventType: 'compaction',
        state: 'end',
        reason: 'manual',
        source: 'tui',
        succeeded: false,
        compactionDurationMs,
        modelId,
        isByok,
      });
      return null;
    }

    // Get the current session's cwd so the new session is created in the same directory
    const currentCwd = sessionService.getCurrentSessionCwd();

    // Capture current token usage before creating new session so it can be inherited
    const currentTokenUsage = sessionService.getTokenUsage();
    logInfo('[Compaction] Capturing token usage for inheritance', {
      inputTokens: currentTokenUsage.inputTokens,
      outputTokens: currentTokenUsage.outputTokens,
      cachedTokensWritten: currentTokenUsage.cacheCreationTokens,
      cachedTokensRead: currentTokenUsage.cacheReadTokens,
      reasoningTokens: currentTokenUsage.thinkingTokens,
    });

    const newSessionId = await sessionService.createSessionWithId({
      sessionId: generateUUID(),
      firstUserMessage: undefined,
      parentSessionId: sessionId,
      source: 'compact',
      cwd: currentCwd,
      inheritTokenUsage: currentTokenUsage,
    });

    const compactionSummaryId = sessionService.saveCompactionSummary({
      summaryText: result.newSummaryText,
      summaryTokens: result.newSummaryTokens ?? 0,
      summaryKind: CompactionSummaryKind.LlmSummary,
      // Anchorless summary: represents entire prior session; inject at start on load
      removedCount: messages.length,
      systemInfo,
    });

    {
      const compactionDurationMs = performance.now() - startTime;
      logInfo('[Compaction] End (manual succeeded)', {
        eventType: 'compaction',
        state: 'end',
        reason: 'manual',
        source: 'tui',
        succeeded: true,
        compactionDurationMs,
        numMessagesRemoved: messages.length,
        summaryOutputTokens: result.newSummaryTokens ?? 0,
        modelId,
        isByok,
      });
    }

    logInfo('[Compaction] New session created from /compact', {
      oldSessionId: sessionId,
      newSessionId,
    });

    return {
      newSessionId,
      compactionSummaryId,
      newSummaryText: result.newSummaryText,
      removedCount: messages.length,
    };
  } finally {
    telemetryClient.clearCompactionReason();
  }
}
