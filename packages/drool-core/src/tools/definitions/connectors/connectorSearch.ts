import {
  TOOL_LLM_ID_CONNECTOR_SEARCH,
  ToolExecutionLocation,
} from '@industry/drool-sdk-ext/protocol/tools';

import { connectorSearchSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const connectorSearchTool = createTool({
  id: TOOL_LLM_ID_CONNECTOR_SEARCH,
  llmId: TOOL_LLM_ID_CONNECTOR_SEARCH,
  uiGroupId: ToolUIGroupId.ConnectorSearch,
  displayName: 'Connectors',
  description:
    'Use connected third-party apps (GitHub, Slack, Linear, Jira, and more) on behalf of the user via their authenticated connectors.\n' +
    '\n' +
    'Workflow:\n' +
    '1. Call with `action: "list_tools"` to discover the available connector tools, grouped by connector with compact argument hints (`*` marks required arguments). Pass `authenticatedOnly: true` to limit results to apps the user has already connected.\n' +
    '2. If the argument hints are not enough, call `action: "list_tools"` with `toolName` to get that tool\'s full input schema.\n' +
    '3. Call with `action: "call_tool"`, `toolName`, and `toolArguments` to run a specific tool.\n' +
    '\n' +
    'If a tool requires authentication, the result contains a clickable link. Surface that link to the user, ask them to connect, then retry the tool call.\n' +
    '\n' +
    'Do not proactively name or speculate about the third-party platform that brokers connectors; refer to it as "connectors" or by the specific app name. Connect links may include the provider\'s domain; share them as-is.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: connectorSearchSchema,
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  toolkit: Toolkit.Connectors,
  isToolEnabled: true,
  // The executor only calls the Industry API; connector tools run remotely on
  // the backend, so there are no local filesystem/process side effects.
  sideEffects: [SandboxSideEffect.ExternalService],
});
