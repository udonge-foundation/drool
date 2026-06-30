import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { SUPPORTED_IMAGE_TYPES } from '@industry/drool-core/tools/definitions/cli/constants';
import {
  TextBlock,
  ImageBlock,
  MessageContentBlockType,
} from '@industry/drool-sdk-ext/protocol/sessionV2';

import { ToolResultContent } from '@/hooks/types';

type FormatMcpResultOptions = {
  serverName?: string;
  toolName?: string;
};

const OUTPUT_SCHEMA_VALIDATION_MARKERS = [
  "Structured content does not match the tool's output schema",
  'Failed to validate structured content',
  'has an output schema but did not return structured content',
];

const formatSchemaValidationError = (
  errorText: string,
  options?: FormatMcpResultOptions
): string | null => {
  if (
    !OUTPUT_SCHEMA_VALIDATION_MARKERS.some((marker) =>
      errorText.includes(marker)
    )
  ) {
    return null;
  }

  const toolLabel =
    options?.serverName && options?.toolName
      ? `MCP tool ${options.serverName}/${options.toolName}`
      : 'MCP tool';

  return `${toolLabel} returned structured output that does not match its output schema. Contact the MCP server owner to fix the schema or response.`;
};

/**
 * Formats a JSON string with 2-space indentation
 */
function formatJsonString(str: string): string {
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return str;
  }
}
/**
 * Formats MCP tool results for display by extracting content from the MCP protocol structure.
 * Returns structured content blocks (text and images) that can be sent to the LLM.
 */

export function formatMcpResult(
  result: CallToolResult,
  options?: FormatMcpResultOptions
): ToolResultContent {
  // Handle error results
  if (result.isError) {
    const errorContent = result.content?.[0];
    if (errorContent?.type === 'text') {
      const schemaError = formatSchemaValidationError(
        errorContent.text,
        options
      );
      const errorText = schemaError ?? errorContent.text;
      return `Error: ${errorText}`;
    }
    return 'Error: Unknown error occurred';
  }

  // Handle empty or missing content
  if (!result.content || result.content.length === 0) {
    return '[No content returned]';
  }

  const contentBlocks: Array<TextBlock | ImageBlock> = [];
  const textParts: string[] = [];

  // Process each content block
  result.content.forEach((block) => {
    switch (block.type) {
      case 'text':
        textParts.push(formatJsonString(block.text));
        break;

      case 'image': {
        // Flush any accumulated text before adding image
        if (textParts.length > 0) {
          contentBlocks.push({
            type: MessageContentBlockType.Text,
            text: textParts.join('\n'),
          });
          textParts.length = 0;
        }

        // Validate image mime type
        const mimeType = block.mimeType as string;
        if (
          !SUPPORTED_IMAGE_TYPES.includes(
            mimeType as (typeof SUPPORTED_IMAGE_TYPES)[number]
          )
        ) {
          textParts.push(
            `[Unsupported image format: ${mimeType}. Supported: ${SUPPORTED_IMAGE_TYPES.join(', ')}]`
          );
          break;
        }

        // Add image block with base64 data
        contentBlocks.push({
          type: MessageContentBlockType.Image,
          source: {
            type: 'base64',
            mediaType: mimeType as (typeof SUPPORTED_IMAGE_TYPES)[number],
            data: block.data,
          },
        });
        break;
      }

      case 'resource':
        if ('text' in block.resource && block.resource.text) {
          const resourceText = block.resource.text;
          if (typeof resourceText === 'string') {
            textParts.push(formatJsonString(resourceText));
          } else {
            textParts.push(String(resourceText));
          }
        } else {
          textParts.push(
            `[Embedded Resource: ${block.resource.mimeType ?? 'unknown type'}]`
          );
        }
        break;

      case 'audio':
        textParts.push(`[Audio: ${block.mimeType}]`);
        break;

      default:
        textParts.push(
          `[Unknown content type: ${(block as { type: string }).type}]`
        );
    }
  });

  // Flush any remaining text
  if (textParts.length > 0) {
    contentBlocks.push({
      type: MessageContentBlockType.Text,
      text: textParts.join('\n'),
    });
  }

  // If we only have one text block, return it as a string for backward compatibility
  if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
    return (contentBlocks[0] as TextBlock).text;
  }

  // Return structured content blocks
  return contentBlocks;
}
