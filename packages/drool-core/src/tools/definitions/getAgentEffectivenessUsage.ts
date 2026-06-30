import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../create-tool';
import { SandboxSideEffect, Toolkit } from '../enums';
import {
  getAgentEffectivenessUsageInputSchema,
  getAgentEffectivenessUsageOutputSchema,
} from './schema';

const GET_AGENT_EFFECTIVENESS_USAGE_TOOL_ID = 'get_agent_effectiveness_usage';

export const getAgentEffectivenessUsageTool = createTool({
  id: GET_AGENT_EFFECTIVENESS_USAGE_TOOL_ID,
  llmId: GET_AGENT_EFFECTIVENESS_USAGE_TOOL_ID,
  displayName: 'Get Agent Effectiveness Usage',
  description: `Fetches Industry usage metrics for the invoking user's currently authenticated Industry organization.

Use this tool during /agent-effectiveness-report after resolving the report timeframe. The tool handles Industry auth and org scoping; callers must not provide org IDs, SQL, BigQuery credentials, tracker data, pull request data, or repository lists.

Input:
- dateRange: "custom", "lifetime", "last_30_days", or "last_90_days"
- startDate/endDate: YYYY-MM-DD, required for custom ranges

Output:
- organization metadata
- resolved start/end dates
- Industry usage rows by user with credits, sessions, drool PRs/commits, tool calls, skill calls, and file operations

Collect GitHub, Linear, and Jira data with their own local tools/MCP/API access, then join that local data with this usage output in the report template.`,
  executionLocation: ToolExecutionLocation.Client,
  isTopLevelTool: true,
  requiresConfirmation: false,
  inputSchema: getAgentEffectivenessUsageInputSchema,
  outputSchemas: {
    result: getAgentEffectivenessUsageOutputSchema,
  },
  isVisibleToUser: false,
  sideEffects: [SandboxSideEffect.ExternalService],
  toolkit: Toolkit.Base,
  deferred: true,
  isToolEnabled: ({ enabledToolIds }) =>
    Boolean(enabledToolIds?.includes(GET_AGENT_EFFECTIVENESS_USAGE_TOOL_ID)),
});
