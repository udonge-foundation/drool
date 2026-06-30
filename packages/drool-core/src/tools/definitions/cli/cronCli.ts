import { z } from 'zod';

import {
  CronCreateToolInputSchema,
  CronDeleteToolInputSchema,
  CronListToolInputSchema,
} from '@industry/drool-sdk-ext/protocol/drool';
import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const CRON_CREATE_CLI_TOOL_ID = 'cron-create-cli';
const CRON_LIST_CLI_TOOL_ID = 'cron-list-cli';
const CRON_DELETE_CLI_TOOL_ID = 'cron-delete-cli';
const CRON_CREATE_LLM_TOOL_ID = 'CronCreate';
const CRON_LIST_LLM_TOOL_ID = 'CronList';
const CRON_DELETE_LLM_TOOL_ID = 'CronDelete';

export const cronCreateCliTool = createTool({
  id: CRON_CREATE_CLI_TOOL_ID,
  llmId: CRON_CREATE_LLM_TOOL_ID,
  displayName: 'Create Cron',
  description:
    'Schedule a one-time or recurring prompt. Use same_session for /loop-style reminders to this Drool, or new_session for root-scoped local automations that start a fresh Drool session.',
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: CronCreateToolInputSchema,
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

export const cronListCliTool = createTool({
  id: CRON_LIST_CLI_TOOL_ID,
  llmId: CRON_LIST_LLM_TOOL_ID,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'List Crons',
  description:
    'List scheduled crons visible from this Drool session, including root-scoped local automations.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: CronListToolInputSchema,
  outputSchemas: {
    result: z.string(),
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  toolkit: Toolkit.Base,
  deferred: true,
  sideEffects: [],
  isToolEnabled: true,
});

export const cronDeleteCliTool = createTool({
  id: CRON_DELETE_CLI_TOOL_ID,
  llmId: CRON_DELETE_LLM_TOOL_ID,
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Cancel Cron',
  description: 'Cancel one scheduled cron by cron ID.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: CronDeleteToolInputSchema,
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
