import { z } from 'zod';

import {
  ToolExecutionLocation,
  TOOL_LLM_ID_GLOB,
} from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';
import { searchToolResultSchema } from '../schema';

export const globSearchCliToolSchema = z.object({
  patterns: z
    .union([z.string(), z.array(z.string())])
    .describe(
      'A glob pattern string or array of glob patterns to match file paths. Examples: "*.js", ["*.js", "*.ts"] for JavaScript and TypeScript files, ["src/**/*.tsx"] for React components in src, ["**/*.test.*"] for all test files.'
    ),
  excludePatterns: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'A glob pattern string or array of glob patterns to exclude from results. Example: "node_modules/**", ["node_modules/**", "dist/**", "*.min.js"]'
    ),
  folder: z
    .string()
    .optional()
    .describe(
      'Absolute path to the directory to search in. If not specified, searches in the current working directory.'
    ),
});

export const globSearchCliTool = createTool({
  id: 'glob-search-cli',
  llmId: TOOL_LLM_ID_GLOB,
  uiGroupId: ToolUIGroupId.GlobTool,
  displayName: 'Glob',
  description: `Advanced file path search using glob patterns with multiple pattern support and exclusions.
Uses ripgrep for high-performance file pattern matching.
Supports:
- Multiple inclusion patterns (OR logic)
- Exclusion patterns to filter out unwanted files
Common patterns:
- "*.ext" - all files with extension
- "**/*.ext" - all files with extension in any subdirectory
- "dir/**/*" - all files under directory
- "{*.js,*.ts}" - multiple extensions
- "!node_modules/**" - exclude pattern

PERFORMANCE TIP: When exploring codebases or discovering files for a task, make multiple speculative Glob tool calls in a single response to speed up the discovery phase. For example, search for different file types or directories that might be relevant to your task simultaneously.

Returns a list of matched file paths.

Never use 'glob' cli command directly via Execute tool, use this Glob tool instead. It's optimized for performance and handles multiple patterns and exclusions.`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: globSearchCliToolSchema,
  outputSchemas: {
    result: searchToolResultSchema,
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  toolkit: Toolkit.CodeSearch,
  // The executor runs a fixed, read-only embedded-ripgrep command scoped to
  // the requested folder. The command is fully controlled by the CLI (never
  // the model), so the only model-relevant effect is the filesystem read; the
  // subprocess is an implementation detail and is not a Process side effect.
  sideEffects: [SandboxSideEffect.FilesystemRead],
  isToolEnabled: true,
});
