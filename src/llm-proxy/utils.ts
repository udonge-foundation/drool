import {
  INDUSTRY_OPENAI_ORG_ID,
  OPENAI_PLATFORM_HEADER,
} from '@industry/common/llm';
import { fetch } from '@industry/drool-core/api/fetch';
import { INDUSTRY_CLIENT_VERSION } from '@industry/drool-sdk-ext/protocol/drool';
import { ApiProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';
import { isOpenAIBackedApiProvider } from '@industry/utils/llm/providers/openai';

import packageJson from '../../package.json';
import { getAuthHeadersOrThrow, getIndustryApiConfig } from '@/api/config';
import { getUserAgent } from '@/utils/userAgent';

import type { RecordCustomModelUsageParams } from '@industry/common/usage';
import type { RecordCustomModelUsageRequest } from '@industry/drool-core/llms/client/types';

interface LLMProxyHeaders {
  'x-session-id': string;
  'x-assistant-message-id'?: string;
  'x-api-provider'?: string;
}

interface CreateProxyHeadersParams {
  sessionId: string;
  assistantMessageId?: string;
  proxyApiProvider?: ApiProvider;
}

/**
 * Creates proxy headers for LLM API requests.
 *
 * For OpenAI-backed routes (OpenAI direct or Azure OpenAI) this also attaches
 * the `OpenAI-Platform` header so OpenAI can attribute proxied traffic back
 * to Industry. The Industry proxy forwards unknown headers through to the
 * upstream provider untouched.
 */
export async function createProxyHeaders({
  sessionId,
  assistantMessageId,
  proxyApiProvider,
}: CreateProxyHeadersParams): Promise<Record<string, string>> {
  const authHeaders = await getAuthHeadersOrThrow();
  const proxyHeaders: LLMProxyHeaders = {
    'x-session-id': sessionId,
    'x-assistant-message-id': assistantMessageId,
    'x-api-provider': proxyApiProvider,
  };
  return {
    ...authHeaders,
    ...proxyHeaders,
    'User-Agent': getUserAgent(),
    [INDUSTRY_CLIENT_VERSION]: packageJson.version,
    ...(isOpenAIBackedApiProvider(proxyApiProvider)
      ? { [OPENAI_PLATFORM_HEADER]: INDUSTRY_OPENAI_ORG_ID }
      : {}),
  };
}

/**
 * Records custom-model token usage with the Industry backend so that
 * BYOK consumption shows up in the usage dashboards.
 */
export async function recordCustomModelUsage(
  params: RecordCustomModelUsageRequest
): Promise<void> {
  try {
    await fetch(
      '/api/llm/custom/usage',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params satisfies RecordCustomModelUsageParams),
      },
      getIndustryApiConfig()
    );
  } catch (error) {
    logWarn('Failed to record custom model usage', { error });
  }
}
