import { ModelExplicitOptInRequirementKind } from '@industry/common/policy';
import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';

import {
  getFastModelIds,
  getLLMConfig,
  getPilotDisabledModelIds,
  resolveModelId,
} from '../../llm';
import { parseModelPolicy, serializeModelPolicy } from '../../policy';

import type {
  ModelPolicy,
  ModelExplicitOptInRequirement,
  ResolvedModelPolicy,
  UserModelPolicy,
} from '@industry/common/policy';
import type { ExplicitModelOptInApprovalChecks } from '@industry/common/settings';

function getExplicitOptInRequirement(
  modelId: string | undefined
): ModelExplicitOptInRequirement | undefined {
  const resolvedModelId = modelId ? resolveModelId(modelId) : undefined;
  return resolvedModelId
    ? getLLMConfig({ modelId: resolvedModelId }).explicitOptInRequirement
    : undefined;
}

/**
 * Whether a model carries an explicit org opt-in requirement (e.g. provider
 * data retention). Accepts a raw model string and resolves aliases before
 * checking registry metadata. Use this only to detect that a requirement
 * exists — not to decide access, which must go through model-policy
 * enforcement.
 */
export function modelRequiresExplicitOptIn(
  modelId: string | undefined
): boolean {
  return getExplicitOptInRequirement(modelId) !== undefined;
}

/**
 * Model ids blocked by server-derived gates (fast-model toggle off, unpaid
 * pilot plan) rather than by an admin-authored block. Inject sites (effective
 * policy resolution) and strip sites (persisting admin saves) MUST consume
 * this same helper so a derived block can never be persisted as a sticky
 * admin block.
 */
export function getDerivedBlockedModelIds({
  isFastModelsAllowed,
  isUnpaidEnterprise,
}: {
  isFastModelsAllowed: boolean | undefined;
  isUnpaidEnterprise: boolean;
}): ModelID[] {
  return [
    ...(isFastModelsAllowed ? [] : getFastModelIds()),
    ...(isUnpaidEnterprise ? getPilotDisabledModelIds() : []),
  ];
}

/**
 * Whether a model's explicit opt-in requirement is specifically provider data
 * retention. Use this (not {@link modelRequiresExplicitOptIn}) to decide
 * Anthropic data-retention key routing, so a future non-data-retention opt-in
 * kind does not silently route requests to the retention-enabled key.
 */
export function modelRequiresDataRetention(
  modelId: string | undefined
): boolean {
  return (
    getExplicitOptInRequirement(modelId)?.kind ===
    ModelExplicitOptInRequirementKind.DataRetention
  );
}

function explicitOptInIsApproved(
  modelId: ModelID,
  explicitModelOptIns: ExplicitModelOptInApprovalChecks | undefined
): boolean {
  const requirement = getExplicitOptInRequirement(modelId);
  if (!requirement) return true;

  return explicitModelOptIns?.[modelId]?.kind === requirement.kind;
}

/**
 * Build a synthetic approval map (requirement kind + TOS version, no
 * persisted metadata) that satisfies the explicit opt-in requirement for
 * every candidate model that carries one. For validation-only flows
 * (pre-save policy checks) and for orgs exempt from recording approvals
 * (self-serve default-allow); it must never be persisted as a real approval.
 */
export function buildExplicitOptInApprovalChecks(
  candidateModelIds: readonly ModelID[]
): ExplicitModelOptInApprovalChecks {
  const approvals: ExplicitModelOptInApprovalChecks = {};
  for (const modelId of candidateModelIds) {
    const requirement = getExplicitOptInRequirement(modelId);
    if (!requirement) continue;
    approvals[modelId] = {
      kind: requirement.kind,
      tosVersion: requirement.tosVersion,
    };
  }
  return approvals;
}

/**
 * The subset of `candidateModelIds` whose explicit opt-in requirement is
 * currently satisfied by `explicitModelOptIns` (matching requirement kind and
 * TOS version). This is the authoritative "approved" set; callers must NOT
 * infer approval from the absence of a derived `requireExplicitOptInModelIds`
 * block, which only lists models the policy would otherwise allow.
 */
export function getApprovedExplicitOptInModelIds(
  explicitModelOptIns: ExplicitModelOptInApprovalChecks | undefined,
  candidateModelIds: readonly ModelID[]
): ModelID[] {
  return candidateModelIds.filter(
    (modelId) =>
      modelRequiresExplicitOptIn(modelId) &&
      explicitOptInIsApproved(modelId, explicitModelOptIns)
  );
}

function resolvedPolicyAllowsModel(
  modelId: ModelID,
  resolved: ResolvedModelPolicy
): boolean {
  const explicitlyBlocked =
    resolved.blockedModelIds?.includes(modelId) &&
    !resolved.requireExplicitOptInModelIds?.includes(modelId);
  if (explicitlyBlocked) return false;
  if (resolved.kind === 'allow-all') return true;
  if (resolved.kind === 'allowlist') {
    return resolved.allowedModelIds.includes(modelId);
  }
  return true;
}

/**
 * Inject "blocked pending opt-in" entries for candidate models that the
 * resolved policy would otherwise allow but whose explicit opt-in requirement
 * is unapproved. Apply this to the ORG policy BEFORE per-user overrides: a
 * per-user allow override is a pilot grant that clears the pending marker
 * (see `mergeUserPolicy`), letting specific users try an opt-in model ahead
 * of the org-wide opt-in. `candidateModelIds` scopes the check to models
 * known to carry a requirement (see `getExplicitOptInRequiredModelIds`).
 * Approved candidates are dropped from both `blockedModelIds` and
 * `requireExplicitOptInModelIds`.
 */
export function applyExplicitModelOptInRequirements({
  resolved,
  explicitModelOptIns,
  candidateModelIds,
}: {
  resolved: ResolvedModelPolicy;
  explicitModelOptIns?: ExplicitModelOptInApprovalChecks;
  candidateModelIds: readonly ModelID[];
}): ResolvedModelPolicy {
  const requireExplicitOptInModelIds = candidateModelIds.filter(
    (modelId) =>
      modelRequiresExplicitOptIn(modelId) &&
      resolvedPolicyAllowsModel(modelId, resolved) &&
      !explicitOptInIsApproved(modelId, explicitModelOptIns)
  );

  if (requireExplicitOptInModelIds.length === 0) {
    const blockedModelIds = (resolved.blockedModelIds ?? []).filter(
      (modelId) => !resolved.requireExplicitOptInModelIds?.includes(modelId)
    );
    if (blockedModelIds.length === 0) {
      if (resolved.kind === 'allowlist') {
        const {
          blockedModelIds: _blockedModelIds,
          requireExplicitOptInModelIds: _requireExplicitOptInModelIds,
          ...base
        } = resolved;
        return base;
      }

      const {
        kind: _kind,
        blockedModelIds: _blockedModelIds,
        requireExplicitOptInModelIds: _requireExplicitOptInModelIds,
        ...base
      } = resolved;
      return { kind: 'allow-all', ...base };
    }

    return {
      ...resolved,
      blockedModelIds,
      requireExplicitOptInModelIds: undefined,
    };
  }

  const previousRequireExplicitOptInModelIds = new Set(
    resolved.requireExplicitOptInModelIds ?? []
  );
  const blockedModelIds = [
    ...new Set([
      ...(resolved.blockedModelIds ?? []).filter(
        (modelId) => !previousRequireExplicitOptInModelIds.has(modelId)
      ),
      ...requireExplicitOptInModelIds,
    ]),
  ];

  if (resolved.kind === 'allow-all') {
    return {
      ...resolved,
      kind: 'denylist',
      blockedModelIds,
      requireExplicitOptInModelIds,
    };
  }

  return {
    ...resolved,
    blockedModelIds,
    requireExplicitOptInModelIds,
  };
}

/**
 * Check whether a model is allowed by the policy.
 * Single source of truth for model filtering.
 */
export function isModelAllowedByPolicy(
  modelId: ModelID,
  modelPolicy: ModelPolicy
): boolean {
  try {
    const modelConfig = getLLMConfig({ modelId });
    if (modelConfig.alwaysAllowed) {
      return true;
    }
  } catch (err) {
    logWarn('Model not found in registry, continuing with policy check', {
      cause: err,
    });
  }

  const resolved = parseModelPolicy(modelPolicy);
  if (resolved.blockedModelIds?.includes(modelId)) return false;
  if (resolved.requireExplicitOptInModelIds?.includes(modelId)) return false;
  if (resolved.kind === 'allow-all') return true;
  if (resolved.kind === 'allowlist') {
    return resolved.allowedModelIds.includes(modelId);
  }
  return !resolved.blockedModelIds.includes(modelId);
}

function mergeUserPolicy(
  resolved: ResolvedModelPolicy,
  userPolicy: UserModelPolicy
): ResolvedModelPolicy {
  const userAllowed = new Set(userPolicy.allowedModelIds);
  const userBlocked = new Set(userPolicy.blockedModelIds);

  // A per-user allow is a pilot grant: it clears the model's pending
  // explicit opt-in marker so specific users can use an opt-in model before
  // the org-wide opt-in is recorded. Requires the opt-in derivation to run
  // on the ORG policy before this merge.
  const filteredRequireOptIn = resolved.requireExplicitOptInModelIds?.filter(
    (id) => !userAllowed.has(id)
  );
  const requireExplicitOptInModelIds = filteredRequireOptIn?.length
    ? filteredRequireOptIn
    : undefined;

  if (resolved.kind === 'allowlist') {
    // Org allowlist → revoke user blocks → grant user allows.
    // Preserves "blocked by default, per-user allow re-grants" invariant.
    const effectiveAllowed = new Set(resolved.allowedModelIds);
    const effectiveBlocked = new Set(resolved.blockedModelIds ?? []);
    for (const id of userBlocked) effectiveAllowed.delete(id);
    for (const id of userAllowed) {
      effectiveAllowed.add(id);
      effectiveBlocked.delete(id);
    }
    return {
      ...resolved,
      allowedModelIds: [...effectiveAllowed],
      blockedModelIds: [...effectiveBlocked],
      requireExplicitOptInModelIds,
    };
  }

  if (resolved.kind === 'denylist') {
    // Inverse: start from the org blocklist, grant what the user allows,
    // extend with what the user blocks.
    const effectiveBlocked = new Set(resolved.blockedModelIds);
    for (const id of userAllowed) effectiveBlocked.delete(id);
    for (const id of userBlocked) effectiveBlocked.add(id);
    return {
      ...resolved,
      blockedModelIds: [...effectiveBlocked],
      requireExplicitOptInModelIds,
    };
  }

  // allow-all: user blocks convert the effective policy into a denylist;
  // user allows are already covered by allow-all so contribute nothing.
  if (userBlocked.size === 0) {
    return { ...resolved, requireExplicitOptInModelIds };
  }
  return {
    kind: 'denylist',
    blockedModelIds: [...userBlocked],
    allowCustomModels: resolved.allowCustomModels,
    allowedBaseUrls: resolved.allowedBaseUrls,
    isFastModelsAllowed: resolved.isFastModelsAllowed,
    requireExplicitOptInModelIds,
    allowIndustryRouterByok: resolved.allowIndustryRouterByok,
  };
}

/**
 * Resolve effective model policy by applying per-user overrides to org policy.
 * User policy can both grant (override org block) and revoke (override org
 * allow). A user grant also clears a pending explicit opt-in marker, so pass
 * an org policy that already went through
 * `applyExplicitModelOptInRequirements` when opt-in models are in play.
 */
export function resolveEffectiveModelPolicy(
  orgPolicy: ModelPolicy,
  userPolicy: UserModelPolicy | undefined
): ModelPolicy {
  if (!userPolicy) return orgPolicy;
  return serializeModelPolicy(
    mergeUserPolicy(parseModelPolicy(orgPolicy), userPolicy)
  );
}
