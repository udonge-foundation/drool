import { z } from 'zod';

import {
  ToolExecutionLocation,
  TOOL_LLM_ID_EXIT_SPEC_MODE,
} from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const exitSpecModeSchema = z.object({
  title: z
    .string()
    .optional()
    .describe('Optional spec title to use when saving the spec.'),
  plan: z
    .string()
    .describe(
      'The single concrete plan you came up with, that you want to run by the user for approval. Supports markdown. The plan should be pretty concise. Do not include multiple unresolved options or alternatives here; use AskUser first so the user chooses one option, then put only the selected approach in this plan.'
    ),
});

const exitSpecModeResultSchema = z.object({
  approved: z.boolean().describe('Whether the user approved the plan'),
});

export const exitSpecModeTool = createTool({
  id: 'exit-spec-mode',
  llmId: TOOL_LLM_ID_EXIT_SPEC_MODE,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'Propose Specification',
  description: `Use this tool only when you are in spec mode and have finished crafting a concrete implementation plan that the user needs to review before you start coding. The primary purpose of this tool is to present that plan, get explicit approval, and then exit spec mode so you can begin implementation.

  Before calling this tool: if requirements are ambiguous or key decisions are missing, first call the AskUser tool to ask focused questions and incorporate the answers into your plan.

  If relevant, include minimal key code snippets in your spec to illustrate your approach.

  When NOT to use this tool:
  • Pure research / investigation tasks (e.g., "Search for and understand the implementation of vim mode") where you are not yet proposing implementation steps.
  • Situations where you are still gathering context or the task does not require coding work.
  • If the system message "Spec mode is active" is **NOT** present.

  Example 1: Task = "Search for and understand the implementation of vim mode" → stay in spec mode, do not call this tool.
  Example 2: Task = "Help me implement yank mode for vim" → once your implementation plan is ready, call this tool to present it before coding.

  Important:
  When there are several equally strong alternatives to approach the problem, or when the user asks for options to go through, review, or choose from, do not pass selectable alternatives to ExitSpecMode and do not include unresolved Option A/Option B style sections in the plan. Before generating the final spec, first output the alternatives as normal assistant text with enough detail for the user to compare them, then call AskUser so the user can choose one option. After the user chooses, incorporate the selected option into a single concrete ExitSpecMode plan.

  Keep the AskUser questionnaire concise because the option details should be in your preceding assistant message. Use this shape for option selection:
  1. [question] Which approach should I use for the spec?
  [topic] Approach
  [option] <short option label 1>
  [option] <short option label 2>
  [option] <short option label 3 if needed>
  [option] <short option label 4 if needed>
  `,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: exitSpecModeSchema,
  outputSchemas: {
    result: exitSpecModeResultSchema,
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: true, // This will trigger the approval modal
  sideEffects: [SandboxSideEffect.FilesystemWrite],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
