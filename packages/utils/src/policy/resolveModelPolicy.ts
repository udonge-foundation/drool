import type { ModelPolicy, ResolvedModelPolicy } from '@industry/common/policy';

// Accepts both the strict @industry/common/policy ModelPolicy and the lenient
// @industry/common/settings ModelPolicy (where allowCustomModels is optional).
// Everything else lines up, and raw.allowCustomModels is defaulted below.
type ParseModelPolicyInput = Omit<ModelPolicy, 'allowCustomModels'> & {
  allowCustomModels?: boolean;
};

// Interpret a raw ModelPolicy as a normalized ResolvedModelPolicy (allow-all /
// allowlist / denylist); see tests for the priority rules.
export function parseModelPolicy(
  raw: ParseModelPolicyInput | undefined
): ResolvedModelPolicy {
  const base = {
    allowCustomModels: raw?.allowCustomModels ?? true,
    allowedBaseUrls: raw?.allowedBaseUrls,
    isFastModelsAllowed: raw?.isFastModelsAllowed,
    requireExplicitOptInModelIds: raw?.requireExplicitOptInModelIds,
    allowIndustryRouterByok: raw?.allowIndustryRouterByok,
  };

  if (!raw) {
    return { kind: 'allow-all', ...base };
  }

  const allowed = raw.allowedModelIds ?? [];
  const blocked = raw.blockedModelIds ?? [];
  const requireExplicitOptInSet = new Set(
    raw.requireExplicitOptInModelIds ?? []
  );
  const explicitlyBlockedSet = new Set(
    blocked.filter((id) => !requireExplicitOptInSet.has(id))
  );

  if (raw.allowAllIndustryModels === false) {
    return {
      kind: 'allowlist',
      allowedModelIds: allowed.filter((id) => !explicitlyBlockedSet.has(id)),
      ...(blocked.length > 0 ? { blockedModelIds: blocked } : {}),
      ...base,
    };
  }

  if (allowed.length > 0) {
    return {
      kind: 'allowlist',
      allowedModelIds: allowed.filter((id) => !explicitlyBlockedSet.has(id)),
      ...(blocked.length > 0 ? { blockedModelIds: blocked } : {}),
      ...base,
    };
  }

  if (blocked.length > 0) {
    return { ...base, kind: 'denylist', blockedModelIds: blocked };
  }

  return { kind: 'allow-all', ...base };
}

// Serialize a ResolvedModelPolicy to an enforcer-compatible ModelPolicy;
// denylist must emit allowAllIndustryModels=true (false reads as "block all").
export function serializeModelPolicy(
  resolved: ResolvedModelPolicy
): ModelPolicy {
  const base = {
    allowCustomModels: resolved.allowCustomModels,
    ...(resolved.allowedBaseUrls !== undefined
      ? { allowedBaseUrls: resolved.allowedBaseUrls }
      : {}),
    ...(resolved.isFastModelsAllowed !== undefined
      ? { isFastModelsAllowed: resolved.isFastModelsAllowed }
      : {}),
    ...(resolved.requireExplicitOptInModelIds !== undefined
      ? { requireExplicitOptInModelIds: resolved.requireExplicitOptInModelIds }
      : {}),
    ...(resolved.allowIndustryRouterByok !== undefined
      ? { allowIndustryRouterByok: resolved.allowIndustryRouterByok }
      : {}),
    ...(resolved.blockedModelIds !== undefined &&
    resolved.blockedModelIds.length > 0
      ? { blockedModelIds: resolved.blockedModelIds }
      : {}),
  };

  if (resolved.kind === 'allow-all') {
    return {
      allowAllIndustryModels: true,
      ...base,
    };
  }

  if (resolved.kind === 'allowlist') {
    return {
      allowedModelIds: resolved.allowedModelIds,
      allowAllIndustryModels: false,
      ...base,
    };
  }

  return {
    blockedModelIds: resolved.blockedModelIds,
    allowAllIndustryModels: true,
    ...base,
  };
}
