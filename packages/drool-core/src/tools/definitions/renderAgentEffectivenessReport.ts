import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../create-tool';
import { SandboxSideEffect, Toolkit } from '../enums';
import {
  renderAgentEffectivenessReportInputSchema,
  renderAgentEffectivenessReportOutputSchema,
} from './schema';

const RENDER_AGENT_EFFECTIVENESS_REPORT_TOOL_ID =
  'render_agent_effectiveness_report';

export const renderAgentEffectivenessReportTool = createTool({
  id: RENDER_AGENT_EFFECTIVENESS_REPORT_TOOL_ID,
  llmId: RENDER_AGENT_EFFECTIVENESS_REPORT_TOOL_ID,
  displayName: 'Render Agent Effectiveness Report',
  description: `Renders and saves the local Agent Effectiveness HTML report using Drool's bundled shared renderer.

Use this tool during /agent-effectiveness-report after collecting Industry usage, daily usage rows, GitHub pull requests, Linear/Jira work items, and checked repositories locally. The tool computes deterministic metrics, builds the daily token-efficiency trend, validates the generated HTML, writes it to the local temp report directory, and returns the exact file path and file URL.

Do not import @industry/drool-core from a temporary script for rendering; this tool exposes the renderer even when the user does not have industry-mono cloned.`,
  executionLocation: ToolExecutionLocation.Client,
  isTopLevelTool: true,
  requiresConfirmation: false,
  inputSchema: renderAgentEffectivenessReportInputSchema,
  outputSchemas: {
    result: renderAgentEffectivenessReportOutputSchema,
  },
  isVisibleToUser: false,
  sideEffects: [SandboxSideEffect.FilesystemWrite],
  toolkit: Toolkit.Base,
  deferred: true,
  isToolEnabled: ({ enabledToolIds }) =>
    Boolean(
      enabledToolIds?.includes(RENDER_AGENT_EFFECTIVENESS_REPORT_TOOL_ID)
    ),
});
