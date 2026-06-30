import { z } from 'zod';

import {
  ToolExecutionLocation,
  TOOL_LLM_ID_READ,
} from '@industry/drool-sdk-ext/protocol/tools';

import { readCliSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const READ_CLI_DESCRIPTION = `Read the contents of a file. By default, reads the entire file, but for large text files,
results are truncated to the first 2400 lines to preserve token usage. Use offset and limit parameters
to read specific portions of huge files when needed. Requires absolute file paths.
For image files (JPEG, PNG) up to 5MB, returns the actual image content that you can view and analyze directly.
Use image_quality="high" for higher fidelity image reading (~1MB, 2048px) when details matter.
For PDF files up to 3MB, returns the document content that you can view and analyze directly.`;

export const readCliTool = createTool({
  id: 'read-cli',
  llmId: TOOL_LLM_ID_READ,
  uiGroupId: ToolUIGroupId.ViewFile,
  displayName: 'Read',
  description: READ_CLI_DESCRIPTION,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: readCliSchema,
  outputSchemas: {
    // Implementation returns: string | Array<TextBlock | ImageBlock | DocumentBlock>
    result: z
      .union([
        z.string(), // Text files return a string
        z.array(
          z.object({
            type: z.enum(['text', 'image', 'document']),
            // Text block fields
            text: z.string().optional(),
            // Image/Document block fields
            source: z
              .object({
                type: z.literal('base64'),
                media_type: z.string(),
                data: z.string(),
                name: z.string().optional(),
              })
              .optional(),
            // Optional fields for caching
            cache_control: z
              .object({
                type: z.literal('ephemeral'),
              })
              .nullable()
              .optional(),
          })
        ), // Images/PDFs return an array of content blocks
      ])
      .describe(
        'The contents of the file. For text files: the text content (might be truncated for large files with system notification). For images: an array of content blocks containing text description and base64-encoded image data. For PDFs: an array containing text description and base64-encoded document data.'
      ),
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.FilesystemRead],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
