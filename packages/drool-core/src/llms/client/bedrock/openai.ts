import { Hash } from '@smithy/hash-node';
import { SignatureV4 } from '@smithy/signature-v4';
import OpenAI, { type ClientOptions } from 'openai';

import { MetaError } from '@industry/logging';

import {
  createBedrockSdkFetch,
  credentialsForSigning,
  headersToRecord,
  mapBedrockStreamError,
} from './shared';

import type { BedrockClientConfig } from './types';
import type { FetchLike } from '../types';

type BedrockOpenAIRequestInit = RequestInit & { duplex?: 'half' };

type ConstructBedrockOpenAIClientParams = {
  config: BedrockClientConfig;
  fetchImpl: FetchLike;
  timeoutMs: number;
  userAgent: string;
};

function isBodyInit(body: RequestInit['body']): body is BodyInit {
  return body !== undefined && body !== null;
}

async function bodyFromRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<BodyInit | undefined> {
  if (isBodyInit(init?.body)) {
    return init.body;
  }
  if (input instanceof Request && input.body) {
    return await input.clone().arrayBuffer();
  }
  return undefined;
}

function headersFromRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : {});
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  return headers;
}

function methodFromRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): string {
  return init?.method ?? (input instanceof Request ? input.method : 'GET');
}

function signalFromRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): AbortSignal | null | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

function statusFromError(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  return typeof error.status === 'number' ? error.status : undefined;
}

function createBedrockOpenAIFetch({
  config,
  fetchImpl,
  userAgent,
}: {
  config: BedrockClientConfig;
  fetchImpl: FetchLike;
  userAgent: string;
}): FetchLike {
  const fetchForBedrock = createBedrockSdkFetch(fetchImpl);
  const signer = config.credentials
    ? new SignatureV4({
        service: 'bedrock-mantle',
        region: config.region,
        credentials: credentialsForSigning(config.credentials),
        sha256: Hash.bind(null, 'sha256'),
      })
    : null;

  return async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString()
    );
    const method = methodFromRequest(input, init);
    const body = await bodyFromRequest(input, init);
    const headers = headersFromRequest(input, init);

    if (userAgent) {
      headers.set('User-Agent', userAgent);
    }

    if (config.bearerToken) {
      headers.set('Authorization', `Bearer ${config.bearerToken}`);
    } else {
      if (!signer) {
        throw new MetaError('AWS credentials are required for Bedrock OpenAI', {
          value: { region: config.region, baseURL: config.baseURL },
        });
      }

      headers.delete('authorization');
      headers.set('host', url.host);
      if (body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }

      const signedRequest = await signer.sign({
        protocol: url.protocol,
        method,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: headersToRecord(headers),
        body,
      });
      Object.entries(signedRequest.headers).forEach(([key, value]) => {
        headers.set(key, value);
      });
    }

    const requestInit: BedrockOpenAIRequestInit = {
      ...init,
      method,
      headers,
      body,
      signal: signalFromRequest(input, init),
      ...(body !== undefined ? { duplex: 'half' } : {}),
    };
    return await fetchForBedrock(url, requestInit);
  };
}

function createOpenAIClientFetch(
  params: Parameters<typeof createBedrockOpenAIFetch>[0]
): NonNullable<ClientOptions['fetch']> {
  const bedrockFetch = createBedrockOpenAIFetch(params);
  return async (input, init) => await bedrockFetch(input, init);
}

/**
 * Maps OpenAI SDK stream reader failures from Bedrock OpenAI into provider errors.
 */
export function mapBedrockOpenAIReaderError(error: unknown): Error {
  return mapBedrockStreamError(error, statusFromError);
}

/**
 * Constructs an OpenAI Responses client that sends requests through Bedrock Mantle.
 */
export function constructBedrockOpenAIClient({
  config,
  fetchImpl,
  timeoutMs,
  userAgent,
}: ConstructBedrockOpenAIClientParams): OpenAI {
  return new OpenAI({
    apiKey: config.bearerToken ?? 'bedrock-sigv4',
    baseURL: config.baseURL,
    timeout: timeoutMs,
    organization: null,
    project: null,
    fetch: createOpenAIClientFetch({
      config,
      fetchImpl,
      userAgent,
    }),
  });
}
