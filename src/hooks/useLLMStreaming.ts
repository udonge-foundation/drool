import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { useMemo, useRef } from 'react';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { PROXY_API_KEY_PLACEHOLDER } from '@industry/drool-core/llms/client/constants';
import { RetryStrategy } from '@industry/drool-core/llms/client/enums';
import { createLlmClients } from '@industry/drool-core/llms/client/llmClients';
import {
  shouldUseAnthropicSDK,
  needsOpenAIClient,
  getProxyBaseURL,
} from '@industry/drool-core/llms/client/providerRouting';
import {
  IndustryDroolMessage,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getCachedRegion, resolveCliApiBaseUrl } from '@industry/runtime/auth';
import { getIndustryDirName } from '@industry/utils/environment';
import { isBedrockCustomModel } from '@industry/utils/models';

import { getRuntimeAuthConfig } from '@/environment';
import { useFeatureFlagValue } from '@/feature-flags/hooks';
import { getTuiModelConfig } from '@/models/config';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { JetBrainsIdeClient } from '@/services/JetBrainsIdeClient';
import { createLLMStreamingCore } from '@/services/llmStreamingClient';
import { convertDroolMessageWithCachingContentToAnthropicContent } from '@/services/message-converters';
import { isMissionWorkerSession } from '@/services/mission/sessionTags';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { VSCodeIdeClient } from '@/services/VSCodeIdeClient';
import { resolveActiveSessionModel } from '@/utils/modelResolution';

import type { LlmClients } from '@industry/drool-core/llms/client/types';

interface useLLMStreamingProps {
  getIdeClient?: () => VSCodeIdeClient | JetBrainsIdeClient;
  systemPromptOverride?: string;
}

export function convertDroolMessagesToAnthropic(
  messages: IndustryDroolMessage[]
): Anthropic.MessageParam[] {
  return messages.map((msg) => ({
    role:
      msg.role === MessageRole.Assistant
        ? MessageRole.Assistant
        : MessageRole.User,
    content: convertDroolMessageWithCachingContentToAnthropicContent(
      msg.content
    ),
  }));
}

/**
 * React hook for LLM streaming. Thin wrapper that sets up refs and calls createLLMStreamingCore.
 */
export function useLLMStreaming({
  getIdeClient,
  systemPromptOverride,
}: useLLMStreamingProps) {
  const llmClientsRef = useRef<LlmClients>(createLlmClients());
  const abortControllerRef = useRef<AbortController | null>(null);
  const ideToolsRef = useRef<Anthropic.Tool[] | null>(null);
  const systemPromptOverrideRef = useRef<string | undefined>(
    systemPromptOverride
  );

  // Get feature flag value for S3 logging
  const isS3LoggingEnabled = useFeatureFlagValue(
    IndustryFeatureFlags.LogFailedLLMRequestsToS3
  );
  const isS3LoggingEnabledRef = useRef<boolean>(isS3LoggingEnabled);
  isS3LoggingEnabledRef.current = isS3LoggingEnabled;

  // Update the ref when systemPromptOverride changes
  systemPromptOverrideRef.current = systemPromptOverride;

  // Reset IDE tools cache when ideClient changes from null to a client
  // This ensures tools are re-discovered when the client becomes available
  const currentIdeClient = getIdeClient?.();
  if (currentIdeClient && ideToolsRef.current === null) {
    // Client is now available, tools will be discovered on next getAllTools call
  } else if (!currentIdeClient && ideToolsRef.current !== null) {
    // Client disconnected, clear the cache
    ideToolsRef.current = null;
  }

  // Initialize LLM clients - recreate on every render to pick up settings changes
  try {
    const { modelId: selectedModel, customModel } = resolveActiveSessionModel();
    const modelProvider = getTuiModelConfig(selectedModel).modelProvider;

    // Bedrock custom models use AWS credentials (no apiKey/baseUrl on the
    // CustomModel itself). Their SDK client is constructed and cached
    // lazily by drool-core's `ensureBedrockClient` on the first streaming
    // turn — nothing to validate or prebuild at render time. BYOK custom
    // models must work even when Industry auth and feature-flag fetches are
    // unavailable.
    if (!isBedrockCustomModel(customModel)) {
      // Validate custom model configuration
      if (customModel) {
        if (!customModel.apiKey || customModel.apiKey.includes('YOUR_')) {
          throw new MetaError('Invalid API key for custom model', {
            value: {
              modelId: customModel.model,
              configPath: `${getIndustryDirName()}/config.json`,
              hint: 'Please replace placeholder API key with a valid API key',
            },
          });
        }
        if (!customModel.baseUrl) {
          throw new MetaError('Invalid base URL for custom model', {
            value: {
              modelId: customModel.model,
              configPath: `${getIndustryDirName()}/config.json`,
              hint: 'Please provide a valid base URL',
            },
          });
        }
      }

      const baseConfig = customModel
        ? {
            apiKey: customModel.apiKey,
            baseURL: customModel.baseUrl,
            organization: null,
            project: null,
          }
        : {
            apiKey: PROXY_API_KEY_PLACEHOLDER,
            baseURL: getProxyBaseURL(
              selectedModel,
              modelProvider,
              resolveCliApiBaseUrl(getRuntimeAuthConfig(), getCachedRegion())
            ),
            organization: null,
            project: null,
          };

      const apiTimeout = getSettingsService().getLlmRequestTimeout();
      const clientConfig = { ...baseConfig, timeout: apiTimeout };

      const clients = llmClientsRef.current;
      if (
        !shouldUseAnthropicSDK(selectedModel, modelProvider) &&
        needsOpenAIClient(modelProvider)
      ) {
        // OpenAI SDK path: OpenAI, XAI, Industry, Generic, and Google.
        // Note: Google creates an OpenAI client as a placeholder even though
        // Gemini actually sends requests via raw fetch to /api/llm/g/v1/generate.
        clients.openai = new OpenAI(clientConfig);
        clients.anthropic = null;
      } else {
        // Anthropic SDK path: native Anthropic, Fireworks Anthropic-compat, and
        // unrecognized providers (safe fallback). An explicit timeout is set so
        // the Anthropic SDK skips its calculateNonstreamingTimeout check that
        // throws "Streaming is required for operations that may take longer
        // than 10 minutes" when max_tokens exceeds ~21 333 on non-streaming
        // requests.
        clients.anthropic = new Anthropic(clientConfig);
        clients.openai = null;
      }
    }
  } catch (error) {
    logException(error, 'Failed to initialize LLM clients in streaming hook');
    const clients = llmClientsRef.current;
    clients.anthropic = null;
    clients.openai = null;
    clients.bedrock = null;
    clients.bedrockConverse = null;
    clients.bedrockOpenAI = null;
  }

  return useMemo(
    () =>
      createLLMStreamingCore({
        llmClientsRef,
        abortControllerRef,
        ideToolsRef,
        getSystemPromptOverride: () => systemPromptOverrideRef.current,
        isS3LoggingEnabled: () => isS3LoggingEnabledRef.current,
        session: getSessionService(),
        settings: getSettingsService(),
        ide: { getIdeClient: () => getIdeClient?.() },
        getRetryStrategy: () =>
          getDroolRuntimeService().isNonInteractiveCLIMode() ||
          isMissionWorkerSession(getSessionService().getCurrentSessionTags())
            ? RetryStrategy.NonInteractive
            : RetryStrategy.Interactive,
      }),
    []
  );
}
