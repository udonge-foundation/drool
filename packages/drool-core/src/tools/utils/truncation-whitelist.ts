import {
  DEFAULT_OUTPUT_TRUNCATION_THRESHOLD,
  TASK_OUTPUT_TRUNCATION_THRESHOLD,
} from './constants';

// Whitelist of tool IDs that should use framework-level truncation
// Tools not in this list will bypass truncation (e.g., tools with specialized truncation)
const TRUNCATION_WHITELIST = new Set([
  'grep_tool_cli',
  'web_search',
  'fetch_url',
  'ls-cli',
  'execute-cli',
  'task-cli',
  'task-output-cli',
  // Connector tool payloads are arbitrary third-party API responses, so they
  // need the same bounded-output handling as MCP tools.
  'ConnectorSearch',
]);

const TASK_OUTPUT_TRUNCATION_TOOL_IDS = new Set([
  'task-cli',
  'task-output-cli',
]);

/**
 * Checks if a tool should use framework-level truncation based on whitelist.
 * MCP tools (with IDs starting with 'mcp_') are also included.
 */
export function shouldTruncateToolOutput(toolId: string): boolean {
  // Check explicit whitelist first
  if (TRUNCATION_WHITELIST.has(toolId)) return true;

  // All MCP tools should use framework truncation
  if (toolId.startsWith('mcp_')) return true;

  return false;
}

export function getOutputTruncationThresholdForTool(toolId: string): number {
  if (TASK_OUTPUT_TRUNCATION_TOOL_IDS.has(toolId)) {
    return TASK_OUTPUT_TRUNCATION_THRESHOLD;
  }

  return DEFAULT_OUTPUT_TRUNCATION_THRESHOLD;
}
