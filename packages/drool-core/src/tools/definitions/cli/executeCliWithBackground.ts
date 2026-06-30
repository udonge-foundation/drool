import { z } from 'zod';

import {
  ToolExecutionLocation,
  TOOL_LLM_ID_EXECUTE,
} from '@industry/drool-sdk-ext/protocol/tools';

import { EXECUTE_CLI_TOOL_ID } from './constants';
import { getExecuteCliDescription } from './executeCli';
import { executeCliWithBackgroundSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const BASH_DESCRIPTION = getExecuteCliDescription({
  includeCoAuthoredByDrool: true,
});

// Note: We reuse the same tool ID so it overwrites the standard execute tool in the registry
export const executeCliWithBackgroundTool = createTool({
  id: EXECUTE_CLI_TOOL_ID,
  llmId: TOOL_LLM_ID_EXECUTE,
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Execute',
  description: BASH_DESCRIPTION,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: executeCliWithBackgroundSchema,
  outputSchemas: {
    result: z.string().describe('The output of the command'),
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.Process],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
