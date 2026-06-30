import { useMemo } from 'react';

import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';

import { useAvailableModels } from '@/models/availability';
import { getSettingsService } from '@/services/SettingsService';

/**
 * Return custom model ids in the form `custom:<displayName>-<index>` from settings
 * Example: ["custom:glm-4p6-0", "custom:My-Model-1"]
 */
export function listCustomModelIds(): string[] {
  const models = getSettingsService().getCustomModels();
  return Array.isArray(models) ? models.map((m) => m.id) : [];
}

/**
 * React hook: returns all model ids visible to the user in TUI flows
 * ['inherit', ...built-ins (feature-flag filtered), ...customs]
 */
export function useAllModelIds(): (ModelID | string | 'inherit')[] {
  const builtins = useAvailableModels();
  const customs = useMemo(() => listCustomModelIds(), []);
  return useMemo(
    () => ['inherit', ...builtins, ...customs],
    [builtins, customs]
  );
}
