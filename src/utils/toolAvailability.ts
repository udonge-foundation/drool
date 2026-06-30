import {
  generateDroolCliTool,
  getAgentEffectivenessUsageTool,
  slackPostFileTool,
  slackPostMessageTool,
  storeAgentReadinessReportRemoteTool,
  webSearchTool,
} from '@industry/drool-core/tools/definitions';
import { UPGRADE_SESSION_MODEL_TOOL_ID } from '@industry/drool-core/tools/definitions/cli';
import { IndustryTool } from '@industry/drool-core/tools/types';
import {
  INDUSTRY_ROUTER_MODEL_ID,
  ModelProvider,
} from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';

import { getEnv, getRuntimeAuthConfig } from '@/environment';
import { getTuiModelConfig } from '@/models/config';
import { isSessionModelUpgradeAvailable } from '@/models/sessionModelUpgrade';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { getSessionService } from '@/services/SessionService';
import { ToolEnablementResult } from '@/utils/toolAvailability/types';

interface EvaluateToolEnabledOptions {
  enabledToolIds?: string[];
}

// Tools that depend entirely on the Industry backend (search / integration /
// LLM-proxy APIs) with no local fallback. They can never succeed under
// airgap, so hide them from the LLM instead of failing at execution time.
// FetchUrl is exempt: it falls back to local curl/wget when the API fails.
const AIRGAP_BLOCKED_TOOL_IDS = new Set<string>([
  webSearchTool.id,
  slackPostFileTool.id,
  slackPostMessageTool.id,
  storeAgentReadinessReportRemoteTool.id,
  getAgentEffectivenessUsageTool.id,
  generateDroolCliTool.id,
]);

export function evaluateToolEnabled(
  tool: IndustryTool,
  modelId: string,
  options: EvaluateToolEnabledOptions = {}
): ToolEnablementResult {
  const modelProvider = getTuiModelConfig(modelId).modelProvider;
  const useTopLevelFileEditing = modelProvider === ModelProvider.OPENAI;

  if (
    AIRGAP_BLOCKED_TOOL_IDS.has(tool.id) &&
    getRuntimeAuthConfig().airgapEnabled
  ) {
    return { enabled: false, modelProvider };
  }

  // Tool-list builders run before primeForMessage primes `effective`.
  // In exec, `resolveToolSelection` also runs before `SessionService`
  // is initialized with the Router choice -- so getDisplayActiveModel()
  // falls back to the user's settings default. The `modelId` arg, by
  // contrast, comes from the caller (e.g. `options.model` = "auto"
  // for `drool exec --model auto`). Recognize Router via either
  // signal so both exec-boot and interactive paths are covered.
  // getDisplayActiveModel() (not getDisplayModel()) so spec-mode
  // sessions gate on the active spec model -- matching primeForMessage.
  if (tool.id === UPGRADE_SESSION_MODEL_TOOL_ID) {
    const sessionService = getSessionService();
    const effective = sessionService.getEffectiveIndustryRouterModel();
    const isIndustryRouterSession =
      modelId === INDUSTRY_ROUTER_MODEL_ID ||
      sessionService.getDisplayActiveModel() === INDUSTRY_ROUTER_MODEL_ID;
    if (effective === undefined && isIndustryRouterSession) {
      return { enabled: true, modelProvider };
    }
    return {
      enabled: isSessionModelUpgradeAvailable(effective),
      modelProvider,
    };
  }

  const flag = tool.isToolEnabled;
  if (typeof flag === 'boolean') {
    return { enabled: flag, modelProvider };
  }

  if (typeof flag === 'function') {
    try {
      const enabledToolIds =
        options.enabledToolIds ?? getSessionService().getEnabledToolIds();
      const droolRuntime = getDroolRuntimeService();

      const enabled = flag({
        context: [],
        mcpServers: [],
        integrations: [],
        sessionId: '',
        modelProvider,
        droolId: null,
        machineConnectionType: null,
        useTopLevelFileEditing,
        orgToolSettings: { browserToolsEnabled: true },
        cliDroolMode: droolRuntime.getDroolMode(),
        askUserToolEnabled: !droolRuntime.isAcpMode(),
        enabledToolIds,
        enableReadinessReport: getEnv().extras.enableReadinessReport,
      });

      return { enabled, modelProvider };
    } catch (error) {
      logWarn('Failed to evaluate tool availability', {
        error,
        toolId: tool.id,
      });
      return { enabled: false, modelProvider };
    }
  }

  return { enabled: true, modelProvider };
}
