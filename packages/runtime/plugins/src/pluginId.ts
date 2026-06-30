import { ParsedPluginId } from './types';

export function formatPluginId(
  pluginName: string,
  marketplaceName: string
): string {
  return `${pluginName}@${marketplaceName}`;
}

/**
 * Split a plugin id into its plugin name and marketplace name on the first `@`
 * at index >= 1, so a leading `@` (scoped plugin names like `@scope/name`) is
 * kept as part of the plugin name. The marketplace name is everything after the
 * separator and may itself contain `@` (marketplace names embed ref/sha pins,
 * e.g. `repo@v1.0.0`). Returns null when there is no separating `@` or the
 * marketplace component is empty.
 */
export function parsePluginId(pluginId: string): ParsedPluginId | null {
  const atIndex = pluginId.indexOf('@', 1);
  if (atIndex === -1) {
    return null;
  }
  const marketplace = pluginId.slice(atIndex + 1);
  if (!marketplace) {
    return null;
  }
  return {
    pluginId,
    pluginName: pluginId.slice(0, atIndex),
    marketplace,
  };
}
