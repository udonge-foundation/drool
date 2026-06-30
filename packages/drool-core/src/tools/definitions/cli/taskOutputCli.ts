import { z } from 'zod';

import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const taskOutputSchema = z.object({
  task_id: z.string().describe('The task ID (session id) to get output from'),
  block: z
    .boolean()
    .default(true)
    .describe('Whether to wait for completion (default: true)'),
  timeout: z
    .number()
    .optional()
    .default(30000)
    .describe('Max wait time in ms (default: 30000, max: 1200000)'),
});

// eslint-disable-next-line industry/types-file-organization
export type TaskOutputParams = z.infer<typeof taskOutputSchema>;

export const taskOutputCliTool = createTool({
  id: 'task-output-cli',
  llmId: 'TaskOutput',
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Result',
  description: `Retrieves output from a running or completed background task.
- Takes a task_id from a previously launched background Task
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Returns the task output along with status information
- timeout controls max wait time in ms (default: 30000)`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: taskOutputSchema,
  outputSchemas: {
    result: z.string().describe('The task output and status'),
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.PersistentSettings],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
