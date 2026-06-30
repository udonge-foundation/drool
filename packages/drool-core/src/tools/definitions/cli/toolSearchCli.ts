import { z } from 'zod';

import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { toolSearchSchema } from './schema';
import { createTool } from '../../create-tool';
import { Toolkit, ToolUIGroupId } from '../../enums';

export const toolSearchCliTool = createTool({
  id: 'tool-search-cli',
  llmId: 'ToolSearch',
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'ToolSearch',
  description: `Load schemas for deferred tools so they can be called. Use query "select:<name>[,<name>...]" with exact tool names copied from the "Deferred tools:" system reminder only. Never call ToolSearch for a tool that already appears in your current tool list, including built-in/core tools such as Read/Edit/Create/AskUser and any deferred tool you previously loaded this session; call those directly instead. Do not pass guessed aliases or tools that are not listed in the reminder.`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: toolSearchSchema,
  outputSchemas: {
    result: z.string().describe('Loaded tool names or error message'),
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
