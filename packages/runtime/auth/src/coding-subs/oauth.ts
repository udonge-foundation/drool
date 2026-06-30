import crypto from 'crypto';
import http from 'http';

import { MetaError } from '@industry/logging/errors';
import { sleep } from '@industry/utils/time/sleep';

import { getCodingSubscriptionAuthStore } from './store';

import type {
  CodingSubscriptionAuthRecord,
  CodingSubscriptionLoginMethod,
  CodingSubscriptionLoginStatus,
  CodingSubscriptionProvider,
} from './types';

interface BrowserProviderConfig {
  provider: CodingSubscriptionProvider;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  port: number;
  path: string;
  scopes: string;
  tokenFormat: 'form' | 'json';
  usePkce?: boolean;
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  discoveryUrl?: string;
  baseUrl?: string;
}

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_DEVICE_USER_CODE_URL =
  'https://auth.openai.com/api/accounts/deviceauth/usercode';
const CODEX_DEVICE_TOKEN_URL =
  'https://auth.openai.com/api/accounts/deviceauth/token';
const CODEX_DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device';
const CODEX_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_DEVICE_CODE_URL = 'https://auth.kimi.com/api/oauth/device/code';
const KIMI_TOKEN_URL = 'https://auth.kimi.com/api/oauth/token';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ANTIGRAVITY_API_BASE_URL = 'https://cloudcode-pa.googleapis.com';
const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';

function b64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomToken(bytes = 32): string {
  return b64url(crypto.randomBytes(bytes));
}

function decodeJwtPayload(token?: string): Record<string, unknown> {
  if (!token) return {};
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function expiryFromSeconds(seconds?: number): string | undefined {
  return typeof seconds === 'number' && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new MetaError('OAuth request failed', {
      status: response.status,
      errorMessage: text,
    });
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new MetaError('OAuth response was not valid JSON', { cause });
  }
}

function writeHttpError(
  res: http.ServerResponse,
  statusCode: number,
  message: string
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(`${message}\n`);
}

function createCallbackServer(
  port: number,
  callbackPath: string
): Promise<{
  redirectUri: string;
  waitForCallback: (state: string) => Promise<{ code: string; state: string }>;
  close: () => Promise<void>;
}> {
  let resolver:
    | ((value: { code: string; state: string }) => void)
    | undefined;
  let rejecter: ((error: Error) => void) | undefined;

  const callbackPromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    }
  );

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/success') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Login successful</h1><p>You can close this window.</p>');
      return;
    }
    if (url.pathname !== callbackPath) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET') {
      writeHttpError(res, 405, 'Method not allowed');
      return;
    }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (error) {
      rejecter?.(new MetaError('OAuth authorization failed', { errorMessage: error }));
      writeHttpError(res, 400, `OAuth error: ${error}`);
      return;
    }
    if (!code) {
      rejecter?.(new MetaError('OAuth callback missing code or state'));
      writeHttpError(res, 400, 'No authorization code received');
      return;
    }
    if (!state) {
      rejecter?.(new MetaError('OAuth callback missing code or state'));
      writeHttpError(res, 400, 'No state parameter received');
      return;
    }

    resolver?.({ code, state });
    res.writeHead(302, { Location: '/success' });
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        redirectUri: `http://127.0.0.1:${port}${callbackPath}`,
        waitForCallback: async (expectedState: string) => {
          const result = await callbackPromise;
          if (result.state !== expectedState) {
            throw new MetaError('OAuth callback state mismatch');
          }
          return result;
        },
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

async function tokenPost(
  url: string,
  body: Record<string, string>,
  format: 'form' | 'json'
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers:
      format === 'json'
        ? { 'Content-Type': 'application/json', Accept: 'application/json' }
        : {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
    body:
      format === 'json'
        ? JSON.stringify(body)
        : new URLSearchParams(body).toString(),
  });
  return readJson(response);
}

function toAuthRecord(
  provider: CodingSubscriptionProvider,
  token: Record<string, unknown>,
  extra: Partial<CodingSubscriptionAuthRecord> = {}
): CodingSubscriptionAuthRecord {
  const accessToken = stringField(token.access_token);
  const refreshToken = stringField(token.refresh_token);
  const idToken = stringField(token.id_token);
  const expiresIn =
    typeof token.expires_in === 'number' ? token.expires_in : undefined;
  const idPayload = decodeJwtPayload(idToken);
  const codexAuthInfo =
    idPayload['https://api.openai.com/auth'] &&
    typeof idPayload['https://api.openai.com/auth'] === 'object'
      ? (idPayload['https://api.openai.com/auth'] as Record<string, unknown>)
      : {};
  return {
    type: provider,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiryFromSeconds(expiresIn),
    id_token: idToken,
    token_type: stringField(token.token_type),
    scope: stringField(token.scope),
    email: stringField(extra.email) ?? stringField(idPayload.email),
    sub: stringField(extra.sub) ?? stringField(idPayload.sub),
    account_id:
      stringField(extra.account_id) ??
      stringField(codexAuthInfo.chatgpt_account_id),
    base_url: extra.base_url,
    redirect_uri: extra.redirect_uri,
    token_endpoint: extra.token_endpoint,
    auth_kind: extra.auth_kind,
    device_id: extra.device_id,
  };
}

async function xaiDiscovery(): Promise<{ authUrl: string; tokenUrl: string }> {
  const response = await fetch(
    'https://auth.x.ai/.well-known/openid-configuration'
  );
  const parsed = await readJson(response);
  return {
    authUrl:
      stringField(parsed.authorization_endpoint) ??
      'https://auth.x.ai/oauth2/auth',
    tokenUrl:
      stringField(parsed.token_endpoint) ?? 'https://auth.x.ai/oauth2/token',
  };
}

async function browserConfig(
  provider: CodingSubscriptionProvider
): Promise<BrowserProviderConfig> {
  if (provider === 'xai') {
    const discovery = await xaiDiscovery();
    return {
      provider,
      authUrl: discovery.authUrl,
      tokenUrl: discovery.tokenUrl,
      clientId: XAI_CLIENT_ID,
      redirectUri: 'http://127.0.0.1:56121/callback',
      port: 56121,
      path: '/callback',
      scopes: 'openid profile email offline_access grok-cli:access api:access',
      tokenFormat: 'form',
      extraAuthParams: { plan: 'generic', referrer: 'cli-proxy-api' },
    };
  }
  const configs: Record<
    Exclude<CodingSubscriptionProvider, 'xai' | 'kimi'>,
    BrowserProviderConfig
  > = {
    codex: {
      provider,
      authUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: CODEX_TOKEN_URL,
      clientId: CODEX_CLIENT_ID,
      redirectUri: 'http://localhost:1455/auth/callback',
      port: 1455,
      path: '/auth/callback',
      scopes: 'openid email profile offline_access',
      tokenFormat: 'form',
      usePkce: true,
      extraAuthParams: {
        prompt: 'login',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
      },
    },
    claude: {
      provider,
      authUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      redirectUri: 'http://localhost:54545/callback',
      port: 54545,
      path: '/callback',
      scopes:
        'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
      tokenFormat: 'json',
      usePkce: true,
      extraTokenParams: { grant_type: 'authorization_code' },
    },
    antigravity: {
      provider,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: ANTIGRAVITY_CLIENT_ID,
      redirectUri: 'http://localhost:51121/oauth-callback',
      port: 51121,
      path: '/oauth-callback',
      scopes:
        'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs',
      tokenFormat: 'form',
      extraTokenParams: { client_secret: ANTIGRAVITY_CLIENT_SECRET },
      baseUrl: ANTIGRAVITY_API_BASE_URL,
    },
  };
  if (provider === 'kimi') {
    throw new MetaError('Kimi only supports device code login');
  }
  return configs[provider];
}

export async function* loginCodingSubscriptionBrowser(
  provider: CodingSubscriptionProvider
): AsyncGenerator<CodingSubscriptionLoginStatus, CodingSubscriptionAuthRecord> {
  const config = await browserConfig(provider);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const server = await createCallbackServer(config.port, config.path);
  try {
    const authParams: Record<string, string> = {
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      scope: config.scopes,
      state,
      ...config.extraAuthParams,
    };
    if (config.usePkce) {
      authParams.code_challenge = challenge;
      authParams.code_challenge_method = 'S256';
    }
    const authUrl = `${config.authUrl}?${new URLSearchParams(authParams)}`;
    yield { type: 'browser', authUrl };
    const callback = await server.waitForCallback(state);
    const token = await tokenPost(
      config.tokenUrl,
      {
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code: callback.code,
        redirect_uri: config.redirectUri,
        ...(config.usePkce ? { code_verifier: verifier } : {}),
        ...(config.extraTokenParams ?? {}),
      },
      config.tokenFormat
    );
    const auth = toAuthRecord(provider, token, {
      base_url: config.baseUrl,
      redirect_uri: config.redirectUri,
      token_endpoint: config.tokenUrl,
      auth_kind: provider === 'xai' || provider === 'antigravity' ? 'oauth' : undefined,
    });
    await getCodingSubscriptionAuthStore().saveAuth(auth);
    return auth;
  } finally {
    await server.close();
  }
}

async function requestCodexDeviceCode(): Promise<{
  deviceAuthId: string;
  userCode: string;
  interval: number;
}> {
  const response = await fetch(CODEX_DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  const parsed = await readJson(response);
  return {
    deviceAuthId: stringField(parsed.device_auth_id) ?? '',
    userCode: stringField(parsed.user_code) ?? stringField(parsed.usercode) ?? '',
    interval: numberField(parsed.interval) ?? 5,
  };
}

async function loginCodexDevice(start: {
  deviceAuthId: string;
  userCode: string;
  interval: number;
}): Promise<CodingSubscriptionAuthRecord> {
  const expiresAt = Date.now() + CODEX_DEVICE_TIMEOUT_MS;
  while (true) {
    if (Date.now() > expiresAt) {
      throw new MetaError('Codex device authentication timed out');
    }
    await sleep(start.interval * 1000);
    const response = await fetch(CODEX_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        device_auth_id: start.deviceAuthId,
        user_code: start.userCode,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 403 || response.status === 404) continue;
      throw new MetaError('Codex device auth failed', {
        status: response.status,
        errorMessage: text,
      });
    }
    const result = JSON.parse(text) as Record<string, unknown>;
    const authorizationCode = stringField(result.authorization_code);
    const codeVerifier = stringField(result.code_verifier);
    if (!authorizationCode || !codeVerifier) continue;
    const token = await tokenPost(
      CODEX_TOKEN_URL,
      {
        grant_type: 'authorization_code',
        client_id: CODEX_CLIENT_ID,
        code: authorizationCode,
        redirect_uri: 'https://auth.openai.com/deviceauth/callback',
        code_verifier: codeVerifier,
      },
      'form'
    );
    const auth = toAuthRecord('codex', token, {
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
      token_endpoint: CODEX_TOKEN_URL,
    });
    await getCodingSubscriptionAuthStore().saveAuth(auth);
    return auth;
  }
}

async function loginKimiDevice(
  deviceId: string,
  start: Record<string, unknown>
): Promise<CodingSubscriptionAuthRecord> {
  const interval = typeof start.interval === 'number' ? start.interval : 5;
  const deviceCode = stringField(start.device_code) ?? '';
  while (true) {
    await sleep(interval * 1000);
    const response = await fetch(KIMI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: KIMI_CLIENT_ID,
        device_code: deviceCode,
        device_id: deviceId,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 400 || response.status === 428) continue;
      throw new MetaError('Kimi device auth failed', {
        status: response.status,
        errorMessage: text,
      });
    }
    const token = JSON.parse(text) as Record<string, unknown>;
    const auth = toAuthRecord('kimi', token, {
      base_url: 'https://api.kimi.com/coding',
      device_id: deviceId,
    });
    await getCodingSubscriptionAuthStore().saveAuth(auth);
    return auth;
  }
}

export async function* loginCodingSubscriptionDevice(
  provider: CodingSubscriptionProvider
): AsyncGenerator<CodingSubscriptionLoginStatus, CodingSubscriptionAuthRecord> {
  if (provider === 'codex') {
    const start = await requestCodexDeviceCode();
    yield {
      type: 'pending',
      userCode: start.userCode,
      verificationUri: CODEX_DEVICE_VERIFY_URL,
      verificationUriComplete: CODEX_DEVICE_VERIFY_URL,
    };
    return loginCodexDevice(start);
  }
  if (provider === 'kimi') {
    const deviceId = crypto.randomUUID();
    const start = await tokenPost(
      KIMI_DEVICE_CODE_URL,
      { client_id: KIMI_CLIENT_ID, device_id: deviceId },
      'json'
    );
    const verificationUri = stringField(start.verification_uri) ?? '';
    const verificationUriComplete =
      stringField(start.verification_uri_complete) ?? verificationUri;
    yield {
      type: 'pending',
      userCode: stringField(start.user_code) ?? '',
      verificationUri,
      verificationUriComplete,
    };
    return loginKimiDevice(deviceId, start);
  }
  throw new MetaError(`${provider} does not support device code login`);
}

function isExpired(auth: CodingSubscriptionAuthRecord): boolean {
  if (!auth.expires_at) return false;
  return Date.parse(auth.expires_at) <= Date.now() + 60_000;
}

export async function getFreshCodingSubscriptionAuth(
  provider: CodingSubscriptionProvider
): Promise<CodingSubscriptionAuthRecord | null> {
  const store = getCodingSubscriptionAuthStore();
  const auth = await store.getAuth(provider);
  if (!auth) return null;
  if (!isExpired(auth) || !auth.refresh_token || !auth.token_endpoint) {
    return auth;
  }
  const token = await tokenPost(
    auth.token_endpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      ...(auth.type === 'codex' ? { client_id: CODEX_CLIENT_ID } : {}),
      ...(auth.type === 'claude'
        ? { client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }
        : {}),
      ...(auth.type === 'antigravity'
        ? {
            client_id: ANTIGRAVITY_CLIENT_ID,
            client_secret: ANTIGRAVITY_CLIENT_SECRET,
          }
        : {}),
      ...(auth.type === 'xai' ? { client_id: XAI_CLIENT_ID } : {}),
    },
    auth.type === 'claude' ? 'json' : 'form'
  );
  const refreshed = toAuthRecord(auth.type, token, auth);
  await store.saveAuth(refreshed);
  return refreshed;
}

export async function* loginCodingSubscription(
  provider: CodingSubscriptionProvider,
  method: CodingSubscriptionLoginMethod
): AsyncGenerator<CodingSubscriptionLoginStatus, CodingSubscriptionAuthRecord> {
  if (!(await getCodingSubscriptionAuthStore().isAllowed())) {
    throw new MetaError(
      'Coding subscription OAuth is not enabled. Run /provider and choose "Enable coding subscriptions" first.'
    );
  }
  if (method === 'device') {
    return yield* loginCodingSubscriptionDevice(provider);
  }
  return yield* loginCodingSubscriptionBrowser(provider);
}
