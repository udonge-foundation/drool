import { z } from 'zod';

import {
  AutomationCreateToolInputSchema,
  AutomationDeleteToolInputSchema,
  AutomationEditToolInputSchema,
  AutomationListToolInputSchema,
  AutomationReadToolInputSchema,
} from '@industry/drool-sdk-ext/protocol/drool';
import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const AUTOMATION_CREATE_CLI_TOOL_ID = 'automation-create-cli';
const AUTOMATION_LIST_CLI_TOOL_ID = 'automation-list-cli';
const AUTOMATION_READ_CLI_TOOL_ID = 'automation-read-cli';
const AUTOMATION_EDIT_CLI_TOOL_ID = 'automation-edit-cli';
const AUTOMATION_DELETE_CLI_TOOL_ID = 'automation-delete-cli';
const AUTOMATION_CREATE_LLM_TOOL_ID = 'CreateAutomation';
const AUTOMATION_LIST_LLM_TOOL_ID = 'ListAutomations';
const AUTOMATION_READ_LLM_TOOL_ID = 'ReadAutomation';
const AUTOMATION_EDIT_LLM_TOOL_ID = 'EditAutomation';
const AUTOMATION_DELETE_LLM_TOOL_ID = 'DeleteAutomation';

export const createAutomationCliTool = createTool({
  id: AUTOMATION_CREATE_CLI_TOOL_ID,
  llmId: AUTOMATION_CREATE_LLM_TOOL_ID,
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Create Automation',
  description:
    'Create a scheduled cloud automation (executionLocation="remote") that runs on a drool computer and fires once immediately. Local automations are not yet supported in the CLI.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: AutomationCreateToolInputSchema,
  outputSchemas: {
    result: z.string(),
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: true,
  toolkit: Toolkit.Base,
  deferred: true,
  sideEffects: [SandboxSideEffect.ExternalService],
  isToolEnabled: true,
});

export const listAutomationsCliTool = createTool({
  id: AUTOMATION_LIST_CLI_TOOL_ID,
  llmId: AUTOMATION_LIST_LLM_TOOL_ID,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'List Automations',
  description:
    'List scheduled cloud automations (executionLocation="remote"). Local automations are not yet supported in the CLI.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: AutomationListToolInputSchema,
  outputSchemas: {
    result: z.string(),
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  toolkit: Toolkit.Base,
  deferred: true,
  sideEffects: [SandboxSideEffect.ExternalService],
  isToolEnabled: true,
});

export const readAutomationCliTool = createTool({
  id: AUTOMATION_READ_CLI_TOOL_ID,
  llmId: AUTOMATION_READ_LLM_TOOL_ID,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'Read Automation',
  description:
    'Read one scheduled cloud automation by ID (executionLocation="remote"). Local automations are not yet supported in the CLI.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: AutomationReadToolInputSchema,
  outputSchemas: {
    result: z.string(),
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  toolkit: Toolkit.Base,
  deferred: true,
  sideEffects: [SandboxSideEffect.ExternalService],
  isToolEnabled: true,
});

export const editAutomationCliTool = createTool({
  id: AUTOMATION_EDIT_CLI_TOOL_ID,
  llmId: AUTOMATION_EDIT_LLM_TOOL_ID,
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Edit Automation',
  description:
    'Update one scheduled cloud automation by ID (executionLocation="remote"): name, prompt, status, schedule, description, computer. Local automations are not yet supported in the CLI.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: AutomationEditToolInputSchema,
  outputSchemas: {
    result: z.string(),
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: true,
  toolkit: Toolkit.Base,
  deferred: true,
  sideEffects: [SandboxSideEffect.ExternalService],
  isToolEnabled: true,
});

export const deleteAutomationCliTool = createTool({
  id: AUTOMATION_DELETE_CLI_TOOL_ID,
  llmId: AUTOMATION_DELETE_LLM_TOOL_ID,
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Delete Automation',
  description:
    'Delete one scheduled cloud automation by ID (executionLocation="remote"). Local automations are not yet supported in the CLI.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: AutomationDeleteToolInputSchema,
  outputSchemas: {
    result: z.string(),
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: true,
  toolkit: Toolkit.Base,
  deferred: true,
  sideEffects: [SandboxSideEffect.ExternalService],
  isToolEnabled: true,
});
