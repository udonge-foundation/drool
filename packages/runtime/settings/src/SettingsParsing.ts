import { type ParseError, parse as parseJsonc } from 'jsonc-parser';

import {
  GeneralSettingsSchema,
  HookSettingsSchema,
  McpConfigSchema,
  type CustomModel,
  type CustomModelSettings,
  type GeneralSettings,
  type McpSettings,
} from '@industry/common/settings';
import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getProcessEnvironmentVariable } from '@industry/utils/environment';
import { parseBuiltInModelID, parseReasoningEffort } from '@industry/utils/llm';
import {
  buildCustomModelId,
  computeStableIndices,
} from '@industry/utils/models';

function expandSettingsCustomModelApiKeyEnvVars(apiKey: string): string {
  return apiKey.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match: string, envVarName: string) =>
      getProcessEnvironmentVariable(envVarName) ?? match
  );
}

const LEGACY_SESSION_FIELDS = [
  'model',
  'reasoningEffort',
  'autonomyMode',
  'specModeModel',
  'specModeReasoningEffort',
] as const;

export function isObjectRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KNOWN_HOOK_KEYS = new Set(Object.keys(HookSettingsSchema.shape));

/**
 * `HookSettingsSchema` is non-strict, so unrecognized event keys (usually a
 * misspelled event name) are dropped on parse. Warn so the author learns their
 * hook was ignored.
 */
export function warnOnUnknownHookEventKeys(
  raw: unknown,
  context: Record<string, unknown>
): void {
  if (!isObjectRecord(raw)) return;
  const unknownKeys = Object.keys(raw).filter(
    (key) => !KNOWN_HOOK_KEYS.has(key)
  );
  if (unknownKeys.length > 0) {
    logWarn('Ignoring unknown hook event keys', {
      ...context,
      keys: unknownKeys,
    });
  }
}

export function isBedrockCustomModelConfig(value: unknown): boolean {
  return isObjectRecord(value);
}

export function parseCustomModelProvider(provider: string): ModelProvider {
  switch (provider.toLowerCase().replaceAll('_', '-')) {
    case 'openai':
      return ModelProvider.OPENAI;
    case 'generic-chat-completion-api':
      return ModelProvider.GENERIC_CHAT_COMPLETION_API;
    case 'bedrock-converse':
      return ModelProvider.BEDROCK_CONVERSE;
    case 'anthropic':
      return ModelProvider.ANTHROPIC;
    default:
      throw new MetaError('Unsupported custom model provider', {
        value: {
          provider,
          supportedProviders: [
            'anthropic',
            'openai',
            'generic-chat-completion-api',
            'bedrock-converse',
          ],
        },
      });
  }
}

export function customModelProviderSupportsImagesByDefault(
  provider: string
): boolean {
  const parsed = parseCustomModelProvider(provider);
  return (
    parsed === ModelProvider.OPENAI ||
    parsed === ModelProvider.ANTHROPIC ||
    parsed === ModelProvider.BEDROCK_CONVERSE
  );
}

export function parseJsoncObjectFile(
  content: string,
  settingsPath: string,
  source: string
): Record<string, unknown> {
  const parseErrors: ParseError[] = [];
  const parsed = parseJsonc(content, parseErrors);

  if (parseErrors.length > 0) {
    logWarn('[SettingsParsing] Malformed settings file', {
      path: settingsPath,
      source,
      cause: parseErrors,
    });
    throw new MetaError(`${source} file contains invalid JSON/JSONC`, {
      path: settingsPath,
    });
  }

  if (!isObjectRecord(parsed)) {
    throw new MetaError(`${source} file must contain a JSON object`, {
      path: settingsPath,
    });
  }

  return parsed;
}

export function parseCustomModelsFromSettings(
  models: unknown[]
): CustomModelSettings | undefined {
  const filteredModels = models
    .filter((m): m is Record<string, unknown> => {
      if (
        !isObjectRecord(m) ||
        typeof m.model !== 'string' ||
        typeof m.provider !== 'string'
      ) {
        return false;
      }

      const hasHttpConfig =
        typeof m.baseUrl === 'string' && typeof m.apiKey === 'string';
      const hasBedrockConfig = isObjectRecord(m.bedrock);
      return hasHttpConfig || hasBedrockConfig;
    })
    .filter((m) => {
      const apiKey = typeof m.apiKey === 'string' ? m.apiKey : undefined;
      if (apiKey === 'YOUR_OPENAI_API_KEY' || apiKey === 'YOUR_API_KEY') {
        return false;
      }
      return true;
    });

  const displayNames = filteredModels.map((m) =>
    typeof m.displayName === 'string' ? m.displayName : (m.model as string)
  );
  const stableIndices = computeStableIndices(displayNames);

  const validModels = filteredModels.map<CustomModel>((m, index) => {
    const model = m.model as string;
    const baseUrl = typeof m.baseUrl === 'string' ? m.baseUrl : undefined;
    const apiKey =
      typeof m.apiKey === 'string'
        ? expandSettingsCustomModelApiKeyEnvVars(m.apiKey)
        : undefined;
    const providerStr = m.provider as string;
    const displayName =
      typeof m.displayName === 'string' ? m.displayName : model;
    const id =
      typeof m.id === 'string'
        ? m.id
        : buildCustomModelId(displayName, stableIndices[index]);

    return {
      model,
      id,
      index: typeof m.index === 'number' ? m.index : index,
      baseUrl,
      apiKey,
      displayName,
      maxContextLimit:
        typeof m.maxContextLimit === 'number' ? m.maxContextLimit : undefined,
      enableThinking:
        typeof m.enableThinking === 'boolean' ? m.enableThinking : undefined,
      thinkingMaxTokens:
        typeof m.thinkingMaxTokens === 'number'
          ? m.thinkingMaxTokens
          : undefined,
      maxOutputTokens:
        typeof m.maxOutputTokens === 'number' ? m.maxOutputTokens : undefined,
      reasoningEffort:
        typeof m.reasoningEffort === 'string'
          ? parseReasoningEffort(m.reasoningEffort)
          : undefined,
      extraHeaders:
        typeof m.extraHeaders === 'object' && m.extraHeaders !== null
          ? (m.extraHeaders as Record<string, string>)
          : undefined,
      extraArgs:
        typeof m.extraArgs === 'object' && m.extraArgs !== null
          ? (m.extraArgs as Record<string, unknown>)
          : undefined,
      bedrock: isBedrockCustomModelConfig(m.bedrock)
        ? (m.bedrock as CustomModel['bedrock'])
        : undefined,
      baseModelId: parseBuiltInModelID(m.baseModelId),
      useInRouter:
        typeof m.useInRouter === 'boolean' ? m.useInRouter : undefined,
      noImageSupport:
        m.noImageSupport === true ||
        (m.noImageSupport === undefined &&
          !customModelProviderSupportsImagesByDefault(providerStr)),
      provider: parseCustomModelProvider(providerStr),
    };
  });

  return validModels.length > 0 ? validModels : undefined;
}

export function normalizeGeneralSettings(
  input: Record<string, unknown>
): Record<string, unknown> {
  const parsed = { ...input };

  const hasLegacySessionFields = LEGACY_SESSION_FIELDS.some(
    (field) => parsed[field] !== undefined
  );

  if (hasLegacySessionFields) {
    const currentSessionDefaults = parsed.sessionDefaultSettings;
    const sessionDefaults: Record<string, unknown> = isObjectRecord(
      currentSessionDefaults
    )
      ? currentSessionDefaults
      : {};

    for (const field of LEGACY_SESSION_FIELDS) {
      if (parsed[field] !== undefined) {
        if (sessionDefaults[field] === undefined) {
          sessionDefaults[field] = parsed[field];
        }
        delete parsed[field];
      }
    }

    parsed.sessionDefaultSettings = sessionDefaults;
  }

  if (Array.isArray(parsed.customModels)) {
    parsed.customModels = parseCustomModelsFromSettings(parsed.customModels);
  }

  return parsed;
}

function throwSchemaError(
  source: string,
  section: string,
  settingsPath: string,
  issues: string[]
): never {
  const details = issues.join('; ');
  throw new MetaError(`Invalid ${source}: "${section}" failed validation`, {
    path: settingsPath,
    cause: details,
  });
}

export function parseGeneralSettingsSection(
  raw: Record<string, unknown>,
  settingsPath: string,
  source = 'runtime settings'
): GeneralSettings {
  const normalized = normalizeGeneralSettings(raw);
  const parsed = GeneralSettingsSchema.safeParse(normalized);
  if (!parsed.success) {
    throwSchemaError(
      source,
      'general',
      settingsPath,
      parsed.error.issues.map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message
      )
    );
  }

  return parsed.data as GeneralSettings;
}

export function parseMcpSettingsSection(
  raw: Record<string, unknown>,
  settingsPath: string,
  source = 'runtime settings'
): McpSettings {
  const parsed = McpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throwSchemaError(
      source,
      'mcp',
      settingsPath,
      parsed.error.issues.map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message
      )
    );
  }

  return parsed.data;
}
