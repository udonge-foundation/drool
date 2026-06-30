const UNGROUPED_CONNECTOR = 'other';

/**
 * Connector slug from a fully-qualified connector tool name
 * ("github__list_pull_requests" -> "github"). Returns `fallback` when the name
 * has no "__" separator; callers pass an explicit fallback so the no-separator
 * case is a single intentional decision rather than divergent per-copy behavior.
 */
export function connectorOf(
  toolName: string,
  fallback: string = UNGROUPED_CONNECTOR
): string {
  const separatorIndex = toolName.indexOf('__');
  return separatorIndex > 0 ? toolName.slice(0, separatorIndex) : fallback;
}

/** "github__list_pull_requests" -> "github / list pull requests" */
export function friendlyToolName(toolName: string): string {
  if (!toolName) {
    return '';
  }
  const separatorIndex = toolName.indexOf('__');
  if (separatorIndex <= 0) {
    return toolName.replace(/_/g, ' ');
  }
  const connector = toolName.slice(0, separatorIndex);
  const tool = toolName.slice(separatorIndex + 2).replace(/_/g, ' ');
  return `${connector} / ${tool}`;
}
