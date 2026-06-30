import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import {
  OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { McpOAuthTokenEndpointAuthMethod } from '@industry/drool-sdk-ext/protocol/mcp-oauth';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { encodeDeliveryState, splitCallbackDelivery } from '@industry/utils/mcp';

import { MCP_OAUTH_AUTHORIZATION_TIMEOUT_MS } from '@/mcp/constants';
import type { OAuthCallbackServer } from '@/services/mcp/oauth/CallbackServer';
import {
  MCP_OAUTH_CLIENT_METADATA_URL,
  MCP_OAUTH_CLIENT_NAME,
  MCP_OAUTH_CLIENT_REDIRECT_URIS,
  MCP_OAUTH_CLIENT_URI,
  MCP_OAUTH_PUBLIC_CLIENT_TOKEN_ENDPOINT_AUTH_METHOD,
} from '@/services/mcp/oauth/constants';
import {
  McpClientRegistrationUnavailableError,
  McpOAuthGuidanceError,
} from '@/services/mcp/oauth/core/errors';
import type {
  AuthenticateOAuthParams,
  McpOAuthDriverMetadata,
  McpOAuthDriverOptions,
} from '@/services/mcp/oauth/core/types';
import { OAuthDiscovery } from '@/services/mcp/oauth/OAuthDiscovery';
import type {
  OAuthAuthorizationChallenge,
  OAuthDiscoveryResult,
} from '@/services/mcp/oauth/types';
import { getUrlOrigin } from '@/services/mcp/oauth/url';
import { openBrowser } from '@/utils/openBrowser';

import type {
  McpOAuthCredentialStore,
  McpOAuthServerCredential,
  McpOAuthStoredTokens,
} from '@industry/runtime/auth';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

function toStoredTokens(
  tokens: OAuthTokens,
  fallbackScope: string | undefined
): McpOAuthStoredTokens {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expiresAt:
      tokens.expires_in !== undefined
        ? Date.now() + tokens.expires_in * 1000
        : undefined,
    scope: tokens.scope ?? fallbackScope,
  };
}

const MCP_OAUTH_CLIENT_REDIRECT_URI_SET = new Set<string>(
  MCP_OAUTH_CLIENT_REDIRECT_URIS
);

const AUTHORIZE_PREFLIGHT_TIMEOUT_MS = 5_000;

function isUnexpired(tokens: McpOAuthStoredTokens | undefined): boolean {
  return tokens?.expiresAt === undefined || tokens.expiresAt > Date.now();
}

function normalizeIssuer(issuer: string): string {
  return new URL(issuer).href;
}

function isUrlClientId(clientId: string): boolean {
  return URL.canParse(clientId);
}

function requestHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function cloneRequestInitWithHeaders(
  init: RequestInit | undefined,
  headers: Headers
): RequestInit {
  return { ...(init ?? {}), headers };
}

function isOAuthInvalidClientError(error: unknown): boolean {
  if (
    error instanceof InvalidClientError ||
    error instanceof UnauthorizedClientError
  ) {
    return true;
  }

  return (
    error instanceof Error &&
    /invalid_client|unauthorized_client/.test(error.message)
  );
}

function isOAuthInvalidGrantError(error: unknown): boolean {
  if (error instanceof InvalidGrantError) {
    return true;
  }

  return error instanceof Error && /invalid_grant/.test(error.message);
}

function refreshFailureReason(error: unknown): string {
  if (isOAuthInvalidClientError(error)) {
    return 'invalid_client';
  }
  if (isOAuthInvalidGrantError(error)) {
    return 'invalid_grant';
  }
  if (
    error instanceof MetaError &&
    error.message.includes('refresh token was not rotated')
  ) {
    return 'refresh_token_not_rotated';
  }
  return 'unexpected';
}

function configuredIssuerMismatchGuidance(
  configuredIssuer: string,
  discoveredIssuer: string
): string {
  return (
    `The configured oauth.authorizationServerIssuer (${configuredIssuer}) does not match ` +
    `this server's authorization server (${discoveredIssuer}). Update or remove ` +
    `oauth.authorizationServerIssuer in its MCP config so it matches the server.`
  );
}

function issuerUnavailableGuidance(): string {
  return (
    `Could not determine this server's OAuth authorization server from discovery. The server ` +
    `may not support OAuth, or you can set oauth.authorizationServerIssuer in its MCP config to ` +
    `point at the authorization server. If this server uses a static bearer or API token instead ` +
    `of OAuth, configure its Authorization header and set oauth to false, or add it with ` +
    '`drool mcp add --type http <name> <url> --header "Authorization: Bearer <token>" --no-oauth`.'
  );
}

function authorizationTimeoutGuidance(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return (
    `Authorization was not completed within ${seconds}s. Re-run authentication and approve ` +
    `access in the opened browser tab. On a remote or SSH session, open the printed URL in a ` +
    `local browser and paste the resulting code back.`
  );
}

function resourceMismatchGuidance(
  declaredResource: string,
  serverUrl: string
): string {
  return (
    `The server's protected resource metadata declares a resource identifier ` +
    `(${declaredResource}) that does not cover this server URL (${serverUrl}). ` +
    `This usually means the MCP server's OAuth configuration is broken; contact ` +
    `the server operator.`
  );
}

function stateMismatchGuidance(): string {
  return (
    `The authorization response did not match the request (a stale browser tab, a reused link, ` +
    `or possible CSRF). Re-run authentication and complete it in a single, fresh browser session.`
  );
}

function parseAuthorizationChallenge(
  headerValue: string | null
): OAuthAuthorizationChallenge | undefined {
  if (!headerValue?.toLowerCase().startsWith('bearer')) {
    return undefined;
  }

  const params = new Map<string, string>();
  for (const match of headerValue.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
    params.set(match[1], match[2]);
  }

  const resourceMetadata = params.get('resource_metadata');
  return {
    resourceMetadataUrl: resourceMetadata,
    scope: params.get('scope'),
    error: params.get('error'),
  };
}

function parseStoredAuthorizationServerMetadata(
  value: unknown
): AuthorizationServerMetadata | undefined {
  const oauthMetadata = OAuthMetadataSchema.safeParse(value);
  if (oauthMetadata.success) {
    return oauthMetadata.data;
  }

  const openIdMetadata = OpenIdProviderDiscoveryMetadataSchema.safeParse(value);
  return openIdMetadata.success ? openIdMetadata.data : undefined;
}

export class McpOAuthDriver {
  private readonly serverName: string;

  private readonly serverUrl: string;

  private readonly storage: McpOAuthCredentialStore;

  private readonly callbackServer: OAuthCallbackServer;

  private readonly onNotification?: (message: string) => void;

  private readonly onAuthRequired?: McpOAuthDriverOptions['onAuthRequired'];

  private readonly autoOpenBrowser: boolean;

  private readonly configuredScopes?: string[];

  private readonly configuredClientInformation?: McpOAuthDriverOptions['configuredClientInformation'];

  private readonly configuredAuthorizationServerIssuer?: string;

  private readonly configuredClientMetadataUrl?: string;

  private readonly configuredTokenEndpointAuthMethod?: McpOAuthTokenEndpointAuthMethod;

  private readonly remoteCallbackUri?: string;

  private readonly discoveredMetadata?: McpOAuthDriverMetadata;

  private readonly replaceClientOnConnect: boolean;

  private readonly authorizationTimeoutMs: number;

  private lastRefreshFailure?: 'invalid_client' | 'invalid_grant';

  private observedChallenge?: OAuthAuthorizationChallenge;

  /**
   * Set when the authorization server rejected a CIMD URL client ID despite
   * advertising support. Client selection then proceeds as if CIMD were not
   * advertised: stored DCR clients become reusable and new registrations go
   * through DCR.
   */
  private clientMetadataUrlRejected = false;

  constructor({
    serverName,
    serverUrl,
    storage,
    callbackServer,
    onNotification,
    onAuthRequired,
    autoOpenBrowser = false,
    configuredScopes,
    configuredClientInformation,
    configuredAuthorizationServerIssuer,
    configuredClientMetadataUrl,
    configuredTokenEndpointAuthMethod,
    remoteCallbackUri,
    discoveredMetadata,
    initialAuthorizationChallenge,
    replaceClientOnConnect = false,
    authorizationTimeoutMs = MCP_OAUTH_AUTHORIZATION_TIMEOUT_MS,
  }: McpOAuthDriverOptions) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.storage = storage;
    this.callbackServer = callbackServer;
    this.onNotification = onNotification;
    this.onAuthRequired = onAuthRequired;
    this.autoOpenBrowser = autoOpenBrowser;
    this.configuredScopes = configuredScopes;
    this.configuredClientInformation = configuredClientInformation;
    this.configuredAuthorizationServerIssuer =
      configuredAuthorizationServerIssuer
        ? normalizeIssuer(configuredAuthorizationServerIssuer)
        : undefined;
    this.configuredClientMetadataUrl = configuredClientMetadataUrl;
    this.configuredTokenEndpointAuthMethod = configuredTokenEndpointAuthMethod;
    this.remoteCallbackUri = remoteCallbackUri;
    this.discoveredMetadata = discoveredMetadata;
    this.observedChallenge = initialAuthorizationChallenge;
    this.replaceClientOnConnect = replaceClientOnConnect;
    this.authorizationTimeoutMs = authorizationTimeoutMs;
  }

  get enableInteractiveAuth(): boolean {
    return this.autoOpenBrowser;
  }

  private get callbackUri(): ReturnType<typeof splitCallbackDelivery> {
    return splitCallbackDelivery(
      this.remoteCallbackUri ?? this.callbackServer.getRedirectUri()
    );
  }

  get redirectUrl(): string {
    return this.callbackUri.redirectUri;
  }

  get isRemoteSession(): boolean {
    return Boolean(this.remoteCallbackUri);
  }

  get authorizationChallenge(): OAuthAuthorizationChallenge | undefined {
    return this.observedChallenge
      ? {
          ...this.observedChallenge,
        }
      : undefined;
  }

  createFetch(): FetchLike {
    return async (input, init) => await this.fetchWithCredential(input, init);
  }

  observeAuthorizationChallenge(response: Response): void {
    if (response.status !== 401 && response.status !== 403) {
      return;
    }
    const challenge = parseAuthorizationChallenge(
      response.headers.get('www-authenticate')
    );
    if (challenge) {
      this.observedChallenge = challenge;
    }
  }

  shouldAuthenticateBeforeConnect(): boolean {
    return this.replaceClientOnConnect && this.enableInteractiveAuth;
  }

  async authenticateBeforeConnect(): Promise<void> {
    await this.authenticate({ replaceClient: true });
  }

  async authenticate({
    replaceClient = false,
  }: AuthenticateOAuthParams = {}): Promise<void> {
    const discovery = await this.resolveDiscovery();
    const authorizationServerIssuer =
      this.resolveAuthorizationServerIssuer(discovery);
    const startingSnapshot = await this.storage.readServerCredentialSnapshot(
      this.serverName,
      this.serverUrl
    );
    let clientInformation: OAuthClientInformationMixed;
    try {
      clientInformation = await this.resolveClientInformation({
        authorizationServerIssuer,
        discovery,
        replaceClient,
      });
    } catch (error) {
      const clientMetadataUrl =
        this.resolveClientMetadataUrlAfterRegistrationFailure(error, discovery);
      if (!clientMetadataUrl) {
        throw error;
      }
      logWarn(
        'MCP OAuth dynamic client registration failed, falling back to client metadata URL',
        {
          name: this.serverName,
          url: getUrlOrigin(this.serverUrl),
          baseUrl: getUrlOrigin(authorizationServerIssuer),
          reason: 'registration_failed_client_metadata_fallback',
          cause: error,
        }
      );
      clientInformation = { client_id: clientMetadataUrl };
    }
    const state = encodeDeliveryState(
      this.callbackUri.delivery,
      crypto.randomUUID()
    );
    const scope = this.resolveScope(discovery);
    const resource = this.resolveResource(discovery);
    let authorization = await startAuthorization(authorizationServerIssuer, {
      metadata: discovery.authServerMetadata,
      clientInformation,
      redirectUrl: this.redirectUrl,
      scope,
      state,
      resource,
    });

    // Some authorization servers advertise CIMD support but reject URL
    // client IDs at the authorization endpoint. That failure renders in the
    // browser and never reaches the redirect URI, so without a preflight the
    // driver would block on the callback until timeout with no recovery.
    if (
      isUrlClientId(clientInformation.client_id) &&
      !(await this.authorizationUrlAccepted(
        authorization.authorizationUrl,
        discovery
      ))
    ) {
      this.clientMetadataUrlRejected = true;
      logWarn('MCP OAuth URL client ID rejected by authorization server', {
        name: this.serverName,
        url: getUrlOrigin(this.serverUrl),
        baseUrl: getUrlOrigin(authorizationServerIssuer),
        reason: 'cimd_client_rejected',
      });
      clientInformation = await this.resolveClientInformation({
        authorizationServerIssuer,
        discovery,
        replaceClient,
      });
      authorization = await startAuthorization(authorizationServerIssuer, {
        metadata: discovery.authServerMetadata,
        clientInformation,
        redirectUrl: this.redirectUrl,
        scope,
        state,
        resource,
      });
    }
    const { authorizationUrl, codeVerifier } = authorization;

    const pendingCode = this.waitForAuthorizationCode(state);
    try {
      this.notifyAuthorizationRequired({ authorizationUrl, state });
      const { code } = await pendingCode;
      const tokens = await exchangeAuthorization(authorizationServerIssuer, {
        metadata: discovery.authServerMetadata,
        clientInformation,
        authorizationCode: code,
        codeVerifier,
        redirectUri: this.redirectUrl,
        resource,
      });

      const didWrite = await this.storage.overwriteServerCredentialIfCurrent({
        credential: {
          serverName: this.serverName,
          serverUrl: this.serverUrl,
          authorizationServerIssuer,
          authorizationServerMetadata: discovery.authServerMetadata,
          clientInformation,
          resource: resource.toString(),
          tokens: toStoredTokens(tokens, scope),
        },
        expectedRevision: startingSnapshot.revision,
        allowUnreadable: true,
      });
      if (!didWrite) {
        throw new MetaError('MCP OAuth credential write was superseded', {
          name: this.serverName,
          url: getUrlOrigin(this.serverUrl),
          reason: 'credential_write_superseded',
        });
      }
    } catch (error) {
      this.callbackServer.cancelPendingCallbackForState(state);
      throw error;
    }
    logInfo('MCP OAuth authorization completed', {
      name: this.serverName,
      url: getUrlOrigin(this.serverUrl),
      baseUrl: getUrlOrigin(authorizationServerIssuer),
      reason: replaceClient ? 'replace_client' : 'new_authorization',
    });
  }

  async authenticateAfterUnauthorized(): Promise<void> {
    const replaceClient = this.lastRefreshFailure === 'invalid_client';
    this.lastRefreshFailure = undefined;
    await this.authenticate({ replaceClient });
  }

  private async clearTokensIfCurrent(
    snapshot:
      | { credential?: McpOAuthServerCredential; revision: number }
      | undefined
  ): Promise<void> {
    if (!snapshot?.credential?.tokens) {
      return;
    }

    await this.storage.overwriteServerCredentialIfCurrent({
      credential: {
        ...snapshot.credential,
        tokens: undefined,
      },
      expectedRevision: snapshot.revision,
    });
  }

  async refreshCredential(
    credential?: McpOAuthServerCredential
  ): Promise<boolean> {
    const candidate = credential ?? (await this.readMatchingCredential());
    if (!candidate?.tokens?.refresh_token) {
      return false;
    }

    const releaseRefreshLock = await this.storage.acquireRefreshLock({
      serverName: this.serverName,
      serverUrl: this.serverUrl,
    });

    let currentSnapshot:
      | { credential?: McpOAuthServerCredential; revision: number }
      | undefined;

    try {
      currentSnapshot = await this.readMatchingCredentialSnapshot();
      const current = currentSnapshot.credential;
      if (!current?.tokens?.refresh_token) {
        return false;
      }
      if (
        candidate.tokens.refresh_token !== current.tokens.refresh_token &&
        isUnexpired(current.tokens)
      ) {
        return true;
      }

      const discovery = await this.resolveDiscovery({ allowNetwork: false });
      const authorizationServerIssuer = current.authorizationServerIssuer;
      if (!authorizationServerIssuer) {
        return false;
      }
      const authServerMetadata: AuthorizationServerMetadata | undefined =
        discovery?.authServerMetadata ??
        parseStoredAuthorizationServerMetadata(
          current.authorizationServerMetadata
        ) ??
        (await discoverAuthorizationServerMetadata(authorizationServerIssuer));
      if (!authServerMetadata?.token_endpoint) {
        return false;
      }
      const tokens = await refreshAuthorization(authorizationServerIssuer, {
        metadata: authServerMetadata,
        clientInformation:
          this.configuredClientInformation ?? current.clientInformation,
        refreshToken: current.tokens.refresh_token,
        // Replay the resource indicator the authorization grant was issued
        // for. Credentials persisted before the resource field existed were
        // always granted with the raw server URL, so that stays the fallback.
        resource: current.resource
          ? new URL(current.resource)
          : resourceUrlFromServerUrl(this.serverUrl),
      });

      if (
        !tokens.refresh_token ||
        tokens.refresh_token === current.tokens.refresh_token
      ) {
        throw new MetaError('MCP OAuth refresh token was not rotated', {
          name: this.serverName,
          url: getUrlOrigin(this.serverUrl),
          reason: 'refresh_token_not_rotated',
        });
      }

      const didWrite = await this.storage.overwriteServerCredentialIfCurrent({
        credential: {
          ...current,
          authorizationServerMetadata: authServerMetadata,
          tokens: toStoredTokens(tokens, current.tokens.scope),
        },
        expectedRevision: currentSnapshot.revision,
      });
      if (!didWrite) {
        return false;
      }
      logInfo('MCP OAuth token refresh successful', {
        name: this.serverName,
        url: getUrlOrigin(this.serverUrl),
      });
      return true;
    } catch (error) {
      const reason = refreshFailureReason(error);
      logWarn('MCP OAuth token refresh failed', {
        name: this.serverName,
        url: getUrlOrigin(this.serverUrl),
        reason,
        errorMessage: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      if (reason === 'invalid_client') {
        this.lastRefreshFailure = 'invalid_client';
        await this.clearTokensIfCurrent(currentSnapshot);
        return false;
      }
      if (reason === 'invalid_grant') {
        this.lastRefreshFailure = 'invalid_grant';
        await this.clearTokensIfCurrent(currentSnapshot);
        return false;
      }
      throw error;
    } finally {
      await releaseRefreshLock();
    }
  }

  private async fetchWithCredential(
    input: Parameters<FetchLike>[0],
    init?: Parameters<FetchLike>[1]
  ): Promise<Response> {
    const credential = await this.readMatchingCredential();
    const headers = requestHeaders(init);
    if (credential?.tokens?.access_token) {
      headers.set('Authorization', `Bearer ${credential.tokens.access_token}`);
    }

    const response = await globalThis.fetch(
      input,
      cloneRequestInitWithHeaders(init, headers)
    );
    if (response.status !== 401 || !credential?.tokens?.refresh_token) {
      return response;
    }

    const refreshed = await this.refreshCredential(credential);
    if (!refreshed) {
      return response;
    }

    await response.body?.cancel();
    const refreshedCredential = await this.readMatchingCredential();
    const retryHeaders = requestHeaders(init);
    if (refreshedCredential?.tokens?.access_token) {
      retryHeaders.set(
        'Authorization',
        `Bearer ${refreshedCredential.tokens.access_token}`
      );
    }

    return await globalThis.fetch(
      input,
      cloneRequestInitWithHeaders(init, retryHeaders)
    );
  }

  private async readMatchingCredential(): Promise<
    McpOAuthServerCredential | undefined
  > {
    return (await this.readMatchingCredentialSnapshot()).credential;
  }

  private async readMatchingCredentialSnapshot(): Promise<{
    credential?: McpOAuthServerCredential;
    revision: number;
  }> {
    const snapshot = await this.storage.readServerCredentialSnapshot(
      this.serverName,
      this.serverUrl
    );
    const credential = snapshot.credential;
    if (!credential?.authorizationServerIssuer) {
      return { revision: snapshot.revision };
    }
    const configuredIssuer = this.configuredAuthorizationServerIssuer;
    if (
      configuredIssuer &&
      normalizeIssuer(credential.authorizationServerIssuer) !== configuredIssuer
    ) {
      return { revision: snapshot.revision };
    }
    return snapshot;
  }

  /**
   * Probes the authorization endpoint with a redirect-suppressed GET before
   * sending the user's browser there. A valid request yields a redirect or a
   * rendered login page; a non-429 4xx means the authorization server
   * rejected the request outright (e.g. `Unknown client` for a CIMD URL
   * client ID), which it cannot deliver to the redirect URI of an unknown
   * client.
   *
   * A 500 from a DCR-capable authorization server also reports `false`.
   * Canva returns this before any user interaction for Industry's CIMD URL
   * client, while still advertising DCR as the standards-compliant fallback.
   * Rate limits, gateway/service-unavailable 5xx responses, timeouts, and
   * network failures are inconclusive and must not demote CIMD: a fallback
   * here registers a DCR client that sticks around, so an over-eager trigger
   * would quietly invalidate CIMD for the server and mask transient or
   * legitimate failures that should surface to the user instead. The probe
   * runs before the authorization-callback timeout exists, so it carries its
   * own bound; a stalled connection aborts into the catch and keeps CIMD.
   */
  private async authorizationUrlAccepted(
    authorizationUrl: URL,
    discovery: OAuthDiscoveryResult
  ): Promise<boolean> {
    try {
      const response = await globalThis.fetch(authorizationUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(AUTHORIZE_PREFLIGHT_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.status >= 400 && response.status < 500) {
        return response.status === 429;
      }
      if (
        response.status === 500 &&
        discovery.authServerMetadata?.registration_endpoint
      ) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Resolves the RFC 8707 resource indicator for authorization and token
   * requests. The protected resource metadata's `resource` value is the
   * server's canonical identifier (RFC 9728) and is what the authorization
   * server validates as the audience, so it takes precedence over the
   * configured endpoint URL whenever it legitimately covers that URL
   * (e.g. Common Room declares `https://mcp.commonroom.io/` while serving
   * MCP at `/mcp`). Without resource metadata, fall back to the server URL:
   * the MCP authorization spec requires the resource parameter on every
   * authorization and token request, so it is never omitted.
   */
  private resolveResource(discovery?: OAuthDiscoveryResult): URL {
    const defaultResource = resourceUrlFromServerUrl(this.serverUrl);
    const declaredResource = discovery?.resourceMetadata?.resource;
    if (declaredResource === undefined) {
      return defaultResource;
    }
    if (
      !checkResourceAllowed({
        requestedResource: defaultResource,
        configuredResource: declaredResource,
      })
    ) {
      throw new McpOAuthGuidanceError(
        'MCP OAuth protected resource metadata does not cover the server URL',
        {
          name: this.serverName,
          url: getUrlOrigin(this.serverUrl),
          reason: 'resource_metadata_mismatch',
          errorMessage: resourceMismatchGuidance(
            declaredResource,
            this.serverUrl
          ),
        }
      );
    }
    return new URL(declaredResource);
  }

  private resolveScope(discovery?: OAuthDiscoveryResult): string | undefined {
    return (
      this.configuredScopes?.join(' ') ||
      discovery?.scopes?.join(' ') ||
      this.discoveredMetadata?.scopes?.join(' ') ||
      // No configured or advertised scopes: omit scope entirely so the
      // authorization server applies its own defaults (RFC 6749 §3.3).
      undefined
    );
  }

  private getTokenEndpointAuthMethod(
    authServerMetadata?: AuthorizationServerMetadata
  ): OAuthClientMetadata['token_endpoint_auth_method'] {
    if (this.configuredTokenEndpointAuthMethod) {
      return this.configuredTokenEndpointAuthMethod;
    }

    const supportedAuthMethods =
      authServerMetadata?.token_endpoint_auth_methods_supported;
    const hasConfiguredSecret =
      this.configuredClientInformation?.client_secret !== undefined;
    const methods: McpOAuthTokenEndpointAuthMethod[] = hasConfiguredSecret
      ? [
          McpOAuthTokenEndpointAuthMethod.ClientSecretBasic,
          McpOAuthTokenEndpointAuthMethod.ClientSecretPost,
          McpOAuthTokenEndpointAuthMethod.None,
        ]
      : [
          McpOAuthTokenEndpointAuthMethod.None,
          McpOAuthTokenEndpointAuthMethod.ClientSecretBasic,
          McpOAuthTokenEndpointAuthMethod.ClientSecretPost,
        ];

    for (const method of methods) {
      if (supportedAuthMethods?.includes(method)) {
        return method;
      }
    }

    return hasConfiguredSecret
      ? McpOAuthTokenEndpointAuthMethod.ClientSecretPost
      : McpOAuthTokenEndpointAuthMethod.None;
  }

  private clientMetadata(
    discovery?: OAuthDiscoveryResult
  ): OAuthClientMetadata {
    return {
      client_name: MCP_OAUTH_CLIENT_NAME,
      client_uri: MCP_OAUTH_CLIENT_URI,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.getTokenEndpointAuthMethod(
        discovery?.authServerMetadata
      ),
      scope: this.resolveScope(discovery),
    };
  }

  private resolveClientMetadataUrl(
    discovery: OAuthDiscoveryResult
  ): string | undefined {
    if (this.clientMetadataUrlRejected) {
      return undefined;
    }
    if (
      discovery.authServerMetadata?.client_id_metadata_document_supported !==
      true
    ) {
      return undefined;
    }

    if (
      this.getTokenEndpointAuthMethod(discovery.authServerMetadata) !==
      MCP_OAUTH_PUBLIC_CLIENT_TOKEN_ENDPOINT_AUTH_METHOD
    ) {
      return undefined;
    }

    if (this.configuredClientMetadataUrl) {
      return this.configuredClientMetadataUrl;
    }

    return MCP_OAUTH_CLIENT_REDIRECT_URI_SET.has(String(this.redirectUrl))
      ? MCP_OAUTH_CLIENT_METADATA_URL
      : undefined;
  }

  private resolveClientMetadataUrlAfterRegistrationFailure(
    error: unknown,
    discovery: OAuthDiscoveryResult
  ): string | undefined {
    if (
      !(error instanceof McpClientRegistrationUnavailableError) ||
      error.metadata?.reason !== 'registration_failed'
    ) {
      return undefined;
    }

    if (this.configuredClientMetadataUrl) {
      return this.configuredClientMetadataUrl;
    }

    if (
      this.configuredTokenEndpointAuthMethod &&
      this.configuredTokenEndpointAuthMethod !==
        MCP_OAUTH_PUBLIC_CLIENT_TOKEN_ENDPOINT_AUTH_METHOD
    ) {
      return undefined;
    }

    return this.resolveClientMetadataUrl(discovery);
  }

  private canReuseStoredClientInformation(
    discovery: OAuthDiscoveryResult,
    clientInformation: OAuthClientInformationMixed | undefined
  ): boolean {
    if (!clientInformation?.client_id) {
      return false;
    }

    const clientMetadataUrl = this.resolveClientMetadataUrl(discovery);
    if (clientMetadataUrl) {
      return clientInformation.client_id === clientMetadataUrl;
    }

    if (
      clientInformation.client_id === this.configuredClientMetadataUrl ||
      clientInformation.client_id === MCP_OAUTH_CLIENT_METADATA_URL
    ) {
      return false;
    }

    const redirectUris =
      'redirect_uris' in clientInformation &&
      Array.isArray(clientInformation.redirect_uris)
        ? clientInformation.redirect_uris
        : undefined;
    if (isUrlClientId(clientInformation.client_id)) {
      return Boolean(redirectUris?.includes(String(this.redirectUrl)));
    }

    if (redirectUris && !redirectUris.includes(String(this.redirectUrl))) {
      return false;
    }

    return true;
  }

  private async resolveClientInformation({
    authorizationServerIssuer,
    discovery,
    replaceClient,
  }: {
    authorizationServerIssuer: string;
    discovery: OAuthDiscoveryResult;
    replaceClient: boolean;
  }): Promise<OAuthClientInformationMixed> {
    if (this.configuredClientInformation) {
      if (
        this.configuredAuthorizationServerIssuer &&
        this.configuredAuthorizationServerIssuer !== authorizationServerIssuer
      ) {
        throw new McpOAuthGuidanceError(
          'Configured MCP OAuth credentials belong to a different authorization server',
          {
            name: this.serverName,
            url: getUrlOrigin(this.serverUrl),
            baseUrl: getUrlOrigin(authorizationServerIssuer),
            reason: 'configured_issuer_mismatch',
            errorMessage: configuredIssuerMismatchGuidance(
              this.configuredAuthorizationServerIssuer,
              authorizationServerIssuer
            ),
          }
        );
      }
      logInfo('MCP OAuth resolved configured client information', {
        name: this.serverName,
        url: getUrlOrigin(this.serverUrl),
        baseUrl: getUrlOrigin(authorizationServerIssuer),
        reason: 'configured_client',
      });
      return this.configuredClientInformation;
    }

    const storedCredential = await this.readMatchingCredential();
    if (
      !replaceClient &&
      storedCredential?.authorizationServerIssuer ===
        authorizationServerIssuer &&
      this.canReuseStoredClientInformation(
        discovery,
        storedCredential.clientInformation
      )
    ) {
      logInfo('MCP OAuth resolved stored client information', {
        name: this.serverName,
        url: getUrlOrigin(this.serverUrl),
        baseUrl: getUrlOrigin(authorizationServerIssuer),
        reason: 'stored_client',
      });
      return storedCredential.clientInformation;
    }

    const clientMetadataUrl = this.resolveClientMetadataUrl(discovery);
    if (clientMetadataUrl) {
      logInfo('MCP OAuth resolved client metadata URL', {
        name: this.serverName,
        url: getUrlOrigin(this.serverUrl),
        baseUrl: getUrlOrigin(authorizationServerIssuer),
        reason: this.configuredClientMetadataUrl
          ? 'configured_client_metadata'
          : 'published_client_metadata',
      });
      return { client_id: clientMetadataUrl };
    }

    logInfo('MCP OAuth registering client dynamically', {
      name: this.serverName,
      url: getUrlOrigin(this.serverUrl),
      baseUrl: getUrlOrigin(authorizationServerIssuer),
      reason: replaceClient ? 'replace_client' : 'no_client',
    });
    return await registerClient(authorizationServerIssuer, {
      metadata: discovery.authServerMetadata,
      clientMetadata: this.clientMetadata(discovery),
    }).catch((error: unknown) => {
      throw new McpClientRegistrationUnavailableError(
        authorizationServerIssuer,
        this.serverName,
        getUrlOrigin(this.serverUrl),
        error
      );
    });
  }

  private async resolveDiscovery({
    allowNetwork = true,
  }: {
    allowNetwork?: boolean;
  } = {}): Promise<OAuthDiscoveryResult> {
    const localMetadata = this.discoveredMetadata;
    if (localMetadata?.authServerMetadata || localMetadata?.resourceMetadata) {
      return {
        requiresAuth: true,
        resourceMetadata: localMetadata.resourceMetadata,
        authServerMetadata: localMetadata.authServerMetadata,
        scopes: localMetadata.scopes,
      };
    }

    if (!allowNetwork) {
      return { requiresAuth: true };
    }

    return await OAuthDiscovery.discoverOAuthSupport(this.serverUrl, {
      challenge: this.observedChallenge,
    });
  }

  private resolveAuthorizationServerIssuer(
    discovery: OAuthDiscoveryResult
  ): string {
    const discoveredIssuer =
      discovery.authServerMetadata?.issuer ??
      discovery.resourceMetadata?.authorization_servers?.[0];
    if (this.configuredAuthorizationServerIssuer && discoveredIssuer) {
      const normalizedDiscoveredIssuer = normalizeIssuer(discoveredIssuer);
      if (
        this.configuredAuthorizationServerIssuer !== normalizedDiscoveredIssuer
      ) {
        throw new McpOAuthGuidanceError(
          'Configured MCP OAuth credentials belong to a different authorization server',
          {
            name: this.serverName,
            url: getUrlOrigin(this.serverUrl),
            baseUrl: getUrlOrigin(normalizedDiscoveredIssuer),
            reason: 'configured_issuer_mismatch',
            errorMessage: configuredIssuerMismatchGuidance(
              this.configuredAuthorizationServerIssuer,
              normalizedDiscoveredIssuer
            ),
          }
        );
      }
    }
    const issuer = this.configuredAuthorizationServerIssuer ?? discoveredIssuer;
    if (!issuer) {
      throw new McpOAuthGuidanceError(
        'OAuth authorization server issuer is unavailable',
        {
          name: this.serverName,
          url: getUrlOrigin(this.serverUrl),
          reason: 'issuer_unavailable',
          errorMessage: issuerUnavailableGuidance(),
        }
      );
    }
    const issuerSource = this.configuredAuthorizationServerIssuer
      ? 'configured'
      : discovery.authServerMetadata?.issuer
        ? 'auth_server_metadata'
        : 'resource_metadata';
    const normalized = normalizeIssuer(issuer);
    logInfo('MCP OAuth resolved authorization server issuer', {
      name: this.serverName,
      url: getUrlOrigin(this.serverUrl),
      baseUrl: getUrlOrigin(normalized),
      reason: issuerSource,
    });
    return normalized;
  }

  private notifyAuthorizationRequired({
    authorizationUrl,
    state,
  }: {
    authorizationUrl: URL;
    state: string;
  }): void {
    const urlString = authorizationUrl.toString();
    logInfo('OAuth authorization required', {
      name: this.serverName,
      origin: getUrlOrigin(this.serverUrl),
      url: getUrlOrigin(authorizationUrl),
      isEnabled: this.autoOpenBrowser,
    });

    if (this.autoOpenBrowser && !this.isRemoteSession && this.onNotification) {
      void openBrowser(urlString);
    }

    this.onNotification?.(
      `Authentication required for ${this.serverName}. If your browser doesn't open automatically, copy this URL manually:\n${urlString}\n\nReturn here after authenticating in your browser.`
    );

    this.onAuthRequired?.({
      serverName: this.serverName,
      authUrl: urlString,
      message: `Authentication required for ${this.serverName}`,
      state,
    });
  }

  private async waitForAuthorizationCode(
    state: string
  ): Promise<{ code: string }> {
    const pendingCode = this.isRemoteSession
      ? this.callbackServer.waitForSubmittedCodeWithState({
          state,
          serverName: this.serverName,
        })
      : this.callbackServer.waitForCallbackWithState({
          state,
          serverName: this.serverName,
        });

    // When the timeout below cancels the pending callback it rejects this
    // promise too; absorb that losing-race rejection so it never surfaces as an
    // unhandled rejection.
    pendingCode.catch(() => undefined);

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        pendingCode,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            this.callbackServer.cancelPendingCallbackForState(state);
            reject(
              new McpOAuthGuidanceError(
                'Timed out waiting for MCP OAuth authorization callback',
                {
                  name: this.serverName,
                  url: getUrlOrigin(this.serverUrl),
                  timeout: this.authorizationTimeoutMs,
                  reason: 'authorization_timeout',
                  errorMessage: authorizationTimeoutGuidance(
                    this.authorizationTimeoutMs
                  ),
                }
              )
            );
          }, this.authorizationTimeoutMs);
        }),
      ]);

      if (result.state !== state) {
        throw new McpOAuthGuidanceError(
          'OAuth state mismatch: possible CSRF attack',
          {
            name: this.serverName,
            url: getUrlOrigin(this.serverUrl),
            reason: 'state_mismatch',
            errorMessage: stateMismatchGuidance(),
          }
        );
      }

      return { code: result.code };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
