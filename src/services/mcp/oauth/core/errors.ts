import { MetaError } from '@industry/logging/errors';

// Base class for MCP OAuth failures that carry user-actionable guidance.
// `metadata.errorMessage` holds the guidance, which the connect path surfaces
// verbatim (see http/shared.ts) instead of collapsing it into a generic
// connection failure; `metadata.reason` is a granular telemetry code.
export class McpOAuthGuidanceError extends MetaError {
  constructor(
    message: string,
    metadata: {
      name: string;
      reason: string;
      errorMessage: string;
      url?: string;
      baseUrl?: string;
      timeout?: number;
      cause?: unknown;
    }
  ) {
    super(message, metadata);
    this.name = 'McpOAuthGuidanceError';
    Object.setPrototypeOf(this, McpOAuthGuidanceError.prototype);
  }
}

// Thrown when an authorization server cannot mint a client dynamically (no
// registration_endpoint, or it rejects DCR).
export class McpClientRegistrationUnavailableError extends McpOAuthGuidanceError {
  constructor(
    authorizationServerIssuer: string,
    serverName: string,
    serverUrlOrigin: string,
    cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const reason = message.includes(
      'does not support dynamic client registration'
    )
      ? 'registration_unsupported'
      : 'registration_failed';
    super(
      'MCP OAuth requires a pre-registered client because dynamic client registration is unavailable',
      {
        name: serverName,
        url: serverUrlOrigin,
        reason,
        cause,
        errorMessage:
          `This server's authorization server does not support dynamic client registration, ` +
          `or rejected the request. Add a pre-registered OAuth client to its MCP config:\n` +
          `  "oauth": {\n` +
          `    "authorizationServerIssuer": "${authorizationServerIssuer}",\n` +
          `    "clientId": "<your-client-id>",\n` +
          `    "clientSecret": "<your-client-secret>"\n` +
          `  }`,
      }
    );
    this.name = 'McpClientRegistrationUnavailableError';
    Object.setPrototypeOf(
      this,
      McpClientRegistrationUnavailableError.prototype
    );
  }
}
