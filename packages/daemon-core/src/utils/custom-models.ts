import {
  type DaemonCustomModelSummary,
  type DaemonDeleteCustomModelRequestParams,
  type DaemonDeleteCustomModelResult,
  type DaemonListCustomModelsResult,
  type DaemonUpsertCustomModelRequestParams,
  type DaemonUpsertCustomModelResult,
} from '@industry/common/daemon';
import { type ModelPolicy } from '@industry/common/settings';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  isObjectRecord,
  mergeHierarchyWithChain,
  parseCustomModelProvider,
  parseCustomModelsFromSettings,
  SettingsManager,
} from '@industry/runtime/settings';
import { getProcessEnvironment } from '@industry/utils/environment';
import {
  getCustomModelPolicyBaseUrl,
  isCustomModelBaseUrlAllowed,
} from '@industry/utils/models';

const ENV_VAR_REFERENCE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * Display-safe mask for a stored API key. Env var references (`${VAR}`) are
 * returned verbatim since they name a variable rather than contain a secret;
 * literal keys are masked down to their last 4 characters.
 */
function maskApiKey(apiKey: string): string {
  if (ENV_VAR_REFERENCE_PATTERN.test(apiKey)) {
    return apiKey;
  }
  if (apiKey.length > 8) {
    return `••••${apiKey.slice(-4)}`;
  }
  return '••••';
}

function parseSingleCustomModel(entry: unknown) {
  if (!isObjectRecord(entry)) return undefined;
  try {
    const parsed = parseCustomModelsFromSettings([entry]) ?? [];
    return parsed.length === 1 ? parsed[0] : undefined;
  } catch (error) {
    logWarn('Failed to parse custom model settings entry', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

function buildSummaries(rawModels: unknown[]): DaemonCustomModelSummary[] {
  return rawModels.map((entry, rawIndex) => {
    const record = isObjectRecord(entry) ? entry : {};
    const apiKey = typeof record.apiKey === 'string' ? record.apiKey : '';
    return {
      rawIndex,
      model: typeof record.model === 'string' ? record.model : '',
      displayName:
        typeof record.displayName === 'string' ? record.displayName : undefined,
      provider: typeof record.provider === 'string' ? record.provider : '',
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : undefined,
      hasApiKey: apiKey.length > 0,
      apiKeyMask: apiKey.length > 0 ? maskApiKey(apiKey) : undefined,
      maxOutputTokens:
        typeof record.maxOutputTokens === 'number'
          ? record.maxOutputTokens
          : undefined,
      noImageSupport:
        typeof record.noImageSupport === 'boolean'
          ? record.noImageSupport
          : undefined,
      hasBedrockConfig: isObjectRecord(record.bedrock),
      isValid: parseSingleCustomModel(entry) !== undefined,
    };
  });
}

function getRawCustomModels(raw: Record<string, unknown>): unknown[] {
  return Array.isArray(raw.customModels) ? [...raw.customModels] : [];
}

async function readRawCustomModels(
  settingsManager: SettingsManager
): Promise<unknown[]> {
  return getRawCustomModels(await settingsManager.readUserSettingsJsonRaw());
}

async function getOrgModelPolicy(
  settingsManager: SettingsManager
): Promise<ModelPolicy | undefined> {
  const hierarchy = await settingsManager.getSettingsHierarchyWithAttribution();
  const { settings } = mergeHierarchyWithChain(hierarchy);
  return settings.general?.modelPolicy;
}

function assertWriteAllowedByPolicy(
  policy: ModelPolicy | undefined,
  baseUrl: string | undefined
): void {
  if (policy?.allowCustomModels === false) {
    throw new MetaError(
      'Custom models are disabled by your organization policy'
    );
  }
  if (
    baseUrl &&
    policy?.allowedBaseUrls &&
    policy.allowedBaseUrls.length > 0 &&
    !isCustomModelBaseUrlAllowed(baseUrl, policy.allowedBaseUrls)
  ) {
    throw new MetaError('Base URL is not allowed by your organization policy');
  }
}

/**
 * Looks up the raw entry at rawIndex, enforcing the expectedModel
 * concurrency guard with the same normalization buildSummaries uses
 * (a missing/non-string `model` compares as ''). Malformed non-object rows
 * are returned as an empty record so invalid entries listed in the UI can
 * still be repaired or deleted instead of being stuck behind an error.
 */
function getMatchingEntry(
  rawModels: unknown[],
  rawIndex: number,
  expectedModel: string | undefined
): Record<string, unknown> {
  if (rawIndex < 0 || rawIndex >= rawModels.length) {
    throw new MetaError('Custom model entry not found');
  }
  const existing = rawModels[rawIndex];
  const record = isObjectRecord(existing) ? existing : {};
  const currentModel = typeof record.model === 'string' ? record.model : '';
  if (expectedModel !== undefined && currentModel !== expectedModel) {
    throw new MetaError('Custom models changed on disk; refresh and try again');
  }
  return record;
}

/**
 * Lists the `customModels` entries from the raw user-level settings.json
 * with API keys redacted. Entries from other settings levels (project,
 * legacy config.json) are intentionally excluded: this surface manages only
 * the user file the desktop app can safely write to.
 */
export async function listCustomModels(): Promise<DaemonListCustomModelsResult> {
  const settingsManager = SettingsManager.getInstance();
  const rawModels = await readRawCustomModels(settingsManager);
  return { models: buildSummaries(rawModels) };
}

export async function upsertCustomModel(
  params: DaemonUpsertCustomModelRequestParams
): Promise<DaemonUpsertCustomModelResult> {
  const settingsManager = SettingsManager.getInstance();
  const policy = await getOrgModelPolicy(settingsManager);
  return settingsManager.mutateUserSettingsJsonRaw((raw) => {
    const rawModels = getRawCustomModels(raw);
    const entry: Record<string, unknown> =
      params.rawIndex !== undefined
        ? {
            ...getMatchingEntry(
              rawModels,
              params.rawIndex,
              params.expectedModel
            ),
          }
        : {};

    const model = params.model.trim();
    if (!model) {
      throw new MetaError('Model ID cannot be empty');
    }
    entry.model = model;

    entry.provider = parseCustomModelProvider(params.provider);

    if (params.displayName !== undefined) {
      const displayName = params.displayName.trim();
      if (displayName) {
        entry.displayName = displayName;
      } else {
        delete entry.displayName;
      }
    }

    if (params.baseUrl !== undefined) {
      const baseUrl = params.baseUrl.trim();
      if (baseUrl) {
        if (!URL.canParse(baseUrl)) {
          throw new MetaError('Base URL must be a valid URL');
        }
        entry.baseUrl = baseUrl;
      } else {
        delete entry.baseUrl;
      }
    }

    if (params.apiKey !== undefined && params.apiKey.trim().length > 0) {
      entry.apiKey = params.apiKey.trim();
    }

    if (params.maxOutputTokens === null) {
      delete entry.maxOutputTokens;
    } else if (params.maxOutputTokens !== undefined) {
      entry.maxOutputTokens = params.maxOutputTokens;
    }

    if (params.noImageSupport === null) {
      delete entry.noImageSupport;
    } else if (params.noImageSupport !== undefined) {
      entry.noImageSupport = params.noImageSupport;
    }

    const hasBedrockConfig = isObjectRecord(entry.bedrock);
    if (!hasBedrockConfig) {
      if (typeof entry.baseUrl !== 'string' || entry.baseUrl.length === 0) {
        throw new MetaError('Base URL is required');
      }
      if (typeof entry.apiKey !== 'string' || entry.apiKey.length === 0) {
        throw new MetaError('API key is required');
      }
    }
    const parsedEntry = parseSingleCustomModel(entry);
    if (!parsedEntry) {
      throw new MetaError('Custom model configuration is invalid');
    }

    // Derive the policy URL from the parsed entry so Bedrock entries (which
    // have no baseUrl) are checked against the allowlist too.
    assertWriteAllowedByPolicy(
      policy,
      getCustomModelPolicyBaseUrl(parsedEntry, getProcessEnvironment())
    );

    const nextModels = [...rawModels];
    if (params.rawIndex !== undefined) {
      nextModels[params.rawIndex] = entry;
    } else {
      nextModels.push(entry);
    }

    return {
      patch: { customModels: nextModels },
      result: { success: true, models: buildSummaries(nextModels) },
    };
  });
}

export async function deleteCustomModel(
  params: DaemonDeleteCustomModelRequestParams
): Promise<DaemonDeleteCustomModelResult> {
  const settingsManager = SettingsManager.getInstance();
  return settingsManager.mutateUserSettingsJsonRaw((raw) => {
    const rawModels = getRawCustomModels(raw);
    getMatchingEntry(rawModels, params.rawIndex, params.expectedModel);

    const nextModels = rawModels.filter(
      (_, index) => index !== params.rawIndex
    );
    return {
      patch: { customModels: nextModels.length > 0 ? nextModels : undefined },
      result: { success: true, models: buildSummaries(nextModels) },
    };
  });
}
