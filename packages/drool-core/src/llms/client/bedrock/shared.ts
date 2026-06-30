/**
 * Shared, transport-agnostic AWS Bedrock core for BYOK custom models.
 *
 * Owns everything that is independent of the wire dialect spoken on top
 * of Bedrock (Anthropic Messages vs. native Converse vs. OpenAI Responses):
 *
 *  - AWS credential resolution (`fromNodeProviderChain`, `awsAuthRefresh`,
 *    `awsCredentialExport`, `AWS_BEARER_TOKEN_BEDROCK`, 1h memoization)
 *  - region + cross-region inference-profile prefix resolution
 *  - `sts:GetCallerIdentity` short-circuit
 *  - `resolveBedrockClientConfig` (creds + region + baseURL +
 *    `cacheFingerprint`) consumed by the Anthropic-on-Bedrock client
 *    (`anthropic.ts`), the Converse adapter (`converse.ts`), and the OpenAI
 *    Responses adapter (`openai.ts`)
 *  - the SDK fetch error-mapping wrapper
 *  - the generic Bedrock event-stream error mapper
 */
import { spawn, type StdioOptions } from 'node:child_process';
import { createHash } from 'node:crypto';

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { Hash } from '@smithy/hash-node';
import { SignatureV4 } from '@smithy/signature-v4';

import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { logInfo, logWarn, MetaError } from '@industry/logging';
import { isFetchError } from '@industry/logging/errors';
import {
  buildBedrockCustomModelBaseUrl,
  resolveBedrockCustomModelRegion,
} from '@industry/utils/models';

import {
  LLMInternalError,
  LLMInvalidRequestError,
  LLMThrottlingError,
  LLMUnknownError,
} from '../../errors';

import type {
  BedrockClientConfig,
  CachedCredentials,
  ResolvedCredentials,
  ResolveBedrockClientConfigParams,
} from './types';
import type { FetchLike } from '../types';
import type { CustomModelBedrockConfig } from '@industry/common/settings';
import type { AwsCredentialIdentity } from '@smithy/types';

/**
 * Everything a Bedrock SDK client constructor needs, plus a deterministic
 * `cacheFingerprint` that covers region + base URL + auth mode +
 * credential identity. Callers that cache the SDK instance across turns
 * use the fingerprint as the cache key so the instance is rebuilt
 * exactly when either the config or the live credentials rotate, and
 * no sooner.
 */
const CREDENTIAL_TTL_MS = 60 * 60 * 1000; // 1h, matches Claude Code's `Oa()` memoization
const CREDENTIAL_EXPIRATION_BUFFER_MS = 5 * 60 * 1000;
const credentialCache = new Map<string, CachedCredentials>();

interface InFlightCredentialResolution {
  promise: Promise<ResolvedCredentials | null>;
  controller: AbortController;
  waiters: number;
}

const credentialResolutionInFlight = new Map<
  string,
  InFlightCredentialResolution
>();

function getCredentialCacheKey(bedrock: CustomModelBedrockConfig): string {
  return JSON.stringify({
    p: bedrock.awsProfile ?? null,
    e: bedrock.awsCredentialExport ?? null,
    r: bedrock.awsAuthRefresh ?? null,
  });
}

function getCachedCredentials(key: string): ResolvedCredentials | null {
  const entry = credentialCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    credentialCache.delete(key);
    return null;
  }
  return {
    accessKeyId: entry.accessKeyId,
    secretAccessKey: entry.secretAccessKey,
    sessionToken: entry.sessionToken,
    expiration: entry.expiration,
  };
}

function setCachedCredentials(
  key: string,
  credentials: ResolvedCredentials
): void {
  const now = Date.now();
  const expiresAt = Math.min(
    now + CREDENTIAL_TTL_MS,
    credentials.expiration
      ? credentials.expiration.getTime() - CREDENTIAL_EXPIRATION_BUFFER_MS
      : Number.POSITIVE_INFINITY
  );
  if (expiresAt <= now) return;
  credentialCache.set(key, {
    ...credentials,
    expiresAt,
  });
}

// ---------------------------------------------------------------------------
// Region + cross-region inference profile resolution
// ---------------------------------------------------------------------------

const REGION_PREFIXES = ['us', 'eu', 'apac', 'global'] as const;
type RegionPrefix = (typeof REGION_PREFIXES)[number];

/**
 * Converts resolved Bedrock credentials into the shape required by SigV4 signing.
 */
export function credentialsForSigning(credentials: ResolvedCredentials): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken
      ? { sessionToken: credentials.sessionToken }
      : {}),
  };
}

/**
 * Converts web `Headers` into a plain object for Smithy signing utilities.
 */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function resolveBedrockRegion(
  bedrock: CustomModelBedrockConfig,
  environment: Record<string, string | undefined>
): string {
  return resolveBedrockCustomModelRegion(bedrock, environment);
}

function inferRegionPrefix(awsRegion: string): RegionPrefix | null {
  if (awsRegion.startsWith('us-')) return 'us';
  if (awsRegion.startsWith('eu-')) return 'eu';
  if (awsRegion.startsWith('ap-')) return 'apac';
  return null;
}

function detectCurrentPrefix(modelId: string): RegionPrefix | null {
  for (const prefix of REGION_PREFIXES) {
    if (modelId.startsWith(`${prefix}.`)) return prefix;
  }
  return null;
}

/**
 * Adds a Bedrock cross-region inference profile prefix to bare model IDs
 * when the active AWS region maps cleanly to one.
 *
 * Returns the model ID unchanged when:
 *  - it is an inference profile ARN (starts with `arn:`)
 *  - it already has an explicit `us.` / `eu.` / `apac.` / `global.` prefix
 *  - the region cannot be mapped to a known prefix (e.g. unknown gov-cloud)
 *  - the model ID has no `anthropic.` segment to rewrite
 */
function applyCrossRegionPrefix(modelId: string, awsRegion: string): string {
  if (modelId.startsWith('arn:')) return modelId;
  const targetPrefix = inferRegionPrefix(awsRegion);
  if (!targetPrefix) return modelId;

  const currentPrefix = detectCurrentPrefix(modelId);
  if (currentPrefix) return modelId;

  if (modelId.startsWith('anthropic.')) {
    return `${targetPrefix}.${modelId}`;
  }
  return modelId;
}

// ---------------------------------------------------------------------------
// Error mapping for Bedrock event-stream exceptions
// ---------------------------------------------------------------------------

/**
 * Maps a generic Bedrock event-stream exception into one of our typed
 * `LLMError` subclasses so the retry policy treats Bedrock throttling /
 * model-stream / validation / internal errors the same way as direct
 * provider errors.
 *
 * The Bedrock SDKs surface the raw Bedrock exception name
 * (`ThrottlingException`, `InternalServerException`, `ValidationException`,
 * `ModelStreamErrorException`) in the error message; the Anthropic-on-
 * Bedrock SDK additionally wraps them as `Anthropic.APIError` with an HTTP
 * status. The optional `httpStatus` extractor lets dialect-specific callers
 * pass that status through without coupling shared core to a wire SDK.
 */
export function mapBedrockStreamError(
  error: unknown,
  httpStatus?: (bedrockError: Error) => number | undefined
): Error {
  if (!(error instanceof Error)) {
    return new LLMUnknownError({ cause: new Error(String(error)) });
  }

  const message = error.message ?? '';
  const haystack = `${error.name ?? ''} ${message}`;

  const status = httpStatus?.(error);
  if (typeof status === 'number') {
    if (status === 429)
      return new LLMThrottlingError({ message, cause: error });
    if (status === 400)
      return new LLMInvalidRequestError({ message, cause: error });
    if (status >= 500) return new LLMInternalError({ cause: error });
  }

  if (/ThrottlingException/i.test(haystack)) {
    return new LLMThrottlingError({ message, cause: error });
  }
  if (/ValidationException/i.test(haystack)) {
    return new LLMInvalidRequestError({ message, cause: error });
  }
  if (/(InternalServerException|ServiceUnavailableException)/i.test(haystack)) {
    return new LLMInternalError({ cause: error });
  }
  if (/ModelStreamErrorException/i.test(haystack)) {
    return new LLMUnknownError({ cause: error });
  }
  return error;
}

// ---------------------------------------------------------------------------
// awsAuthRefresh / awsCredentialExport / GetCallerIdentity
// ---------------------------------------------------------------------------

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

interface ShellExecOptions {
  signal: AbortSignal;
  awsProfile?: string;
  environment: Record<string, string | undefined>;
  timeoutMs?: number;
  captureOutput: boolean;
}

interface ShellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function assertTrustedLocalAuthCommand(command: string, field: string): void {
  // Trusted local/admin settings hook, not model-authored shell: reject
  // malformed multiline/control payloads but don't apply session tool policy.
  if (command.trim().length === 0 || /[\0\r\n]/.test(command)) {
    throw new MetaError('Invalid Bedrock auth command', {
      value: { field },
    });
  }
}

async function execShellCommand(
  command: string,
  {
    signal,
    awsProfile,
    environment,
    timeoutMs = 180_000,
    captureOutput,
  }: ShellExecOptions
): Promise<ShellExecResult> {
  throwIfAborted(signal);
  assertTrustedLocalAuthCommand(command, 'auth');

  const stdio: StdioOptions = captureOutput
    ? ['ignore', 'pipe', 'pipe']
    : ['ignore', 'inherit', 'pipe'];
  const childEnv = {
    ...environment,
    ...(awsProfile ? { AWS_PROFILE: awsProfile } : {}),
  } as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio,
      env: childEnv,
    });

    let stdout = '';
    let stderr = '';
    if (captureOutput && child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }

    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      child.kill('SIGTERM');
      settle(undefined, createAbortError()); // eslint-disable-line no-use-before-define
    };
    const settle = (
      result: ShellExecResult | undefined,
      error: unknown | undefined
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (error) reject(error);
      else resolve(result!);
    };

    signal.addEventListener('abort', onAbort, { once: true });

    timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      settle(
        undefined,
        new MetaError('AWS auth command timed out', {
          value: { command, timeoutMs },
        })
      );
    }, timeoutMs);

    child.on('error', (err) => settle(undefined, err));
    child.on('close', (code) => {
      settle({ exitCode: code ?? 0, stdout, stderr }, undefined);
    });
  });
}

async function runAwsAuthRefresh(
  command: string,
  bedrock: CustomModelBedrockConfig,
  environment: Record<string, string | undefined>,
  signal: AbortSignal
): Promise<void> {
  logInfo('[Bedrock] Running awsAuthRefresh command', {
    name: bedrock.awsProfile,
  });
  const result = await execShellCommand(command, {
    signal,
    awsProfile: bedrock.awsProfile,
    environment,
    captureOutput: false,
  });
  if (result.exitCode !== 0) {
    throw new MetaError('awsAuthRefresh command failed', {
      statusCode: result.exitCode,
      value: { stderr: result.stderr.slice(0, 4000) },
    });
  }
}

interface StsCredentialsBlock {
  Credentials?: {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    SessionToken?: string;
    Expiration?: string;
  };
}

function isStsCredentialsBlock(value: unknown): value is StsCredentialsBlock {
  if (typeof value !== 'object' || value === null) return false;
  const creds = (value as StsCredentialsBlock).Credentials;
  return (
    typeof creds === 'object' &&
    creds !== null &&
    typeof creds.AccessKeyId === 'string' &&
    typeof creds.SecretAccessKey === 'string'
  );
}

function parseCredentialExpiration(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function toResolvedCredentials(
  credentials: AwsCredentialIdentity & { expiration?: Date }
): ResolvedCredentials {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiration: parseCredentialExpiration(credentials.expiration),
  };
}

async function runAwsCredentialExport(
  command: string,
  bedrock: CustomModelBedrockConfig,
  environment: Record<string, string | undefined>,
  signal: AbortSignal
): Promise<ResolvedCredentials> {
  logInfo('[Bedrock] Running awsCredentialExport command', {
    name: bedrock.awsProfile,
  });
  const result = await execShellCommand(command, {
    signal,
    awsProfile: bedrock.awsProfile,
    environment,
    captureOutput: true,
  });
  if (result.exitCode !== 0) {
    throw new MetaError('awsCredentialExport command failed', {
      statusCode: result.exitCode,
      value: { stderr: result.stderr.slice(0, 4000) },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (cause) {
    throw new MetaError(
      'awsCredentialExport command did not return parseable JSON',
      { cause }
    );
  }
  if (!isStsCredentialsBlock(parsed)) {
    throw new MetaError(
      'awsCredentialExport did not return valid AWS STS output structure',
      {
        value: {
          hint: 'Expected `{ "Credentials": { "AccessKeyId", "SecretAccessKey", "SessionToken" } }`',
        },
      }
    );
  }
  const creds = parsed.Credentials!;
  return {
    accessKeyId: creds.AccessKeyId!,
    secretAccessKey: creds.SecretAccessKey!,
    sessionToken: creds.SessionToken,
    expiration: parseCredentialExpiration(creds.Expiration),
  };
}

/**
 * Calls `sts:GetCallerIdentity` against the global STS endpoint with the
 * supplied credentials. Returns true when the credentials are accepted,
 * false otherwise. Mirrors Claude Code's `g0q()` short-circuit.
 *
 * Uses a hand-rolled SigV4 + fetch instead of `@aws-sdk/client-sts` to
 * keep the runtime dependency footprint small.
 */
async function isCallerIdentityValid(
  credentials: AwsCredentialIdentity,
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<boolean> {
  throwIfAborted(signal);
  const body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const hostname = 'sts.amazonaws.com';
  const signer = new SignatureV4({
    service: 'sts',
    region: 'us-east-1',
    credentials,
    sha256: Hash.bind(null, 'sha256'),
  });
  try {
    const signed = await signer.sign({
      protocol: 'https:',
      method: 'POST',
      hostname,
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        host: hostname,
      },
      body,
    });
    const response = await fetchImpl(`https://${hostname}/`, {
      method: 'POST',
      headers: signed.headers,
      body,
      signal,
    });
    return response.ok;
  } catch (error) {
    logWarn('[Bedrock] sts:GetCallerIdentity probe failed', { cause: error });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

interface ResolveCredentialsParams {
  bedrock: CustomModelBedrockConfig;
  environment: Record<string, string | undefined>;
  signal: AbortSignal;
  fetchImpl: FetchLike;
}

async function resolveBedrockCredentialsUncached(
  { bedrock, environment, signal, fetchImpl }: ResolveCredentialsParams,
  cacheKey: string
): Promise<ResolvedCredentials | null> {
  const provider = fromNodeProviderChain({
    ...(bedrock.awsProfile ? { profile: bedrock.awsProfile } : {}),
  });

  let chainCredentials: AwsCredentialIdentity | null = null;
  try {
    chainCredentials = await provider();
  } catch (error) {
    logWarn(
      '[Bedrock] Default AWS credential chain failed; checking refresh hooks',
      { cause: error }
    );
  }
  throwIfAborted(signal);

  const hasRefreshHook = !!(
    bedrock.awsAuthRefresh || bedrock.awsCredentialExport
  );

  if (chainCredentials && !hasRefreshHook) {
    const resolved = toResolvedCredentials(chainCredentials);
    setCachedCredentials(cacheKey, resolved);
    return resolved;
  }

  if (chainCredentials && hasRefreshHook) {
    const valid = await isCallerIdentityValid(
      chainCredentials,
      fetchImpl,
      signal
    );
    if (valid) {
      const resolved = toResolvedCredentials(chainCredentials);
      setCachedCredentials(cacheKey, resolved);
      return resolved;
    }
  }

  if (bedrock.awsCredentialExport) {
    const exported = await runAwsCredentialExport(
      bedrock.awsCredentialExport,
      bedrock,
      environment,
      signal
    );
    setCachedCredentials(cacheKey, exported);
    return exported;
  }

  if (bedrock.awsAuthRefresh) {
    await runAwsAuthRefresh(
      bedrock.awsAuthRefresh,
      bedrock,
      environment,
      signal
    );
    throwIfAborted(signal);
    const refreshed = await provider();
    const resolved = toResolvedCredentials(refreshed);
    setCachedCredentials(cacheKey, resolved);
    return resolved;
  }

  if (chainCredentials) {
    const resolved = toResolvedCredentials(chainCredentials);
    setCachedCredentials(cacheKey, resolved);
    return resolved;
  }
  return null;
}

function startCredentialResolution(
  { bedrock, environment, fetchImpl }: Omit<ResolveCredentialsParams, 'signal'>,
  cacheKey: string
): InFlightCredentialResolution {
  const controller = new AbortController();
  const entry: InFlightCredentialResolution = {
    controller,
    waiters: 0,
    promise: resolveBedrockCredentialsUncached(
      {
        bedrock,
        environment,
        signal: controller.signal,
        fetchImpl,
      },
      cacheKey
    ).finally(() => {
      if (credentialResolutionInFlight.get(cacheKey) === entry) {
        credentialResolutionInFlight.delete(cacheKey);
      }
    }),
  };
  credentialResolutionInFlight.set(cacheKey, entry);
  return entry;
}

function waitForCredentialResolution(
  entry: InFlightCredentialResolution,
  signal: AbortSignal
): Promise<ResolvedCredentials | null> {
  throwIfAborted(signal);
  entry.waiters += 1;
  let settled = false;
  return new Promise((resolve, reject) => {
    // Aborting this controller auto-detaches the abort listener below, so the
    // listener and its cleanup don't need to reference each other by name.
    const abortListener = new AbortController();
    const release = (): void => {
      if (settled) return;
      settled = true;
      abortListener.abort();
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.controller.signal.aborted) {
        entry.controller.abort();
      }
    };
    signal.addEventListener(
      'abort',
      () => {
        release();
        reject(createAbortError());
      },
      { once: true, signal: abortListener.signal }
    );

    entry.promise.then(
      (credentials) => {
        release();
        resolve(credentials);
      },
      (error) => {
        release();
        reject(error);
      }
    );
  });
}

async function resolveBedrockCredentials({
  bedrock,
  environment,
  signal,
  fetchImpl,
}: ResolveCredentialsParams): Promise<ResolvedCredentials | null> {
  const cacheKey = getCredentialCacheKey(bedrock);
  const cached = getCachedCredentials(cacheKey);
  if (cached) return cached;
  throwIfAborted(signal);

  // An entry whose controller is already aborted is being torn down by a
  // departed last-waiter; its promise will reject. Joining it would surface a
  // spurious AbortError to this live caller, so start a fresh resolution
  // instead. startCredentialResolution overwrites the map slot, and the dead
  // entry's `.finally` cleanup is a no-op because it no longer owns the slot.
  const existing = credentialResolutionInFlight.get(cacheKey);
  const inFlight =
    existing && !existing.controller.signal.aborted
      ? existing
      : startCredentialResolution(
          { bedrock, environment, fetchImpl },
          cacheKey
        );
  return waitForCredentialResolution(inFlight, signal);
}

// ---------------------------------------------------------------------------
// Public client config industry (transport-agnostic)
// ---------------------------------------------------------------------------

async function resolveBedrockClientConfigForEndpoint({
  bedrock,
  environment,
  signal,
  fetchImpl,
  region,
  resolvedModelId,
  baseURL,
}: Pick<
  ResolveBedrockClientConfigParams,
  'bedrock' | 'environment' | 'signal' | 'fetchImpl'
> & {
  region: string;
  resolvedModelId: string;
  baseURL: string;
}): Promise<BedrockClientConfig> {
  const bearerToken = environment.AWS_BEARER_TOKEN_BEDROCK ?? null;
  if (bearerToken) {
    return {
      region,
      resolvedModelId,
      baseURL,
      credentials: null,
      bearerToken,
      cacheFingerprint: JSON.stringify({
        region,
        baseURL,
        mode: 'bearer',
        // Fingerprint the token so token rotation rebuilds the client,
        // but keep the stored fingerprint opaque (not the token itself).
        tokenHash: createHash('sha256').update(bearerToken).digest('hex'),
      }),
    };
  }

  const credentials = await resolveBedrockCredentials({
    bedrock,
    environment,
    signal,
    fetchImpl,
  });

  return {
    region,
    resolvedModelId,
    baseURL,
    credentials,
    bearerToken: null,
    cacheFingerprint: JSON.stringify({
      region,
      baseURL,
      mode: credentials ? 'static' : 'chain',
      // Access key id is a public identifier (not a secret), safe to
      // use as a fingerprint. Rebuilds the cached SDK instance when
      // credentials rotate after the 1h memoization window.
      accessKeyId: credentials?.accessKeyId ?? null,
    }),
  };
}

/**
 * Resolves everything needed to build a Bedrock SDK client without
 * actually allocating one, so callers can cache the SDK instance
 * per-turn keyed on {@link BedrockClientConfig.cacheFingerprint}.
 * Handles:
 *
 *  - `AWS_BEARER_TOKEN_BEDROCK` short-circuit
 *  - region resolution with `us-west-1` default
 *  - cross-region inference profile rewriting on the model id
 *  - `awsCredentialExport` / `awsAuthRefresh` settings hooks
 *  - `sts:GetCallerIdentity` short-circuit before running refresh hooks
 *  - 1h credential memoization
 */
export async function resolveBedrockClientConfig({
  bedrock,
  modelId,
  environment,
  signal,
  fetchImpl,
}: ResolveBedrockClientConfigParams): Promise<BedrockClientConfig> {
  throwIfAborted(signal);
  const region = resolveBedrockRegion(bedrock, environment);
  return await resolveBedrockClientConfigForEndpoint({
    bedrock,
    environment,
    signal,
    fetchImpl,
    region,
    resolvedModelId: applyCrossRegionPrefix(modelId, region),
    baseURL: buildBedrockCustomModelBaseUrl({
      bedrock,
      provider: ModelProvider.ANTHROPIC,
      environment,
    }),
  });
}

/**
 * Resolves Bedrock Mantle config for OpenAI Responses custom models.
 */
export async function resolveBedrockOpenAIClientConfig({
  bedrock,
  modelId,
  environment,
  signal,
  fetchImpl,
}: ResolveBedrockClientConfigParams): Promise<BedrockClientConfig> {
  throwIfAborted(signal);
  const region = resolveBedrockRegion(bedrock, environment);
  return await resolveBedrockClientConfigForEndpoint({
    bedrock,
    environment,
    signal,
    fetchImpl,
    region,
    resolvedModelId: modelId,
    baseURL: buildBedrockCustomModelBaseUrl({
      bedrock,
      provider: ModelProvider.OPENAI,
      environment,
    }),
  });
}

/**
 * Wraps a `fetch` impl so a thrown `FetchError` is converted into a
 * non-throwing `Response`, letting the Bedrock SDKs apply their own
 * status-based error handling instead of surfacing a raw network error.
 */
export function createBedrockSdkFetch(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (isFetchError(error)) {
        const body =
          typeof error.metadata?.errorMessage === 'string'
            ? error.metadata.errorMessage
            : error.message;
        return new Response(body, {
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers,
        });
      }
      throw error;
    }
  };
}
