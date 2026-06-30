import { modelRequiresExplicitOptIn } from './policy';

import type { AnnotatedModelConfig } from './types';
import type { ModelPolicy } from '@industry/common/settings';
import type { AvailableModelConfig } from '@industry/drool-sdk-ext/protocol/drool';

type Classification =
  | { kind: 'drop' }
  | { kind: 'allow' }
  | { kind: 'block'; reason: string };

type ResolvedPolicy = {
  allowed: Set<string>;
  blocked: Set<string>;
  requireExplicitOptIn: Set<string>;
  allowAllIndustry: boolean;
  allowCustomModels: boolean;
};

function resolvePolicy(policy: ModelPolicy): ResolvedPolicy {
  return {
    allowed: new Set<string>(policy.allowedModelIds ?? []),
    blocked: new Set<string>(policy.blockedModelIds ?? []),
    requireExplicitOptIn: new Set<string>(
      policy.requireExplicitOptInModelIds ?? []
    ),
    allowAllIndustry: policy.allowAllIndustryModels ?? true,
    allowCustomModels: policy.allowCustomModels ?? true,
  };
}

function classifyModel(
  model: AvailableModelConfig,
  p: ResolvedPolicy
): Classification {
  if (model.isCustom) {
    return p.allowCustomModels ? { kind: 'allow' } : { kind: 'drop' };
  }
  if (p.requireExplicitOptIn.has(model.id)) {
    return {
      kind: 'block',
      reason: 'Requires explicit organization opt-in',
    };
  }
  if (p.blocked.has(model.id)) {
    return { kind: 'block', reason: 'Disabled by admin' };
  }
  if (!p.allowAllIndustry) {
    return p.allowed.has(model.id)
      ? { kind: 'allow' }
      : { kind: 'block', reason: 'Disabled by admin' };
  }
  if (p.allowed.size > 0 && !p.allowed.has(model.id)) {
    return { kind: 'block', reason: 'Disabled by admin' };
  }
  return { kind: 'allow' };
}

function firstEnabledModel(
  models: readonly AnnotatedModelConfig[]
): AnnotatedModelConfig | undefined {
  return models.find((m) => !m.disabled);
}

/**
 * Resolve a candidate model id against an annotated model list. Returns the
 * candidate if it's present and enabled; otherwise returns the first enabled
 * model so callers never end up with a selection the backend can't route
 * (e.g. a stale persisted id, a daemon default that conflicts with org
 * policy, or an org-blocked id).
 */
export function resolveSelectableModel(
  candidateModelId: string | undefined,
  models: readonly AnnotatedModelConfig[]
): AnnotatedModelConfig | undefined {
  if (candidateModelId !== undefined) {
    const match = models.find((m) => m.id === candidateModelId);
    if (match && !match.disabled) {
      return match;
    }
  }
  return firstEnabledModel(models);
}

/**
 * Annotate available models with `disabled` / `disabledReason` based on the
 * org model policy. Models that fail `allowCustomModels` are dropped
 * entirely; industry models blocked by allow/block lists are returned with
 * `disabled: true` so the picker can render them as grayed-out. Callers
 * that want only enabled models can filter on `!m.disabled`.
 *
 * Explicit-opt-in models fail closed without a policy: opt-in approvals only
 * exist on managed-settings versions, so an org with no policy (self-serve
 * without managed settings, or a failed settings sync) cannot have approved
 * one — rendering it selectable would just 403 at serve time.
 */
export function applyModelPolicy(
  models: AvailableModelConfig[],
  policy: ModelPolicy | undefined
): AnnotatedModelConfig[] {
  if (!policy) {
    return models.map((m) =>
      modelRequiresExplicitOptIn(m.id)
        ? {
            ...m,
            disabled: true,
            disabledReason: 'Requires explicit organization opt-in',
          }
        : { ...m, disabled: false }
    );
  }
  const resolved = resolvePolicy(policy);
  const out: AnnotatedModelConfig[] = [];
  for (const model of models) {
    const c = classifyModel(model, resolved);
    if (c.kind === 'drop') continue;
    out.push(
      c.kind === 'block'
        ? { ...model, disabled: true, disabledReason: c.reason }
        : { ...model, disabled: false }
    );
  }
  return out;
}
