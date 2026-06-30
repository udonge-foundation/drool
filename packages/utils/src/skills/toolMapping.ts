/**
 * Mapping from Claude Code tool names to Drool tool names.
 * Based on: https://docs.anthropic.com/en/docs/build-with-claude/claude-code/tools
 */
const CLAUDE_CODE_TO_DROOL_TOOL_MAP: Record<string, string> = {
  Bash: 'Execute',
  Edit: 'Edit',
  Glob: 'Glob',
  Grep: 'Grep',
  NotebookEdit: 'NotebookEdit',
  NotebookRead: 'NotebookRead',
  Read: 'Read',
  SlashCommand: 'SlashCommand',
  Task: 'Task',
  TodoWrite: 'TodoWrite',
  WebFetch: 'FetchUrl',
  WebSearch: 'WebSearch',
  Write: 'Create',
};

/**
 * Map a single Claude Code tool name to Drool tool name.
 * Returns the original name if no mapping exists.
 */
function mapClaudeCodeTool(claudeTool: string): string {
  return CLAUDE_CODE_TO_DROOL_TOOL_MAP[claudeTool] || claudeTool;
}

/**
 * Map an array of Claude Code tool names to Drool tool names.
 */
export function mapClaudeCodeTools(claudeTools: string[]): string[] {
  return claudeTools.map(mapClaudeCodeTool);
}

/**
 * Map tools from a comma-separated string (Claude Code format).
 * Returns mapped tools as array.
 */
export function mapClaudeCodeToolsString(toolsString: string): string[] {
  const tools = toolsString
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return mapClaudeCodeTools(tools);
}
