import {
  getAgentEffectivenessUsageTool,
  renderAgentEffectivenessReportTool,
} from '@industry/drool-core/tools/definitions';

import { getDeferredToolsService } from '@/services/deferredTools/DeferredToolsService';
import { getSessionService } from '@/services/SessionService';

const AGENT_EFFECTIVENESS_TOOLS = [
  getAgentEffectivenessUsageTool,
  renderAgentEffectivenessReportTool,
];

export function ensureAgentEffectivenessToolsEnabled(): void {
  const sessionService = getSessionService();
  const currentEnabled = sessionService.getEnabledToolIds();
  const nextEnabled = new Set(currentEnabled);

  for (const tool of AGENT_EFFECTIVENESS_TOOLS) {
    nextEnabled.add(tool.id);
  }

  if (
    AGENT_EFFECTIVENESS_TOOLS.some((tool) => !currentEnabled.includes(tool.id))
  ) {
    sessionService.setEnabledToolIds([...nextEnabled]);
  }
}

export function markAgentEffectivenessToolsLoaded(
  sessionId: string | null | undefined
): void {
  if (!sessionId) {
    return;
  }

  getDeferredToolsService().markLoadedBatch(
    sessionId,
    AGENT_EFFECTIVENESS_TOOLS.map((tool) => tool.llmId ?? tool.id)
  );
}

export function enableAndLoadAgentEffectivenessToolsForCurrentSession(): void {
  ensureAgentEffectivenessToolsEnabled();
  markAgentEffectivenessToolsLoaded(getSessionService().getCurrentSessionId());
}
