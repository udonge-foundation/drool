import { z } from 'zod';

import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import {
  ToolExecutionLocation,
  TOOL_LLM_ID_APPLY_PATCH,
} from '@industry/drool-sdk-ext/protocol/tools';

import { applyPatchCliSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';
import { APPLY_PATCH_TUI_DESC } from '../constants';

export const applyPatchCliTool = createTool({
  id: 'apply-patch-cli',
  llmId: TOOL_LLM_ID_APPLY_PATCH,
  uiGroupId: ToolUIGroupId.EditFile,
  displayName: 'Apply Patch',
  description: APPLY_PATCH_TUI_DESC,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: applyPatchCliSchema,
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [
    SandboxSideEffect.FilesystemRead,
    SandboxSideEffect.FilesystemWrite,
  ],
  outputSchemas: {
    result: z.string().describe('The result of the apply patch operation'),
  },
  outputTransform: (output: unknown) => {
    // For ApplyPatch, we want to provide a simple success/failure message
    if (typeof output === 'object' && output !== null) {
      const result = output as {
        success?: boolean;
        file_path?: string;
        display_operation?: string;
        systemReminder?: string;
      };
      if (result.success === true) {
        const action =
          result.display_operation === 'create' ? 'created' : 'updated';
        const message = result.file_path
          ? `The file ${result.file_path} has been ${action} successfully.`
          : `The file has been ${action} successfully.`;
        return result.systemReminder
          ? `${message}\n\n${result.systemReminder}`
          : message;
      }
      return typeof output === 'string' ? output : JSON.stringify(output);
    }
    // Fallback to string representation if structure is unexpected
    return typeof output === 'string' ? output : JSON.stringify(output);
  },
  toolkit: Toolkit.Base,
  isToolEnabled: ({ modelProvider }) => modelProvider === ModelProvider.OPENAI,
});
