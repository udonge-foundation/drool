import { DroolType } from '@industry/common/session';
import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../create-tool';
import { SandboxSideEffect, Toolkit } from '../enums';
import {
  storeAgentReadinessReportRemoteInputSchema,
  storeAgentReadinessReportRemoteOutputSchema,
} from './schema';

// Tool ID constant - used both in tool definition and isToolEnabled check
const STORE_AGENT_READINESS_REPORT_TOOL_ID = 'store_agent_readiness_report';

export const storeAgentReadinessReportRemoteTool = createTool({
  id: STORE_AGENT_READINESS_REPORT_TOOL_ID,
  llmId: 'store_agent_readiness_report',
  displayName: 'Store Agent Readiness Report',
  description: `Stores agent readiness evaluation results to Firestore for the given repository URL.

This tool is used by the Agent Readiness Drool to persist evaluation results after analyzing a repository's readiness for AI agents. The tool automatically captures session and organization context.

Input:
- repoUrl: Repository URL (supports GitHub, GitLab, Bitbucket, etc.)
- report: Object with signal evaluations, each containing numerator, denominator, and rationale

Output:
- success: Boolean indicating if the report was stored successfully
- reportId: UUID of the created report (if successful)  
- message: Success or error message

The tool handles:
- Repository URL validation and storage as-is
- Automatic context capture (session ID, organization ID)
- Direct Firestore storage using existing infrastructure
- Comprehensive error handling

All reports are stored immutably and can be queried using existing handlers from the agent readiness system.`,
  executionLocation: ToolExecutionLocation.Client,
  isTopLevelTool: true,
  requiresConfirmation: false,
  inputSchema: storeAgentReadinessReportRemoteInputSchema,
  outputSchemas: {
    result: storeAgentReadinessReportRemoteOutputSchema,
  },
  isVisibleToUser: false, // Auto-available infrastructure tool, not user-selectable
  sideEffects: [SandboxSideEffect.ExternalService],
  toolkit: Toolkit.Base,
  deferred: true,
  // Disabled by default, enabled in specific contexts:
  // 1. CLI: /readiness-report command or --enabled-tools (adds to enabledToolIds)
  // 2. CLI: Consistency test (caller sets ENABLE_READINESS_REPORT env var,
  //    which the CLI threads through IsToolEnabledParams.enableReadinessReport)
  // 3. Web: Agent readiness drool sessions (checks droolId)
  // 4. Delegations: enabledToolIds includes this tool
  isToolEnabled: ({ droolId, enabledToolIds, enableReadinessReport }) =>
    Boolean(enabledToolIds?.includes(STORE_AGENT_READINESS_REPORT_TOOL_ID)) ||
    droolId === DroolType.AGENT_READINESS ||
    Boolean(enableReadinessReport),
});
