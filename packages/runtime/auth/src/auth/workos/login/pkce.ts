/**
 * PKCE login flow for Desktop apps.
 *
 * This implements the OAuth 2.0 Authorization Code Grant with PKCE
 * for apps that can handle browser redirects.
 */

import { createHash, randomBytes } from 'crypto';

import { MetaError } from '@industry/logging/errors';

import { getCredentialsStorage } from '../../../credentials/CredentialsStorage';
import { TokenSourceType } from '../../../storage/common/enums';
import { getCachedUser } from '../../common/cache';
import { parseJsonResponse } from '../../common/parse-response';
import { getWorkOSApiBaseUrl } from '../base-url';
import { getWorkOSClientId } from '../constants';
import { TokenResponseSchema } from './schemas';

import type { PKCELoginFlow } from './types';
import type { RuntimeAuthConfig } from '../../common/types';

// Store code verifiers keyed by state for concurrent flow support
const codeVerifiersByState = new Map<string, string>();

/**
 * Generate a cryptographically secure random string for PKCE.
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate a unique state parameter.
 */
function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate code challenge from code verifier using SHA-256.
 */
function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  config?: RuntimeAuthConfig
): Promise<{ access_token: string; refresh_token: string }> {
  const response = await fetch(`${getWorkOSApiBaseUrl(config)}/authenticate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: getWorkOSClientId(),
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new MetaError('WorkOS authentication request failed', {
      errorMessage: errorText,
    });
  }

  const text = await response.text();
  return parseJsonResponse(text, TokenResponseSchema, 'token response');
}

/**
 * Start a PKCE login flow.
 *
 * Usage:
 * ```typescript
 * const { authUrl, complete } = loginWithPKCE('industry://auth/callback');
 *
 * // Open authUrl in browser
 * shell.openExternal(authUrl);
 *
 * // Later, when callback is received:
 * const token = await complete(code, state);
 * ```
 *
 * @param redirectUri The OAuth redirect URI (e.g., 'industry://auth/callback')
 * @returns Object with authUrl to open and complete function to call with callback params
 */
export function loginWithPKCE(
  redirectUri: string,
  config?: RuntimeAuthConfig
): PKCELoginFlow {
  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Store code verifier for later use
  codeVerifiersByState.set(state, codeVerifier);

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: getWorkOSClientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    provider: 'authkit',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `${getWorkOSApiBaseUrl(config)}/authorize?${params.toString()}`;

  // Return the flow object
  return {
    authUrl,
    complete: async (code: string, returnedState: string): Promise<string> => {
      // Validate state
      const storedVerifier = codeVerifiersByState.get(returnedState);
      if (!storedVerifier) {
        throw new MetaError(
          'Invalid state parameter. OAuth flow may not have been initiated properly or has expired.'
        );
      }

      // Clear the verifier
      codeVerifiersByState.delete(returnedState);

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(
        code,
        storedVerifier,
        redirectUri,
        config
      );

      // Save credentials (new login → always use v2 format)
      const storage = getCredentialsStorage({
        disableKeyring: config?.disableKeyring,
      });
      await storage.save(
        {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
        },
        { forceNew: true }
      );

      // Warm the user cache + region pin so sync getCachedRegion() readers
      // (LLM SDK construction, telemetry tags) see the right region from
      // the user's very first action post-login.
      if (config) {
        await getCachedUser(
          { type: TokenSourceType.WorkOS, token: tokens.access_token },
          config
        );
      }

      return tokens.access_token;
    },
  };
}
