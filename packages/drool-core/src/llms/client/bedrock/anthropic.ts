/**
 * Anthropic-on-Bedrock BYOK client.
 *
 * Speaks the Anthropic Messages dialect over the AWS Bedrock SDK. All the
 * transport-agnostic Bedrock plumbing (credentials, region, cross-region
 * inference profiles, `resolveBedrockClientConfig`, error mapping) lives in
 * `./shared` and is shared with the native Converse adapter
 * (`./converse`). This module retains only the
 * `AnthropicBedrock` SDK construction and the Anthropic-aware reader-error
 * mapper.
 */
import {
  AnthropicBedrock,
  type ClientOptions as BedrockClientOptions,
} from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';

import { createBedrockSdkFetch, mapBedrockStreamError } from './shared';

import type { BedrockClientConfig } from './types';
import type { FetchLike } from '../types';

/**
 * Maps an error thrown by `AnthropicBedrock.messages.create({stream:true})`
 * into one of our typed `LLMError` subclasses. The Bedrock SDK's stream
 * class throws `Anthropic.APIError` with the raw Bedrock exception name as
 * the message; the shared mapper handles the name-based classification, and
 * the extractor below threads the HTTP status from `Anthropic.APIError`.
 */
export function mapBedrockReaderError(error: unknown): Error {
  return mapBedrockStreamError(error, (e) => {
    if (e instanceof Anthropic.APIError) {
      const status = (e as InstanceType<typeof Anthropic.APIError>).status;
      return typeof status === 'number' ? status : undefined;
    }
    return undefined;
  });
}

/**
 * Pure constructor: given a resolved {@link BedrockClientConfig},
 * allocates a configured `AnthropicBedrock` instance. No I/O.
 */
export function constructBedrockClient(
  config: BedrockClientConfig,
  fetchImpl: FetchLike,
  timeoutMs: number
): AnthropicBedrock {
  const fetchOpt = createBedrockSdkFetch(
    fetchImpl
  ) as unknown as BedrockClientOptions['fetch'];
  if (config.bearerToken) {
    return new AnthropicBedrock({
      awsRegion: config.region,
      baseURL: config.baseURL,
      apiKey: config.bearerToken,
      fetch: fetchOpt,
      timeout: timeoutMs,
    });
  }
  if (config.credentials) {
    return new AnthropicBedrock({
      awsRegion: config.region,
      baseURL: config.baseURL,
      fetch: fetchOpt,
      timeout: timeoutMs,
      awsAccessKey: config.credentials.accessKeyId,
      awsSecretKey: config.credentials.secretAccessKey,
      awsSessionToken: config.credentials.sessionToken ?? null,
    });
  }
  return new AnthropicBedrock({
    awsRegion: config.region,
    baseURL: config.baseURL,
    fetch: fetchOpt,
    timeout: timeoutMs,
  });
}
