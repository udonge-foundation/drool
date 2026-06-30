import { z } from 'zod';

import {
  ToolExecutionLocation,
  TOOL_LLM_ID_LS,
} from '@industry/drool-sdk-ext/protocol/tools';

import { lsCliSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const LS_CLI_DESCRIPTION = `List the contents of a directory with optional pattern-based filtering.
Prefer usage of 'Grep' and 'Glob' tools, for more targeted searches.
Supports ignore patterns to exclude unwanted files and directories.
Requires absolute directory paths when specified.`;

export const lsCliTool = createTool({
  id: 'ls-cli',
  llmId: TOOL_LLM_ID_LS,
  uiGroupId: ToolUIGroupId.ViewFolder,
  displayName: 'List Directory',
  description: LS_CLI_DESCRIPTION,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: lsCliSchema,
  outputSchemas: {
    result: z
      .string()
      .describe(
        'The list of files and directories, one per line (similar to ripgrep output)'
      ),
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  // The executor shells out to a fixed, read-only `ls`/PowerShell command
  // scoped to the requested directory. The command is fully controlled by the
  // CLI (never the model), so the only model-relevant effect is the filesystem
  // read; the subprocess is an implementation detail and is not a Process side
  // effect.
  sideEffects: [SandboxSideEffect.FilesystemRead],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
