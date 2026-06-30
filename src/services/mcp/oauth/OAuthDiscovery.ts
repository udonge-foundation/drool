import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';

import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import type {
  OAuthAuthorizationChallenge,
  OAuthDiscoveryResult,
} from '@/services/mcp/oauth/types';
import { getUrlOrigin } from '@/services/mcp/oauth/url';

import type {
  OAuthProtectedResourceMetadata,
  AuthorizationServerMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Handles OAuth discovery for MCP servers to determine authentication requirements
 * and retrieve server metadata for proper OAuth configuration.
 */
export class OAuthDiscovery {
  // Some authorization servers (e.g. Vercel) host their metadata on a
  // sub-origin while keeping the canonical issuer on the parent domain, so
  // RFC 8414 §3.3's strict equality check rejects them. Log the divergence
  // and trust metadata.issuer for downstream credential keying so those
  // servers remain connectable.
  private static validateAuthorizationServerIssuer(
    authorizationServerUrl: string | URL,
    metadata: AuthorizationServerMetadata | undefined
  ): void {
    if (
      metadata?.issuer &&
      new URL(metadata.issuer).href !== new URL(authorizationServerUrl).href
    ) {
      logWarn('OAuth authorization server issuer differs from discovery URL', {
        url: getUrlOrigin(authorizationServerUrl.toString()),
        normalizedUrl: getUrlOrigin(metadata.issuer),
        reason: 'issuer_divergence',
      });
    }
  }

  private static async discoverDirectFallback(
    serverUrl: string,
    resourceMetadata?: OAuthProtectedResourceMetadata
  ): Promise<OAuthDiscoveryResult> {
    const baseUrl = new URL('/', serverUrl);
    try {
      const authServerMetadata =
        await discoverAuthorizationServerMetadata(baseUrl);
      this.validateAuthorizationServerIssuer(baseUrl, authServerMetadata);

      if (!authServerMetadata) {
        logInfo('OAuth not advertised by MCP server', {
          url: getUrlOrigin(serverUrl),
          reason: 'no_oauth_metadata',
        });
        return { requiresAuth: false };
      }

      logInfo('OAuth discovery succeeded (direct fallback)', {
        url: getUrlOrigin(serverUrl),
        baseUrl: getUrlOrigin(authServerMetadata.issuer ?? baseUrl.href),
        reason: 'direct_fallback',
      });
      return {
        requiresAuth: true,
        resourceMetadata,
        authServerMetadata,
        scopes: this.determineScopes(resourceMetadata, authServerMetadata),
      };
    } catch (error) {
      if (error instanceof MetaError) {
        throw error;
      }
      logInfo('Authorization server discovery failed (direct fallback)', {
        url: getUrlOrigin(serverUrl),
        reason: 'auth_server_discovery_failed',
        cause: error,
      });
      return { requiresAuth: false };
    }
  }

  private static resourceMetadataDiscoveryOptions(
    serverUrl: string,
    challenge?: OAuthAuthorizationChallenge
  ): { resourceMetadataUrl: URL } | undefined {
    if (!challenge?.resourceMetadataUrl) {
      return undefined;
    }

    if (!URL.canParse(challenge.resourceMetadataUrl)) {
      return undefined;
    }
    const resourceMetadataUrl = new URL(challenge.resourceMetadataUrl);

    if (
      resourceMetadataUrl.origin !== new URL(serverUrl).origin ||
      (resourceMetadataUrl.protocol !== 'https:' &&
        resourceMetadataUrl.protocol !== 'http:')
    ) {
      return undefined;
    }

    return { resourceMetadataUrl };
  }

  /**
   * Determines appropriate scopes from server metadata
   */
  private static determineScopes(
    resourceMetadata?: OAuthProtectedResourceMetadata,
    authServerMetadata?: AuthorizationServerMetadata,
    challenge?: OAuthAuthorizationChallenge
  ): string[] | undefined {
    if (challenge?.scope) {
      return challenge.scope.split(/\s+/).filter(Boolean);
    }

    // Resource metadata takes precedence
    if (resourceMetadata?.scopes_supported?.length) {
      return resourceMetadata.scopes_supported;
    }

    // Then check authorization server metadata
    if (authServerMetadata?.scopes_supported?.length) {
      return authServerMetadata.scopes_supported;
    }

    // No scopes advertised anywhere: per RFC 6749 §3.3, omit scope from the
    // authorization request so the server applies its own defaults. Inventing
    // scopes here gets rejected outright by servers like Statsig
    // (invalid_scope).
    return undefined;
  }

  /**
   * Check if a server requires OAuth and get its metadata.
   */
  static async discoverOAuthSupport(
    serverUrl: string,
    {
      challenge,
    }: {
      challenge?: OAuthAuthorizationChallenge;
    } = {}
  ): Promise<OAuthDiscoveryResult> {
    let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
    let authServerMetadata: AuthorizationServerMetadata | undefined;

    // Try to discover protected resource metadata
    try {
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(
        serverUrl,
        this.resourceMetadataDiscoveryOptions(serverUrl, challenge)
      );

      // If we have authorization servers, get their metadata
      if (resourceMetadata?.authorization_servers?.length) {
        const authServerUrl = resourceMetadata.authorization_servers[0];
        try {
          authServerMetadata =
            await discoverAuthorizationServerMetadata(authServerUrl);
          this.validateAuthorizationServerIssuer(
            authServerUrl,
            authServerMetadata
          );
        } catch (error) {
          if (error instanceof MetaError) {
            throw error;
          }
          // Continue without auth server metadata
          logInfo(
            'Authorization server discovery failed (from resource metadata)',
            {
              url: getUrlOrigin(authServerUrl),
              reason: 'auth_server_discovery_failed',
              cause: error,
            }
          );
        }

        if (authServerMetadata) {
          logInfo('OAuth discovery succeeded (resource metadata)', {
            url: getUrlOrigin(serverUrl),
            baseUrl: getUrlOrigin(authServerMetadata.issuer ?? authServerUrl),
            reason: 'resource_metadata',
          });
        }
        return {
          requiresAuth: true,
          resourceMetadata,
          authServerMetadata,
          scopes: this.determineScopes(
            resourceMetadata,
            authServerMetadata,
            challenge
          ),
        };
      }

      const fallback = await this.discoverDirectFallback(
        serverUrl,
        resourceMetadata
      );
      if (!fallback.requiresAuth) {
        return fallback;
      }
      return {
        ...fallback,
        scopes: this.determineScopes(
          fallback.resourceMetadata,
          fallback.authServerMetadata,
          challenge
        ),
      };
    } catch (error) {
      if (error instanceof MetaError) {
        throw error;
      }
      logInfo('OAuth protected resource discovery failed', {
        url: getUrlOrigin(serverUrl),
        reason: 'resource_discovery_failed',
        cause: error,
      });

      const fallback = await this.discoverDirectFallback(serverUrl);
      if (!fallback.requiresAuth) {
        return fallback;
      }
      return {
        ...fallback,
        scopes: this.determineScopes(
          fallback.resourceMetadata,
          fallback.authServerMetadata,
          challenge
        ),
      };
    }
  }
}
