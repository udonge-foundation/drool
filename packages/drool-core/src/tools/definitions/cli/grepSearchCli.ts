import {
  ToolExecutionLocation,
  TOOL_LLM_ID_GREP,
} from '@industry/drool-sdk-ext/protocol/tools';

import { grepSearchCliToolSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';
import { searchToolResultSchema } from '../schema';

export const grepSearchCliTool = createTool({
  id: 'grep_tool_cli',
  llmId: TOOL_LLM_ID_GREP,
  uiGroupId: ToolUIGroupId.GrepTool,
  displayName: 'Grep',
  description: `High-performance file content search using ripgrep. Wrapper around ripgrep with comprehensive parameter support.

Supports ripgrep parameters:
- Pattern matching with regex support
- File type filtering (--type js, --type py, etc.)
- Glob pattern filtering (--glob "*.js")
- Case-insensitive search (-i)
- Context lines (-A, -B, -C for after/before/around context)
- Line numbers (-n)
- Multiline mode (-U --multiline-dotall)
- Custom search directories

Output modes:
- file_paths: Returns only matching file paths (default, fast)
- content: Returns matching lines with optional context, line numbers, and formatting

PERFORMANCE TIP: When exploring codebases or searching for patterns, make multiple speculative Grep tool calls in a single response to speed up the discovery phase. For example, search for different patterns, file types, or directories simultaneously.

Returns search results based on the selected output mode.`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: grepSearchCliToolSchema,
  outputSchemas: {
    result: searchToolResultSchema,
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  // The executor runs a fixed, read-only embedded-ripgrep command scoped to
  // the requested path. The command is fully controlled by the CLI (never the
  // model), so the only model-relevant effect is the filesystem read; the
  // subprocess is an implementation detail and is not a Process side effect.
  sideEffects: [SandboxSideEffect.FilesystemRead],
  toolkit: Toolkit.CodeSearch,
  isToolEnabled: true,
});
