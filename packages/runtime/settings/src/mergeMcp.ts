import type { McpServerConfig, McpSettings } from '@industry/common/settings';

function createNullPrototypeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function mergeMcp(
  higher: McpSettings | undefined,
  lower: McpSettings | undefined
): McpSettings | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  const mergedServers = createNullPrototypeRecord<McpServerConfig>();

  for (const [name, config] of Object.entries(lower.mcpServers)) {
    if (!Object.hasOwn(higher.mcpServers, name)) {
      mergedServers[name] = config;
    }
  }

  for (const [name, config] of Object.entries(higher.mcpServers)) {
    mergedServers[name] = config;
  }

  return { mcpServers: mergedServers };
}
