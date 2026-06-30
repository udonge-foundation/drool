import { McpOAuthTokenEndpointAuthMethod } from '@industry/drool-sdk-ext/protocol/mcp-oauth';

export const MCP_OAUTH_CALLBACK_START_PORT = 54621;
export const MCP_OAUTH_CALLBACK_MAX_PORT_ATTEMPTS = 100;

/**
 * Public HTTPS client identifier served as Industry Drool's CIMD document.
 * Deliberately not under `/.well-known/`: RFC 8615 reserves that prefix for
 * IANA-registered suffixes, and the CIMD spec only requires an HTTPS URL.
 */
export const MCP_OAUTH_CLIENT_METADATA_URL =
  'https://api.example.com/mcp/oauth-client';
export const MCP_OAUTH_CLIENT_NAME = 'Industry Drool';
export const MCP_OAUTH_CLIENT_URI = 'https://app.example.com';
/** Token authentication method published by Industry Drool's public client. */
export const MCP_OAUTH_PUBLIC_CLIENT_TOKEN_ENDPOINT_AUTH_METHOD =
  McpOAuthTokenEndpointAuthMethod.None;
const MCP_OAUTH_CLIENT_LOGO_URI = 'https://app.example.com/logo-180.png';

const MCP_OAUTH_LOOPBACK_REDIRECT_URIS = Array.from(
  { length: MCP_OAUTH_CALLBACK_MAX_PORT_ATTEMPTS },
  (_, offset) =>
    `http://127.0.0.1:${MCP_OAUTH_CALLBACK_START_PORT + offset}/callback`
);

const MCP_OAUTH_HOSTED_CALLBACK_BASE_URLS = [
  'https://dev.app.example.com',
  'https://staging.app.example.com',
  'https://preprod.app.example.com',
  'https://app.example.com',
  'https://dev.app.eu.example.com',
  'https://staging.app.eu.example.com',
  'https://preprod.app.eu.example.com',
  'https://app.eu.example.com',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
] as const;

const MCP_OAUTH_WEB_REDIRECT_URIS = MCP_OAUTH_HOSTED_CALLBACK_BASE_URLS.map(
  (baseUrl) => `${baseUrl}/mcp/oauth/callback`
);

/** Redirect URI allow-list published by Industry Drool's CIMD document. */
export const MCP_OAUTH_CLIENT_REDIRECT_URIS = [
  ...MCP_OAUTH_LOOPBACK_REDIRECT_URIS,
  ...MCP_OAUTH_WEB_REDIRECT_URIS,
] as const;

/** Public OAuth client metadata served from MCP_OAUTH_CLIENT_METADATA_URL. */
export const MCP_OAUTH_CLIENT_METADATA = {
  client_id: MCP_OAUTH_CLIENT_METADATA_URL,
  client_name: MCP_OAUTH_CLIENT_NAME,
  client_uri: MCP_OAUTH_CLIENT_URI,
  logo_uri: MCP_OAUTH_CLIENT_LOGO_URI,
  redirect_uris: MCP_OAUTH_CLIENT_REDIRECT_URIS,
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method:
    MCP_OAUTH_PUBLIC_CLIENT_TOKEN_ENDPOINT_AUTH_METHOD,
} as const;
