import { z } from 'zod';

import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import {
  ToolExecutionLocation,
  TOOL_LLM_ID_EDIT,
} from '@industry/drool-sdk-ext/protocol/tools';
import { logWarn } from '@industry/logging';

import { editCliSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const TOOL_DESCRIPTION = `
Edit the contents of a file by finding and replacing text.

Make sure the Read tool was called first before making edits, as this tool requires the file to be read first.
Preserve the exact indentation (tabs or spaces).
Never write a new file with this tool; prefer using Create tool for that.
'old_str' must be unique in the file, or 'change_all' must be true to replace all occurrences (for example, it's useful for variable renaming).
make sure to provide the larger 'old_str' with more surrounding context to narrow down the exact match.
`;

export const editCliTool = createTool({
  id: 'edit-cli',
  llmId: TOOL_LLM_ID_EDIT,
  uiGroupId: ToolUIGroupId.EditFile,
  displayName: 'Edit',
  description: TOOL_DESCRIPTION,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: editCliSchema,
  outputSchemas: {
    result: z.string().describe('The result of the edit operation'),
  },
  outputTransform: (output: unknown) => {
    // Transform verbose diff output to a simple success message for the LLM
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
      } catch (err) {
        // Not JSON
        logWarn('Failed to parse edit CLI output as JSON', { cause: err });
      }
    } else if (typeof output === 'object' && output !== null) {
      // Handle case where output is already an object (not stringified)
      const obj = output as { file_path?: string; systemReminder?: string };
      filePath = obj.file_path;
      systemReminder = obj.systemReminder;
    }

    const message = filePath
      ? `The file ${filePath} has been updated successfully.`
      : 'The file has been updated successfully.';
    return systemReminder ? `${message}\n\n${systemReminder}` : message;
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [
    SandboxSideEffect.FilesystemRead,
    SandboxSideEffect.FilesystemWrite,
  ],
  toolkit: Toolkit.Base,
  isToolEnabled: ({ modelProvider }) => modelProvider !== ModelProvider.OPENAI,
});
