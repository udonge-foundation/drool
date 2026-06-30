import {
  BlobResourceContents,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import { sanitizeToolNameForProvider } from '@industry/drool-core/llms/client/tool-call-ids';

export function isTextResourceContents(
  content: TextResourceContents | BlobResourceContents
): content is TextResourceContents {
  return (content as TextResourceContents).text !== undefined;
}

/**
 * Format a tool name with server prefix using the standard separator
 * @param serverName The name of the server
 * @param toolName The name of the tool
 * @returns The formatted tool name with server prefix
 */
export function formatToolName(serverName: string, toolName: string): string {
  return sanitizeToolNameForProvider(`${serverName}___${toolName}`);
}
