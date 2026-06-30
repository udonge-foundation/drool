import { z } from 'zod';

import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import {
  ToolExecutionLocation,
  TOOL_LLM_ID_CREATE,
} from '@industry/drool-sdk-ext/protocol/tools';
import { logWarn } from '@industry/logging';

import { createCliSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const createCliTool = createTool({
  id: 'create-cli',
  llmId: TOOL_LLM_ID_CREATE,
  uiGroupId: ToolUIGroupId.EditFile,
  displayName: 'Create',
  description:
    'Creates a new file on the file system with the specified content. Prefer editing existing files, unless you need to create a new file.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: createCliSchema,
  outputSchemas: {
    result: z.string().describe('The result of the create operation'),
  },
  outputTransform: (output: unknown) => {
    let filePath: string | undefined;
    let systemReminder: string | undefined;

    if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output) as {
          file_path?: string;
          systemReminder?: string;
        };
        filePath = parsed.file_path;
        systemReminder = parsed.systemReminder;
      } catch (error) {
        logWarn('Failed to parse create CLI output as JSON', { cause: error });
        return output;
      }
    } else if (typeof output === 'object' && output !== null) {
      const obj = output as { file_path?: string; systemReminder?: string };
      filePath = obj.file_path;
      systemReminder = obj.systemReminder;
    } else {
      return typeof output === 'string' ? output : JSON.stringify(output);
    }

    const message = filePath
      ? `The file ${filePath} has been created successfully.`
      : 'The file has been created successfully.';
    return systemReminder ? `${message}\n\n${systemReminder}` : message;
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.FilesystemWrite],
  toolkit: Toolkit.Base,
  isToolEnabled: ({ modelProvider }) => modelProvider !== ModelProvider.OPENAI,
});
