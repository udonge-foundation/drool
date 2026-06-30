import { storeAgentReadinessReportRemoteTool } from '@industry/drool-core/tools/definitions';

import { getDeferredToolsService } from '@/services/deferredTools/DeferredToolsService';
import { getSessionService } from '@/services/SessionService';

const READINESS_TOOLS = [storeAgentReadinessReportRemoteTool];

export function ensureReadinessToolsEnabled(): void {
  const sessionService = getSessionService();
  const currentEnabled = sessionService.getEnabledToolIds();
  const nextEnabled = new Set(currentEnabled);

  for (const tool of READINESS_TOOLS) {
    nextEnabled.add(tool.id);
  }

  if (READINESS_TOOLS.some((tool) => !currentEnabled.includes(tool.id))) {
    sessionService.setEnabledToolIds([...nextEnabled]);
  }
}

export function markReadinessToolsLoaded(
  sessionId: string | null | undefined
): void {
  if (!sessionId) {
    return;
  }

  getDeferredToolsService().markLoadedBatch(
    sessionId,
    READINESS_TOOLS.map((tool) => tool.llmId ?? tool.id)
  );
}

export function enableAndLoadReadinessToolsForCurrentSession(): void {
  ensureReadinessToolsEnabled();
  markReadinessToolsLoaded(getSessionService().getCurrentSessionId());
}
