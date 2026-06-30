import { z } from 'zod';

import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const taskStopSchema = z.object({
  task_id: z.string().describe('The ID of the background task to stop'),
});

// eslint-disable-next-line industry/types-file-organization
export type TaskStopParams = z.infer<typeof taskStopSchema>;

export const taskStopCliTool = createTool({
  id: 'task-stop-cli',
  llmId: 'TaskStop',
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'TaskStop',
  description: `Stops a running background task by its ID.
- Takes a task_id from a previously launched background Task
- Sends SIGTERM first, then SIGKILL if the process doesn't stop
- Returns success or failure status`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: taskStopSchema,
  outputSchemas: {
    result: z.string().describe('Confirmation of task stop'),
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.Process],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
