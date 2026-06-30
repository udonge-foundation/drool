import { getTUIToolRegistry } from '@/tools/registry';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

/**
 * Resolves the display name for a tool given its llmId.
 * This function looks up the tool in the registry and returns its displayName,
 * falling back to the llmId if the tool is not found.
 * For MCP tools (containing "___"), formats as "SERVER: Tool name".
 * MCP-derived names are sanitized to prevent terminal control sequence injection.
 */
export function getDisplayNameForTool(toolLlmId: string): string {
  if (toolLlmId.includes('___')) {
    const [serverName, ...rest] = toolLlmId.split('___');
    const actualToolName = rest.join('___');
    if (serverName && actualToolName) {
      const sanitizedServer = sanitizeTerminalDisplayText(serverName);
      const sanitizedTool = sanitizeTerminalDisplayText(actualToolName);
      return `${sanitizedServer.toUpperCase()}: ${sanitizedTool}`;
    }
  }

  const registry = getTUIToolRegistry();
  const tool = registry.getToolByLlmId(toolLlmId);
  return tool?.displayName || toolLlmId;
}
