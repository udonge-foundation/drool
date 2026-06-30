import { z } from 'zod';

import { DroolMode } from '@industry/common/shared';
import {
  ToolExecutionLocation,
  TOOL_LLM_ID_ASK_USER,
} from '@industry/drool-sdk-ext/protocol/tools';

import { askUserSchema } from './schema';
import { createTool } from '../../create-tool';
import { Toolkit, ToolUIGroupId } from '../../enums';

export const askUserTool = createTool({
  id: 'ask-user',
  llmId: TOOL_LLM_ID_ASK_USER,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'Ask User',
  description: `Use this tool when you need to ask the user 1–4 quick multiple-choice questions at once during execution to clarify requirements or decisions.

Important:
- Keep the questionnaire short and focused.
- The tool can be used more than once if there are important questions that needs to be asked
- User has an option to provide own custom answers, if they don't like suggested ones.
- If you haven't already explained the context and trade-offs of the options before invoking this tool, you MUST include that context in the [question] text itself so the user understands what they're choosing and why it matters. Keep option labels short, but make the question descriptive enough to stand on its own.
`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: askUserSchema,
  outputSchemas: {
    result: z
      .string()
      .describe('A plain-text list of questions and the selected answers.'),
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: true,
  sideEffects: [],
  toolkit: Toolkit.Base,
  isToolEnabled: ({ cliDroolMode, askUserToolEnabled }) =>
    askUserToolEnabled === true &&
    (cliDroolMode === DroolMode.TerminalUI ||
      cliDroolMode === DroolMode.InteractiveCLI),
});
