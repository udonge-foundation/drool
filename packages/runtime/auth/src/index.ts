/**
 * @industry/runtime/auth
 *
 * Unified authentication storage for Industry CLI, Desktop, and Daemon.
 *
 * ## Core Auth API
 * - getAuthToken()            - Bearer token (auto-refreshes) [CLI, Desktop, Daemon]
 * - getAuthTokenOrThrow()     - Same but throws if unavailable [CLI]
 * - getAuthedUser()           - Minimal user info (userId, email, orgId) [CLI, Daemon]
 * - getValidAuthedUser()      - Fresh token + user info combined [CLI]
 * - verifyToken()             - Cryptographic verification via JWKS or /whoami [Daemon]
 *
 * ## WorkOS User Info
 * - getWorkOSUser()           - Full user info from JWT (cached) [Desktop]
 * - decodeWorkOSUser()        - Decode JWT without caching [Desktop]
 *
 * ## Login Flows
 * - loginWithDeviceCode()     - Device code flow for CLI [CLI]
 * - requestDeviceAuthorization() - Get device code without polling [CLI ACP]
 * - loginWithPKCE()           - PKCE flow for Desktop [Desktop]
 *
 * ## Session Management
 * - refreshWithOrganization() - Switch org and get new token [CLI, Desktop]
 * - logout()                  - Clear stored credentials [CLI, Desktop]
 *
 * ## Region Routing
 * - getRegion()               - Resolve residency region (lazy-fetches on miss) [CLI]
 * - getCachedRegion()         - Sync read of pinned region (no fetch) [CLI]
 * - resolveCliApiBaseUrl()    - Pick the regional API base URL [CLI]
 *
 * ## Types
 * - AuthedUser                - { userId, email, orgId? }
 * - WorkOSUserInfo            - Full user profile from JWT
 * - DeviceCodeStatus          - Login flow status updates
 * - PKCELoginFlow             - { authUrl, complete() }
 */

// =============================================================================
// Types
// =============================================================================

export type {
  AuthIdentity,
  AuthedUser,
  RuntimeAuthConfig,
} from './auth/common/types';
export { AuthFailureReason } from './auth/common/enums';
export type { DeviceAuthorizationResponse } from './auth/workos/login/types';
export type { WorkOSUserInfo } from './storage/common/types';

// =============================================================================
// Core Auth API [CLI, Desktop, Daemon]
// =============================================================================

export {
  getAuthIdentity,
  getAuthToken,
  getAuthTokenOrThrow,
  getAuthedUser,
  getValidAuthedUser,
} from './auth/get';
export { AIRGAPPED_USER, AIRGAPPED_TOKEN } from './auth/common/constants';
export {
  getActiveOrganizationId,
  setActiveOrganizationId,
} from './auth/active-organization';
export { getFreshTokenWithSource } from './auth/source';
export { verifyToken } from './auth/verify';
export {
  CredentialsStorage,
  configureCredentialsStorage,
} from './credentials/CredentialsStorage';

// =============================================================================
// WorkOS User Info [Desktop]
// =============================================================================

export { getWorkOSUser, decodeWorkOSUser } from './auth/workos/jwt';

// =============================================================================
// WorkOS Config + Token Verification [composition roots, backend, daemon]
// =============================================================================

export { buildWorkosConfig, setWorkosConfig } from './auth/workos/config';
export { validateWorkOsJwt } from './auth/workos/verify-access-token';
export type { WorkOSTokenPayload } from '@industry/common/workos';

// =============================================================================
// Login Flows [CLI, Desktop]
// =============================================================================

export {
  loginWithDeviceCode,
  requestDeviceAuthorization,
} from './auth/workos/login/device-code';
export { loginWithPKCE } from './auth/workos/login/pkce';
export {
  enableCodingSubscriptionOAuthOnce,
  getCodingSubscriptionAccessTokenSync,
  getCodingSubscriptionAuthStore,
  getFreshCodingSubscriptionAuth,
  isCodingSubscriptionOAuthAllowed,
  loginCodingSubscription,
  type CodingSubscriptionAuthRecord,
  type CodingSubscriptionLoginMethod,
  type CodingSubscriptionLoginStatus,
  type CodingSubscriptionProvider,
} from './coding-subs';

// =============================================================================
// Session Management [CLI, Desktop]
// =============================================================================

export { refreshWithOrganization } from './auth/workos/refresh';
export { logout } from './auth/logout';

// =============================================================================
// Region Routing [CLI]
// =============================================================================

export {
  clearUserCache,
  getCachedRegion,
  getRegion,
} from './auth/common/cache';
export { resolveCliApiBaseUrl } from './auth/common/resolveCliApiBaseUrl';

// =============================================================================
// Secure Storage [CLI, Desktop, Daemon]
// =============================================================================

export type { KeytarModule } from './storage/common/types';

export { TokenSourceType } from './storage/common/enums';

export { withFileLock } from './storage/common/fileLock';
export type { FileLockOptions } from './storage/common/types';

// =============================================================================
// MCP OAuth Storage [CLI, Desktop, Daemon]
// =============================================================================

export { McpOAuthCredentialStore } from './mcp-oauth/McpOAuthCredentialStore';
export { MCP_OAUTH_FILE_DATA_FILE_NAME } from './mcp-oauth/constants';

export type {
  McpOAuthServerCredential,
  McpOAuthStoredTokens,
} from './mcp-oauth/schema';
