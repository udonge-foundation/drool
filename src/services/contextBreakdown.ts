import {
  ContextCategoryColorKey,
  type GetContextBreakdownResult,
} from '@industry/drool-sdk-ext/protocol/drool';
import { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';
import { approxTokensFromChars } from '@industry/utils/llm';

import { extractSystemReminderBlocks } from '@/commands/contextUtils';
import { getTuiModelConfig } from '@/models/config';
import { getDroolLoaderSingleton } from '@/services/drools/CustomDroolRegistry';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { getAllSkills } from '@/skills/builtin';
import {
  measureDroolDescriptionChars,
  measureMcpToolsChars,
  measureMessagesChars,
  measureSkillDescriptionChars,
  measureSystemPromptChars,
  measureToolsChars,
} from '@/utils/contextMeasurement';
import { computeLastCallCompactionTokens } from '@/utils/contextUsage';

import type { CustomDrool, Skill } from '@industry/common/settings';

/**
 * Builds the canonical latest-call compaction count plus the estimated
 * composition breakdown rendered by `/context`. Returns structured data for
 * serialization over the daemon protocol.
 *
 * Operates against the active session controlled by SessionService; the daemon
 * routes per-session calls by selecting the matching DroolClient before this
 * function is invoked, so no sessionId argument is needed here.
 */
export async function buildContextBreakdown(): Promise<GetContextBreakdownResult> {
  const sessionService = getSessionService();
  const modelSetting = sessionService.getModel();
  const modelConfig = getTuiModelConfig(modelSetting);
  const modelId = modelConfig.id ?? modelSetting;
  const modelProvider = modelConfig.modelProvider;
  const modelDisplayName = modelConfig.displayName ?? modelSetting;

  const contextBudget =
    getSettingsService().getCompactionTokenLimitForModel(modelId);
  const lastCallCompactionTokens = computeLastCallCompactionTokens(
    sessionService.getLastCallTokenUsage()
  );

  const systemPromptChars = measureSystemPromptChars(modelId, modelProvider);
  const systemPromptTokens = approxTokensFromChars(systemPromptChars);

  const toolsChars = await measureToolsChars();

  const { totalChars: mcpToolsChars, servers: mcpServers } =
    await measureMcpToolsChars();
  const mcpToolsTokens = approxTokensFromChars(mcpToolsChars);

  let rawMessages: { role: string; content: unknown[] }[] = [];
  try {
    const messageEvents = await sessionService.getAllMessageEvents();
    rawMessages = messageEvents
      .filter((e) => e.message)
      .map((e) => {
        const msg = e.message;
        const content =
          typeof msg.content === 'string'
            ? [{ type: 'text', text: msg.content }]
            : (msg.content as unknown[]);
        return { role: msg.role, content };
      });
  } catch {
    // empty
  }

  const { userInfoChars, agentsMdChars, skillsChars } =
    extractSystemReminderBlocks(rawMessages);
  const userInfoTokens = approxTokensFromChars(userInfoChars);
  const agentsMdTokens = approxTokensFromChars(agentsMdChars);
  const skillsTokens = approxTokensFromChars(skillsChars);

  const messagesChars = measureMessagesChars(rawMessages);
  const messagesTokens = approxTokensFromChars(messagesChars);

  let drools: CustomDrool[] = [];
  try {
    drools = await getDroolLoaderSingleton().loadAllDrools();
  } catch {
    // ignore
  }
  const droolsChars = drools.reduce(
    (sum, d) => sum + measureDroolDescriptionChars(d),
    0
  );
  const droolsTokens = approxTokensFromChars(droolsChars);

  let skills: Skill[] = [];
  try {
    skills = await getAllSkills({ validOnly: true });
    skills = skills.filter((s) => s.location !== SkillLocation.Builtin);
  } catch {
    // ignore
  }

  // Invariant: measureToolsChars() is expected to include the chars contributed
  // by drool descriptions, so subtracting them yields the chars attributable to
  // first-party tools alone. MCP context is measured separately because deferred
  // tool reminders are not provider tool schemas.
  if (toolsChars < droolsChars) {
    logWarn(
      '[contextBreakdown] tools char measurement is smaller than drool components'
    );
  }
  const adjustedToolsChars = Math.max(0, toolsChars - droolsChars);
  const adjustedToolsTokens = approxTokensFromChars(adjustedToolsChars);

  const usedTokens =
    systemPromptTokens +
    adjustedToolsTokens +
    mcpToolsTokens +
    userInfoTokens +
    agentsMdTokens +
    droolsTokens +
    skillsTokens +
    messagesTokens;
  const freeTokens = Math.max(0, contextBudget - usedTokens);

  const categories = [
    {
      name: 'System prompt',
      tokens: systemPromptTokens,
      colorKey: ContextCategoryColorKey.SystemPrompt,
    },
    {
      name: 'System tools',
      tokens: adjustedToolsTokens,
      colorKey: ContextCategoryColorKey.SystemTools,
    },
    {
      name: 'MCP tools',
      tokens: mcpToolsTokens,
      colorKey: ContextCategoryColorKey.McpTools,
    },
    {
      name: 'User info',
      tokens: userInfoTokens,
      colorKey: ContextCategoryColorKey.UserInfo,
    },
    {
      name: 'AGENTS.md',
      tokens: agentsMdTokens,
      colorKey: ContextCategoryColorKey.AgentsMd,
    },
    {
      name: 'Custom agents',
      tokens: droolsTokens,
      colorKey: ContextCategoryColorKey.CustomAgents,
    },
    {
      name: 'Skills',
      tokens: skillsTokens,
      colorKey: ContextCategoryColorKey.Skills,
    },
    {
      name: 'Messages',
      tokens: messagesTokens,
      colorKey: ContextCategoryColorKey.Messages,
    },
  ];

  const skillEntries = skills.map((skill) => ({
    name: skill.metadata.name,
    location: skill.location,
    tokens: approxTokensFromChars(measureSkillDescriptionChars(skill)),
  }));

  const mcpServerEntries = mcpServers.map((server) => ({
    name: server.name,
    toolCount: server.toolCount,
    tokens: approxTokensFromChars(server.chars),
  }));

  const droolEntries = drools.map((drool) => ({
    name: drool.metadata.name,
    location: drool.location,
    tokens: approxTokensFromChars(measureDroolDescriptionChars(drool)),
  }));

  return {
    modelId,
    modelDisplayName,
    contextBudget,
    ...(lastCallCompactionTokens > 0 ? { lastCallCompactionTokens } : {}),
    usedTokens,
    freeTokens,
    categories,
    skills: skillEntries,
    mcpServers: mcpServerEntries,
    drools: droolEntries,
  };
}
