import {
  ContextStatsAccuracy,
  type ContextStats,
} from '@industry/drool-sdk-ext/protocol/drool';
import { type ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  approxTokensFromChars,
  getLLMModel,
  resolveModelId,
} from '@industry/utils/llm';

import { extractSystemReminderBlocks } from '@/commands/contextUtils';
import { getDroolLoaderSingleton } from '@/services/drools/CustomDroolRegistry';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import {
  measureDroolDescriptionChars,
  measureMcpToolsChars,
  measureMessagesChars,
  measureSystemPromptChars,
  measureToolsChars,
} from '@/utils/contextMeasurement';
import type { RawMessage } from '@/utils/types';

function getActiveModelSelection(): {
  modelId: string;
  reasoningEffort: ReasoningEffort;
} {
  const sessionService = getSessionService();

  if (sessionService.isSpecMode() && sessionService.hasSpecModeModel()) {
    return {
      modelId: sessionService.getSpecModeModel(),
      reasoningEffort: sessionService.getSpecModeReasoningEffort(),
    };
  }

  return {
    modelId: sessionService.getModel(),
    reasoningEffort: sessionService.getReasoningEffort(),
  };
}

function getContextLimit(params: {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}): { limit: number; modelProvider: string; measuredModelId: string } {
  const resolvedModelId = resolveModelId(params.modelId);

  if (resolvedModelId) {
    const model = getLLMModel({
      modelId: resolvedModelId,
      reasoningEffort: params.reasoningEffort,
    });
    return {
      limit: model.maxInputTokens,
      modelProvider: model.modelProvider,
      measuredModelId: resolvedModelId,
    };
  }

  return {
    limit: getSettingsService().getCompactionTokenLimitForModel(params.modelId),
    modelProvider: 'anthropic',
    measuredModelId: params.modelId,
  };
}

export async function getContextStats(): Promise<ContextStats> {
  const sessionService = getSessionService();
  const { modelId, reasoningEffort } = getActiveModelSelection();
  const { limit, modelProvider, measuredModelId } = getContextLimit({
    modelId,
    reasoningEffort,
  });

  const [toolsChars, mcpToolsResult, messageEvents, drools] = await Promise.all(
    [
      measureToolsChars(),
      measureMcpToolsChars(),
      sessionService.getAllMessageEvents(),
      getDroolLoaderSingleton()
        .loadAllDrools()
        .catch(() => []),
    ]
  );

  const rawMessages: RawMessage[] = messageEvents
    .filter((event) => event.message)
    .map((event) => {
      const message = event.message;
      const content =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : (message.content as unknown[]);

      return {
        role: message.role,
        content,
      };
    });

  const { userInfoChars, agentsMdChars, skillsChars } =
    extractSystemReminderBlocks(rawMessages);
  const messagesChars = measureMessagesChars(rawMessages);
  const droolsChars = drools.reduce(
    (sum, drool) => sum + measureDroolDescriptionChars(drool),
    0
  );

  const systemPromptTokens = approxTokensFromChars(
    measureSystemPromptChars(measuredModelId, modelProvider)
  );
  const mcpToolsTokens = approxTokensFromChars(mcpToolsResult.totalChars);
  const droolsTokens = approxTokensFromChars(droolsChars);
  const skillsTokens = approxTokensFromChars(skillsChars);
  const toolsTokens = Math.max(
    0,
    approxTokensFromChars(toolsChars) - droolsTokens
  );
  const used =
    systemPromptTokens +
    toolsTokens +
    mcpToolsTokens +
    approxTokensFromChars(userInfoChars) +
    approxTokensFromChars(agentsMdChars) +
    droolsTokens +
    skillsTokens +
    approxTokensFromChars(messagesChars);

  return {
    used,
    remaining: Math.max(0, limit - used),
    limit,
    accuracy: ContextStatsAccuracy.Estimated,
    updatedAt: new Date().toISOString(),
  };
}
