import { z } from 'zod';

import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const skillToolSchema = z.object({
  skill: z.string().describe('The skill name to execute'),
});

export const skillTool = createTool({
  id: 'skill',
  llmId: 'Skill',
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Skill',
  description: '',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: skillToolSchema,
  outputSchemas: {
    result: z.string().describe('The skill execution result message'),
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.FilesystemRead],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
