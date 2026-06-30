/**
 * CLI dependency wiring for the drool-core send-message client.
 *
 * Defines the CLI `SendMessagePlatform` once at module load and exposes
 * a thin `createLLMStreamingCore(deps)` wrapper that injects it. Hosts
 * (the React hook, AgentLoop, prompt-tuning candidate generation) pass
 * plain CLI services / refs through `SendMessageHostDeps`; no per-getter
 * mapping happens here.
 *
 * Also exposes `createOneShotSendMessageClient()` for non-React callers
 * (the compaction `Summarizer` and `SessionTitleGenerator`) so they
 * share the exact same `SendMessagePlatform` + service singletons as
 * the streaming hook.
 */

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { fetch as industryFetch } from '@industry/drool-core/api/fetch';
import { RetryStrategy } from '@industry/drool-core/llms/client/enums';
import { createLlmClients } from '@industry/drool-core/llms/client/llmClients';
import { createSendMessageClient } from '@industry/drool-core/llms/client/sendMessage';
import { getCachedRegion, resolveCliApiBaseUrl } from '@industry/runtime/auth';
import { getFlag } from '@industry/runtime/feature-flags';
import { getProcessEnvironment } from '@industry/utils/environment';
import { sanitizeDeepToWellFormed } from '@industry/utils/text';

import { resolveEffectiveToolContext } from '@/agent/deferredTools';
import { generateToolsFromRegistry } from '@/agent/tools';
import { getRuntimeAuthConfig } from '@/environment';
import { buildSystemMessageBlocks } from '@/hooks/buildSystemMessageBlocks';
import { convertDroolMessagesToAnthropic } from '@/hooks/useLLMStreaming';
import { getI18n } from '@/i18n';
import { getNextProvider } from '@/llm-proxy/providerFamilyRouting';
import { createProxyHeaders, recordCustomModelUsage } from '@/llm-proxy/utils';
import { getAvailableModelIds } from '@/models/availability';
import {
  getTuiModelConfig,
  modelSupportsImages,
  modelSupportsPDFs,
} from '@/models/config';
import { getDeferredToolsService } from '@/services/deferredTools/DeferredToolsService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { setDeferredToolsForSearch } from '@/tools/executors/client/tool-search-cli';
import { handleLlmError } from '@/utils/llmErrorLogger';
import { getRetryConfig } from '@/utils/retryPolicy';
import { sanitizeToolCallId } from '@/utils/toolCallIdSanitization';
import { getUserAgent } from '@/utils/userAgent';

import type {
  SendMessageClient,
  SendMessageHostDeps,
  SendMessagePlatform,
} from '@industry/drool-core/llms/client/types';
import type { LLMToolDescriptor } from '@industry/drool-core/tools/types';

function isMcpToolSearchEnabled(): boolean {
  return getFlag(IndustryFeatureFlags.McpToolSearch);
}

function resolveDeferredToolsForSession(
  tools: LLMToolDescriptor[],
  sessionId?: string | null
) {
  const deferredSessionId =
    sessionId ?? getSessionService().getCurrentSessionId();

  setDeferredToolsForSearch(deferredSessionId, tools);

  return resolveEffectiveToolContext({
    enabled: true,
    allTools: tools,
    loaded: getDeferredToolsService().getLoaded(deferredSessionId),
  });
}

export async function buildDeferredToolsReminderForSession(
  sessionId?: string | null
): Promise<string> {
  if (!isMcpToolSearchEnabled()) {
    return '';
  }

  const tools = await generateToolsFromRegistry();
  return resolveDeferredToolsForSession(tools, sessionId).deferredToolsReminder;
}

const cliPlatform: SendMessagePlatform = {
  apiBaseUrl: () =>
    resolveCliApiBaseUrl(getRuntimeAuthConfig(), getCachedRegion()),
  region: () => getCachedRegion(),
  userAgent: getUserAgent,
  getProcessEnvironment,
  customFetch: industryFetch,
  createProxyHeaders,
  getNextProvider,
  getTuiModelConfig: (id) => ({
    modelProvider: getTuiModelConfig(id).modelProvider,
  }),
  modelCapabilities: {
    supportsImages: modelSupportsImages,
    supportsPDFs: modelSupportsPDFs,
  },
  buildSystemMessageBlocks,
  convertDroolMessagesToAnthropic,
  handleLlmError: ({ apiProvider, ...rest }) =>
    handleLlmError({ ...rest, apiProvider: apiProvider ?? undefined }),
  getRetryConfig,
  sanitizeDeepToWellFormed,
  sanitizeToolCallId,
  translate: (key, options) => getI18n().t(key, options),
  getAvailableModelIds: () => Array.from(getAvailableModelIds()),
  generateToolsFromRegistry,
  resolveTurnTools: ({ tools, sessionId }) => {
    if (!isMcpToolSearchEnabled()) {
      const { tools: resolvedTools, toolSearchMetrics } =
        resolveEffectiveToolContext({
          enabled: false,
          allTools: tools,
          loaded: getDeferredToolsService().getLoaded(sessionId),
        });
      return { tools: resolvedTools, toolSearchMetrics };
    }

    const { tools: toolsWithCacheControl, toolSearchMetrics } =
      resolveDeferredToolsForSession(tools, sessionId);
    return {
      tools: toolsWithCacheControl,
      toolSearchMetrics,
    };
  },
  isE2EMockEnabled: () => false,
  recordCustomModelUsage,
};

export function createLLMStreamingCore(deps: SendMessageHostDeps) {
  return createSendMessageClient({
    ...deps,
    platform: cliPlatform,
  });
}

/**
 * Build a one-shot `SendMessageClient` that reuses the CLI service
 * singletons (no React refs). Used by `Summarizer` and
 * `SessionTitleGenerator` to route their single-turn requests through
 * the same engine as the main chat flow — eliminating the need for a
 * separate `requestTextCompletion` codepath.
 */
export function createOneShotSendMessageClient(): SendMessageClient {
  return createLLMStreamingCore({
    llmClientsRef: { current: createLlmClients() },
    abortControllerRef: { current: null },
    ideToolsRef: { current: null },
    getSystemPromptOverride: () => undefined,
    isS3LoggingEnabled: () => false,
    session: getSessionService(),
    settings: getSettingsService(),
    // One-shot completions never want IDE-tool injection.
    ide: { getIdeClient: () => undefined },
    // Compaction / title generation runs in the background even on
    // interactive sessions, so use the wider non-interactive retry
    // budget — a transient provider hiccup shouldn't surface to the user
    // mid-turn.
    getRetryStrategy: () => RetryStrategy.NonInteractive,
    // Skip tool resolution entirely — Summarizer / SessionTitleGenerator
    // never invoke tools.
    getTools: () => [],
  });
}
