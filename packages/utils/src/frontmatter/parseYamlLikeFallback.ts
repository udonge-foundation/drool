import { logWarn } from '@industry/logging';

/**
 * Simple line-by-line YAML-like parser for frontmatter.
 * Used as fallback when js-yaml fails on complex/malformed YAML.
 * Handles descriptions with unquoted special characters like colons.
 */
export function parseYamlLikeFallback(
  content: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  const listKeys = new Set(['tools', 'mcpServers']);
  let currentListKey: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentListKey && trimmed.startsWith('- ')) {
      let item = trimmed.slice(2).trim();
      if (
        (item.startsWith('"') && item.endsWith('"')) ||
        (item.startsWith("'") && item.endsWith("'"))
      ) {
        item = item.slice(1, -1);
      }
      (result[currentListKey] as string[]).push(item);
      continue;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.substring(0, colonIndex).trim();
    let value: string = trimmed.substring(colonIndex + 1).trim();
    currentListKey = undefined;

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Try to parse arrays/objects as JSON
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        result[key] = JSON.parse(value);
        continue;
      } catch (err) {
        logWarn('Failed to parse JSON value in frontmatter', { cause: err });
      }
    }

    // Handle booleans
    if (value === 'true') {
      result[key] = true;
      continue;
    }
    if (value === 'false') {
      result[key] = false;
      continue;
    }

    if (listKeys.has(key) && !value) {
      result[key] = [];
      currentListKey = key;
      continue;
    }

    // Handle compact array values for list fields.
    if (listKeys.has(key) && !value.startsWith('[')) {
      result[key] = value.split(',').map((s) => s.trim());
      continue;
    }

    result[key] = value;
  }

  return result;
}
