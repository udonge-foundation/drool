import {
  mergeSandboxSettings,
  unionMergeArrays,
} from '@industry/utils/settings';

import type {
  CustomModelSettings,
  GeneralSettings,
  McpPolicy,
  ModelPolicy,
  SandboxSettings,
} from '@industry/common/settings';

function deepMergeObjects(
  higher: Record<string, unknown>,
  lower: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...higher };

  for (const key of Object.keys(lower)) {
    if (higher[key] === undefined) {
      result[key] = lower[key];
    }
  }

  return result;
}

function mergeModelPolicy(
  higher: ModelPolicy | undefined,
  lower: ModelPolicy | undefined
): ModelPolicy | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  return {
    // Allowlists use higher-wins: a higher-priority level's allowlist is
    // restrictive and must not be broadened by lower-priority levels.
    allowedModelIds: higher.allowedModelIds ?? lower.allowedModelIds,
    allowedBaseUrls: higher.allowedBaseUrls ?? lower.allowedBaseUrls,
    // Blocklists use union: once blocked at any level, always blocked.
    blockedModelIds: unionMergeArrays(
      higher.blockedModelIds,
      lower.blockedModelIds
    ),
    allowCustomModels: higher.allowCustomModels ?? lower.allowCustomModels,
    allowAllIndustryModels:
      higher.allowAllIndustryModels ?? lower.allowAllIndustryModels,
    allowIndustryRouterByok:
      higher.allowIndustryRouterByok ?? lower.allowIndustryRouterByok,
  };
}

function mergeMcpPolicy(
  higher: McpPolicy | undefined,
  lower: McpPolicy | undefined
): McpPolicy | undefined {
  if (!higher) return lower;
  if (!lower) return higher;

  // When a higher-priority level enforces the MCP policy, its allowlist is
  // org-authoritative: lower levels may not broaden it
  if (higher.enabled === true) {
    return { enabled: true, allowlist: higher.allowlist };
  }
  if (lower.enabled === true) {
    return { enabled: true, allowlist: lower.allowlist };
  }
  return { enabled: false, allowlist: higher.allowlist ?? lower.allowlist };
}

function mergeCustomModels(
  higher: CustomModelSettings | undefined,
  lower: CustomModelSettings | undefined
): CustomModelSettings | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  const result = [...higher];
  const existingIds = new Set(higher.map((m) => m.id));

  for (const model of lower) {
    if (!existingIds.has(model.id)) {
      result.push(model);
      existingIds.add(model.id);
    }
  }

  return result;
}

export function mergeGeneral(
  higher: GeneralSettings | undefined,
  lower: GeneralSettings | undefined
): GeneralSettings | undefined {
  if (!higher && !lower) return undefined;
  if (!higher) return lower;
  if (!lower) return higher;

  const result: GeneralSettings = { ...higher };

  for (const key of Object.keys(lower) as Array<keyof GeneralSettings>) {
    const higherValue = higher[key];
    const lowerValue = lower[key];

    if (higherValue === undefined) {
      (result as Record<string, unknown>)[key] = lowerValue;
      continue;
    }

    if (key === 'customModels') {
      result.customModels = mergeCustomModels(
        higherValue as CustomModelSettings,
        lowerValue as CustomModelSettings
      );
      continue;
    }

    if (key === 'modelPolicy') {
      result.modelPolicy = mergeModelPolicy(
        higherValue as ModelPolicy,
        lowerValue as ModelPolicy
      );
      continue;
    }

    if (key === 'mcpPolicy') {
      result.mcpPolicy = mergeMcpPolicy(
        higherValue as McpPolicy,
        lowerValue as McpPolicy
      );
      continue;
    }

    if (key === 'strictKnownMarketplaces') {
      // Org-authoritative allowlist: a higher-priority level's marketplace
      // allowlist is the ceiling and must not be broadened by lower levels.
      result.strictKnownMarketplaces =
        higherValue as GeneralSettings['strictKnownMarketplaces'];
      continue;
    }

    if (key === 'sandbox') {
      result.sandbox = mergeSandboxSettings(
        higherValue as SandboxSettings,
        lowerValue as SandboxSettings
      );
      continue;
    }

    if (key === 'modelFavorites') {
      continue;
    }

    if (Array.isArray(higherValue) && Array.isArray(lowerValue)) {
      const combined = [...(higherValue as unknown[])];
      for (const item of lowerValue as unknown[]) {
        if (!combined.includes(item)) {
          combined.push(item);
        }
      }
      (result as Record<string, unknown>)[key] = combined;
    } else if (
      typeof higherValue === 'object' &&
      higherValue !== null &&
      typeof lowerValue === 'object' &&
      lowerValue !== null &&
      !Array.isArray(higherValue)
    ) {
      (result as Record<string, unknown>)[key] = deepMergeObjects(
        higherValue as Record<string, unknown>,
        lowerValue as Record<string, unknown>
      );
    }
  }

  return result;
}
