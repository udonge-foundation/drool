import { useState } from 'react';

import { logException } from '@industry/logging';

import { DroolModelFallbackPicker } from '@/components/drools/DroolModelFallbackPicker';
import { useMountEffect } from '@/hooks/useMountEffect';
import { getAllowedModelIds } from '@/models/availability';
import { getDroolLoaderSingleton } from '@/services/drools/CustomDroolRegistry';
import { DroolValidator } from '@/services/drools/DroolValidator';
import { getSettingsService } from '@/services/SettingsService';

import type { DroolLocation } from '@industry/drool-sdk-ext/protocol/settings';

interface PluginDroolModelFixFlowProps {
  pluginId: string;
  /** Called once every plugin drool with an unavailable model is resolved. */
  onComplete: () => void;
}

/**
 * After a plugin is installed/updated, sequentially prompts the user to pick a
 * replacement model for each of the plugin's drools tied to a model the org
 * blocks. Completes immediately when there is nothing to fix.
 */
export function PluginDroolModelFixFlow({
  pluginId,
  onComplete,
}: PluginDroolModelFixFlowProps) {
  // Maps "${location}:${originalModel}" → drool names sharing that blocked model.
  const [drools, setDrools] = useState<Map<string, string[]> | null>(null);
  const [index, setIndex] = useState(0);

  useMountEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = getSettingsService();
        const allDrools = await getDroolLoaderSingleton().loadAllDrools();
        const allowedModels = [...getAllowedModelIds()];
        // Deduplicate by (location, originalModelId): collect all affected drool
        // names per key so the picker can show the full list in one prompt.
        const needsFix = new Map<string, string[]>();
        for (const drool of allDrools) {
          if (drool.pluginId !== pluginId) continue;
          const original = drool.metadata.model;
          const resolved = settings.resolveModelWithFallback(
            original,
            (modelId) =>
              DroolValidator.validateModel(modelId, allowedModels).valid
          );
          if (DroolValidator.validateModel(resolved, allowedModels).valid)
            continue;
          const key = `${drool.location}:${original ?? ''}`;
          const existing = needsFix.get(key);
          if (existing) {
            existing.push(drool.metadata.name);
          } else {
            needsFix.set(key, [drool.metadata.name]);
          }
        }
        if (cancelled) return;
        if (needsFix.size === 0) {
          onComplete();
          return;
        }
        setDrools(needsFix);
      } catch (err) {
        logException(err, 'Failed to load plugin drools for model fix');
        if (!cancelled) onComplete();
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  if (!drools) {
    return null;
  }

  const entries = Array.from(drools.entries());
  const [currentKey, currentNames] = entries[index];
  // Key format is "${location}:${originalModel}"; DroolLocation values
  // ("project" / "personal") contain no colons so the first segment is safe.
  const colonIdx = currentKey.indexOf(':');
  const location = currentKey.slice(0, colonIdx) as DroolLocation;
  const originalModel = currentKey.slice(colonIdx + 1);

  // Completion is event-driven: advancing past the last entry calls onComplete
  // rather than tracking an out-of-range index in an effect.
  const advance = () => {
    if (index >= drools.size - 1) {
      onComplete();
    } else {
      setIndex((prev) => prev + 1);
    }
  };

  return (
    <DroolModelFallbackPicker
      key={currentKey}
      droolNames={currentNames}
      originalModelId={originalModel}
      droolLocation={location}
      onComplete={advance}
      onCancel={advance}
    />
  );
}
