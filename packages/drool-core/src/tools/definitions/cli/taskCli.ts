import { z } from 'zod';

import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { DEFAULT_TASK_TOOL_DESCRIPTION } from './constants';
import { createTool } from '../../create-tool';
import {
  ComplexityTier,
  SandboxSideEffect,
  Toolkit,
  ToolUIGroupId,
} from '../../enums';

const taskToolSchemaBase = z.object({
  subagent_type: z
    .string()
    .describe('The type of specialized agent to use for this task'),
  description: z
    .string()
    .describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
});

const taskToolSchemaV2 = taskToolSchemaBase.extend({
  complexity: z
    .nativeEnum(ComplexityTier)
    .optional()
    .describe(
      'Optional complexity tier. When set, Task model selection follows the configured complexity→model routing in settings.'
    ),
  run_in_background: z
    .boolean()
    .default(false)
    .describe(
      'Run the task in the background. Returns immediately with a task_id. Use TaskOutput to check results.'
    ),
  resume: z
    .string()
    .optional()
    .describe(
      'Task ID (session ID) from a previous invocation to resume with full context preserved'
    ),
});

interface CreateTaskCliToolOptions {
  description?: string;
  enableV2Schema?: boolean;
}

/**
 * Creates a task CLI tool with an optional custom description.
 * If no description is provided, uses the default description.
 * When enableV2Schema is true, includes complexity, run_in_background, and resume params.
 */
export function createTaskCliTool(options?: string | CreateTaskCliToolOptions) {
  const description =
    typeof options === 'string' ? options : options?.description;
  const enableV2Schema =
    typeof options === 'object' ? (options.enableV2Schema ?? false) : false;

  return createTool({
    id: 'task-cli',
    llmId: 'Task',
    uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
    displayName: 'Task',
    description: description || DEFAULT_TASK_TOOL_DESCRIPTION,
    executionLocation: ToolExecutionLocation.Client,
    inputSchema: enableV2Schema ? taskToolSchemaV2 : taskToolSchemaBase,
    outputSchemas: {
      result: z
        .string()
        .describe('The output from the task subagent execution'),
    },
    isVisibleToUser: false,
    isTopLevelTool: true,
    requiresConfirmation: false,
    // Task spawns a subagent as an externally-chosen execution path; the
    // subagent's own tool calls are individually sandbox-checked, so the tool's
    // direct sandbox-relevant effect is Process.
    sideEffects: [SandboxSideEffect.Process],
    toolkit: Toolkit.Base,
    isToolEnabled: true,
  });
}

// Export a default instance for backward compatibility
export const taskCliTool = createTaskCliTool();
