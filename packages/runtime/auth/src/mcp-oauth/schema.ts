import { z } from 'zod';

const AuthorizationServerMetadataSchema = z.record(z.string(), z.unknown());

const McpOAuthClientInformationSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  redirect_uris: z.array(z.string().url()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const McpOAuthStoredTokensSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default('Bearer'),
  refresh_token: z.string().optional(),
  expiresAt: z.number().int().positive().optional(),
  scope: z.string().optional(),
});

export const McpOAuthServerCredentialSchema = z.object({
  serverName: z.string().min(1),
  serverUrl: z.string().url(),
  authorizationServerIssuer: z.string().url().optional(),
  authorizationServerMetadata: AuthorizationServerMetadataSchema.optional(),
  clientInformation: McpOAuthClientInformationSchema,
  resource: z.string().url().optional(),
  tokens: McpOAuthStoredTokensSchema.optional(),
});

/**
 * One persisted MCP OAuth credential record.
 *
 * Provenance:
 * - `clientId`–`responseTypes`: the subset of the OAuth 2.0 Dynamic Client
 *   Registration response (RFC 7591 §3.2.1) the MCP SDK reads back to reuse a
 *   registration — identity, secret expiry, the registered redirect set, the
 *   token-endpoint auth method, and grant/response types. Purely descriptive
 *   registration metadata (`client_name`, `logo_uri`, `contacts`, `jwks`,
 *   `software_*`, …) is deliberately not persisted; nothing reads it back after
 *   registration.
 * - `accessToken`–`scope`: the OAuth 2.0 token response (RFC 6749 §5.1).
 * - `authorizationServerIssuer`: ours — it binds each entry to the issuer that
 *   minted it.
 * - `resource`: the RFC 8707 resource indicator the grant was issued for
 *   (the protected resource metadata's canonical identifier when one was
 *   discovered, else the server URL). Refresh requests must replay it, or
 *   audience-validating authorization servers reject the grant. Entries
 *   persisted before this field existed were granted with the server URL.
 *
 * RFC 7591 https://www.rfc-editor.org/rfc/rfc7591 ·
 * RFC 6749 §5.1 https://www.rfc-editor.org/rfc/rfc6749#section-5.1
 */
const McpOAuthCredentialEntrySchema = z.object({
  serverName: z.string().min(1),
  serverUrl: z.string().url(),
  authorizationServerIssuer: z.string().url().optional(),
  authorizationServerMetadata: AuthorizationServerMetadataSchema.optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  clientIdIssuedAt: z.number().optional(),
  clientSecretExpiresAt: z.number().optional(),
  registeredRedirectUris: z.array(z.string().url()).optional(),
  tokenEndpointAuthMethod: z.string().optional(),
  grantTypes: z.array(z.string()).optional(),
  responseTypes: z.array(z.string()).optional(),
  resource: z.string().url().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().int().positive().optional(),
  tokenType: z.string().default('Bearer'),
  scope: z.string().optional(),
  revision: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().positive(),
});

const McpOAuthCredentialTombstoneSchema = z.object({
  serverName: z.string().min(1),
  serverUrl: z.string().url(),
  revision: z.number().int().nonnegative(),
  deletedAt: z.number().int().positive(),
});

/**
 * Tombstones are revision fences for clear-auth. They keep a stale auth or
 * refresh write that observed an older credential revision from resurrecting a
 * credential after the user explicitly removed it.
 */
export const McpOAuthCredentialStorageSchema = z.object({
  mcpOAuth: z.record(z.string(), McpOAuthCredentialEntrySchema),
  mcpOAuthTombstones: z
    .record(z.string(), McpOAuthCredentialTombstoneSchema)
    .default({}),
});

export type McpOAuthClientInformation = z.infer<
  typeof McpOAuthClientInformationSchema
>;

export type McpOAuthStoredTokens = z.infer<typeof McpOAuthStoredTokensSchema>;

export type McpOAuthServerCredential = z.infer<
  typeof McpOAuthServerCredentialSchema
>;

export type McpOAuthCredentialEntry = z.infer<
  typeof McpOAuthCredentialEntrySchema
>;

export type McpOAuthCredentialStorage = z.infer<
  typeof McpOAuthCredentialStorageSchema
>;
