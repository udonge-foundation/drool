import { fetch } from '@industry/drool-core/api/fetch';
import { BillingPool, type ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import { logException, logWarn } from '@industry/logging';
import { getModel, resolvePreferredModels } from '@industry/utils/llm';

import { getIndustryApiConfig } from '@/api/config';
import type { TokenLimitChoice as FullTokenLimitChoice } from '@/core/types';
import { getEnv } from '@/environment';
import { getI18n } from '@/i18n';
import { getAvailableModelsForExec } from '@/models/availability';
import { TokenLimitAction } from '@/services/enums';
import { getSessionService } from '@/services/SessionService';

/* eslint-disable industry/types-file-organization */

export type TokenLimitChoice = FullTokenLimitChoice;

export type TokenLimitResult =
  | { type: 'choice'; choice: TokenLimitChoice }
  | { type: 'message'; message: string };

export type OveragePreferenceStatus =
  | { type: 'set'; value: 'droolCore' | 'extraUsage' }
  | { type: 'not-set' }
  | { type: 'not-applicable' }
  | { type: 'network-error' }
  | { type: 'error' };

interface ApiBucketData {
  usedPercent: number;
  windowStart: string | null;
  windowEnd: string | null;
}

interface ApiPoolData {
  fiveHour: ApiBucketData;
  weekly: ApiBucketData;
  monthly: ApiBucketData;
}

interface ApiLimitsResponse {
  usesTokenRateLimitsBilling: boolean;
  limits?: {
    standard: ApiPoolData;
    core: ApiPoolData;
  };
  extraUsageBalanceCents?: number;
  overagePreference?: 'droolCore' | 'extraUsage' | null;
  extraUsageAllowed?: boolean;
}

export type BillingLimitsFetchResult =
  | { type: 'ok'; data: ApiLimitsResponse }
  | { type: 'http-error'; status: number }
  | { type: 'network-error' };

/* eslint-enable industry/types-file-organization */

/**
 * Centralized raw fetcher for `/api/billing/limits`. All CLI callers should
 * go through this so the endpoint URL, request shape, and error handling
 * live in exactly one place. Higher-level helpers (`fetchTokenLimits`,
 * `fetchOveragePreferenceStatus`) and pure derivers (`deriveTokenLimitChoice`,
 * `deriveOveragePreferenceStatus`) are built on top.
 *
 * Hot-path callers (e.g. AgentLoop) should call this ONCE per turn and pass
 * the result to the appropriate deriver(s) instead of refetching.
 */
export async function fetchBillingLimitsRaw(): Promise<BillingLimitsFetchResult> {
  const apiConfig = getIndustryApiConfig();

  try {
    const response = await fetch(
      '/api/billing/limits',
      { method: 'GET' },
      apiConfig
    );

    if (!response.ok) {
      return { type: 'http-error', status: response.status };
    }

    const data = (await response.json()) as ApiLimitsResponse;
    return { type: 'ok', data };
  } catch (err) {
    logException(err, 'Failed to fetch billing limits');
    return { type: 'network-error' };
  }
}

/**
 * Pure(-ish) deriver: maps a pre-fetched billing-limits result into the
 * `TokenLimitResult` shape consumed by the `/limits` UI and the 402-fallback
 * snapshot logic. Async only because it resolves available models.
 *
 * Callers that already hold a `BillingLimitsFetchResult` (e.g. AgentLoop's
 * mission gate) should use this instead of `fetchTokenLimits` to avoid
 * a duplicate HTTP call.
 */
export async function deriveTokenLimitChoice(
  result: BillingLimitsFetchResult
): Promise<TokenLimitResult> {
  if (result.type !== 'ok') {
    return {
      type: 'message',
      message: getI18n().t('common:appMessages.unableToFetchLimits'),
    };
  }

  const data = result.data;

  if (!data.usesTokenRateLimitsBilling) {
    return {
      type: 'message',
      message: getI18n().t('common:appMessages.legacyBillingModel'),
    };
  }

  const standardLimits = data.limits?.standard;
  if (!standardLimits) {
    logWarn('TokenLimitService: limits.standard missing from API response');
    return {
      type: 'message',
      message: getI18n().t('common:appMessages.unableToFetchLimits'),
    };
  }

  const extraUsageBalanceCents = data.extraUsageBalanceCents ?? 0;

  const isStandardExhausted =
    standardLimits.fiveHour.usedPercent >= 100 ||
    standardLimits.weekly.usedPercent >= 100 ||
    standardLimits.monthly.usedPercent >= 100;

  const userActionRequired: TokenLimitChoice['userActionRequired'] =
    isStandardExhausted
      ? extraUsageBalanceCents > 0
        ? 'standard-exhausted'
        : 'out-of-credits'
      : 'info-only';

  const availableModels = await getAvailableModelsForExec();
  const resolvedPreferred = resolvePreferredModels(new Set(availableModels));
  const recommendedCoreModel = resolvedPreferred.find((id) => {
    const config = getModel(id);
    return config.billingPool === BillingPool.Core;
  });

  const currentModelId = getSessionService().getModel();
  let isCurrentModelCore = false;
  try {
    const currentConfig = getModel(currentModelId as ModelID);
    isCurrentModelCore = currentConfig.billingPool === BillingPool.Core;
  } catch {
    // Custom or unknown model — not core
  }

  return {
    type: 'choice',
    choice: {
      userActionRequired,
      originalMessage: isStandardExhausted
        ? getI18n().t('common:appMessages.standardLimitsExhausted')
        : '',
      overageCreditBalance: 0,
      recommendedCoreModel,
      limitsData: data.limits,
      extraUsageBalanceCents,
      overagePreference: data.overagePreference ?? null,
      extraUsageAllowed: data.extraUsageAllowed === true,
      isCurrentModelCore,
    },
  };
}

export async function fetchTokenLimits(): Promise<TokenLimitResult> {
  const result = await fetchBillingLimitsRaw();
  return deriveTokenLimitChoice(result);
}

/**
 * Pure deriver: maps a pre-fetched billing-limits result into the
 * mission-gate status. Use this when a caller already holds a
 * `BillingLimitsFetchResult` to avoid a duplicate HTTP call.
 */
export function deriveOveragePreferenceStatus(
  result: BillingLimitsFetchResult
): OveragePreferenceStatus {
  if (result.type === 'http-error') {
    logWarn(
      'TokenLimitService: overage preference probe returned non-ok status',
      { statusCode: result.status }
    );
    return { type: 'error' };
  }
  if (result.type === 'network-error') {
    logWarn('TokenLimitService: overage preference probe failed to connect');
    return { type: 'network-error' };
  }

  const data = result.data;

  if (!data.usesTokenRateLimitsBilling) {
    return { type: 'not-applicable' };
  }

  if (
    data.overagePreference === 'droolCore' ||
    data.overagePreference === 'extraUsage'
  ) {
    return { type: 'set', value: data.overagePreference };
  }

  return { type: 'not-set' };
}

/**
 * Lightweight billing-limits probe used by the mission-access gate.
 * Returns a discriminated status describing whether the org has chosen
 * an overagePreference, doesn't need one (legacy billing), or whether
 * the probe itself failed.
 */
export async function fetchOveragePreferenceStatus(): Promise<OveragePreferenceStatus> {
  const result = await fetchBillingLimitsRaw();
  return deriveOveragePreferenceStatus(result);
}

export async function handleTokenLimitAction(
  action: TokenLimitAction,
  options?: {
    recommendedCoreModel?: string;
    onMessage?: (message: string) => void;
  }
): Promise<string> {
  const t = getI18n().t;

  if (action === TokenLimitAction.Cancel) {
    return t('common:appMessages.tokenLimitCancelled');
  }

  if (action === TokenLimitAction.OpenBilling) {
    const usageUrl = `${getEnv().appBaseUrl}/settings/usage`;
    void import('open')
      .then((open) => open.default(usageUrl))
      .catch(() => {
        options?.onMessage?.(
          t('common:appMessages.couldNotOpenBrowser', { url: usageUrl })
        );
      });
    return t('common:appMessages.openingBillingPage', { url: usageUrl });
  }

  const apiConfig = getIndustryApiConfig();
  try {
    const response = await fetch(
      '/api/organization/subscription/set-overage-preference',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overagePreference: action }),
      },
      apiConfig
    );
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const errorMessage =
        (errorBody as { message?: string }).message ||
        `HTTP ${response.status}`;
      logWarn(
        'TokenLimitService: Failed to update overage preference (HTTP error)',
        {
          statusCode: response.status,
          error: errorMessage,
        }
      );
      return t('common:appMessages.failedToUpdatePreference', {
        message: errorMessage,
      });
    }
  } catch (err) {
    logWarn(
      'TokenLimitService: Failed to update overage preference (network error)',
      {
        cause: err,
      }
    );
    return t('common:appMessages.failedToUpdatePreferenceRetry');
  }

  if (action === TokenLimitAction.DroolCore) {
    if (options?.recommendedCoreModel) {
      getSessionService().setModel(options.recommendedCoreModel);
      return t('common:appMessages.switchedToDroolCore', {
        model: options.recommendedCoreModel,
      });
    }
    return t('common:appMessages.switchToDroolCoreGeneric');
  }

  return t('common:appMessages.usingExtraUsage');
}
