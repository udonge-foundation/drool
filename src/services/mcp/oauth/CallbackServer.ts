import http from 'http';
import { URL } from 'url';

import { logInfo, logWarn, Metrics } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';

import {
  renderOAuthErrorPage,
  renderOAuthSuccessPage,
} from '@/services/mcp/oauth/callbackPages';
import {
  MCP_OAUTH_CALLBACK_MAX_PORT_ATTEMPTS,
  MCP_OAUTH_CALLBACK_START_PORT,
} from '@/services/mcp/oauth/constants';

interface OAuthCallbackServerOptions {
  startPort?: number;
  maxAttempts?: number;
}

interface OAuthCallbackResult {
  /** The authorization code returned by the OAuth provider */
  code: string;
  /** The state parameter used to prevent CSRF attacks and identify the OAuth flow */
  state: string;
}

interface WaitForCallbackWithStateParams {
  /** Unique state string to identify this OAuth flow */
  state: string;
  /** Server name for logging */
  serverName: string;
}

interface PendingOAuthCallback {
  resolve: (value: OAuthCallbackResult) => void;
  reject: (reason?: Error) => void;
  serverName: string;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }

  return String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(getErrorMessage(error));
}

function hasPortInUseMessage(error: unknown): boolean {
  return /address already in use|is port \d+ in use\?/i.test(
    getErrorMessage(error)
  );
}

function normalizeListenError(error: unknown): NodeJS.ErrnoException {
  const baseError = toError(error);
  const normalizedError = new Error(baseError.message) as NodeJS.ErrnoException;

  normalizedError.name = baseError.name;
  normalizedError.stack = baseError.stack;

  if (error instanceof Error) {
    Object.assign(normalizedError, error);
  } else if (typeof error === 'object' && error !== null) {
    Object.assign(normalizedError, error);
  }

  if (!normalizedError.code && hasPortInUseMessage(error)) {
    normalizedError.code = 'EADDRINUSE';
  }

  return normalizedError;
}

/**
 * Local HTTP server to handle OAuth redirect callbacks.
 * Listens on localhost and waits for the authorization code.
 * Supports multiple concurrent OAuth flows using state parameter.
 */
export class OAuthCallbackServer {
  private server: http.Server | null = null;

  private readonly startPort: number;

  private readonly maxAttempts: number;

  private port: number;

  /** Map of state -> pending callback for concurrent OAuth flows */
  private pendingCallbacks: Map<string, PendingOAuthCallback> = new Map();

  constructor(options: OAuthCallbackServerOptions = {}) {
    this.startPort = options.startPort ?? MCP_OAUTH_CALLBACK_START_PORT;
    this.maxAttempts =
      options.maxAttempts ?? MCP_OAUTH_CALLBACK_MAX_PORT_ATTEMPTS;
    this.port = this.startPort; // Will be updated to actual bound port
  }

  /**
   * Start the HTTP server. Should be called once before any OAuth flows.
   * Tries sequential ports starting from startPort until it finds an available one.
   */
  async start(): Promise<void> {
    if (this.server) {
      return; // Already started (idempotent)
    }

    let lastError: Error | null = null;
    let retryCount = 0;
    let outcome = 'error';

    try {
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        const portToTry = this.startPort + attempt;

        try {
          await this.tryStartOnPort(portToTry);
          this.port = portToTry; // Update to actual bound port
          logInfo('OAuth callback server started', { port: portToTry });
          outcome = 'success';
          return; // Success!
        } catch (error) {
          const listenError = normalizeListenError(error);

          if (listenError.code === 'EADDRINUSE') {
            retryCount += 1;
            lastError = listenError;
            logWarn('OAuth callback port is in use, retrying on next port', {
              port: portToTry,
              attempt: attempt + 1,
              maxAttempts: this.maxAttempts,
              error: listenError.message,
            });
            continue; // Try next port
          }
          // Other errors (permissions, network, etc.) are fatal
          throw listenError;
        }
      }

      // All ports exhausted
      throw new MetaError('Failed to start OAuth callback server', {
        attempt: this.maxAttempts,
        cause: lastError,
      });
    } finally {
      Metrics.addToCounter(
        Metric.MCP_CALLBACK_SERVER_PORT_RETRY_COUNT,
        retryCount,
        { outcome }
      );
    }
  }

  /**
   * Try to start the server on a specific port.
   */
  private tryStartOnPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url === '/favicon.ico') {
          res.writeHead(404).end();
          return;
        }

        const url = new URL(req.url || '', `http://127.0.0.1:${port}`);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        const pending = state ? this.pendingCallbacks.get(state) : null;

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(renderOAuthErrorPage(`Error: ${error}`));
          const errorObj = new MetaError('OAuth authorization failed', {
            errorMessage: error,
          });
          if (pending) {
            pending.reject(errorObj);
            this.pendingCallbacks.delete(state!);
          } else {
            logWarn('OAuth error callback received without matching state', {
              hasState: Boolean(state),
              error,
            });
          }
        } else if (!code) {
          res.writeHead(400).end();
          const errorObj = new MetaError('No authorization code provided');
          if (pending) {
            pending.reject(errorObj);
            this.pendingCallbacks.delete(state!);
          } else {
            logWarn('OAuth callback received without authorization code');
          }
        } else if (!state) {
          res.writeHead(400).end();
          const errorObj = new MetaError('No state parameter provided');
          if (pending) {
            pending.reject(errorObj);
            this.pendingCallbacks.delete(state!);
          } else {
            logWarn('OAuth callback received without state parameter');
          }
        } else if (pending) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(renderOAuthSuccessPage());
          logInfo('OAuth callback received for server', {
            name: pending.serverName,
          });
          pending.resolve({ code, state });
          this.pendingCallbacks.delete(state);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            renderOAuthErrorPage(
              'No matching authorization flow found for this callback.'
            )
          );
          logWarn('OAuth callback received without matching pending flow', {
            pendingRequestCount: this.pendingCallbacks.size,
          });
        }
      });

      // CRITICAL: Register error handler BEFORE calling listen() to avoid race condition
      // where error event fires before handler is attached, causing infinite hang
      this.server.on('error', (error) => {
        this.server = null; // Clean up on error
        reject(error);
      });

      this.server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  /**
   * Wait for OAuth callback with state-based tracking.
   * Supports multiple concurrent OAuth flows by using the state parameter.
   */
  async waitForCallbackWithState({
    state,
    serverName,
  }: WaitForCallbackWithStateParams): Promise<OAuthCallbackResult> {
    if (!this.server) {
      throw new MetaError('Callback server not started. Call start() first.');
    }

    return this.waitForPendingCallbackWithState({ state, serverName });
  }

  /**
   * Wait for an OAuth code that will be relayed through submitCodeForState().
   * Remote/daemon sessions use this path because they do not bind a local
   * callback listener.
   */
  async waitForSubmittedCodeWithState({
    state,
    serverName,
  }: WaitForCallbackWithStateParams): Promise<OAuthCallbackResult> {
    return this.waitForPendingCallbackWithState({ state, serverName });
  }

  private waitForPendingCallbackWithState({
    state,
    serverName,
  }: WaitForCallbackWithStateParams): Promise<OAuthCallbackResult> {
    // Cancel any existing callback for this state
    const existing = this.pendingCallbacks.get(state);
    if (existing) {
      logWarn('Replacing existing pending callback for state', {
        name: existing.serverName,
      });
      existing.reject(new MetaError('OAuth flow replaced'));
    }

    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(state, { resolve, reject, serverName });
      logInfo('Registered OAuth callback', {
        name: serverName,
        pendingRequestCount: this.pendingCallbacks.size,
      });
    });
  }

  /**
   * Cancel pending callback for a specific state.
   * @param state - The state to cancel
   */
  cancelPendingCallbackForState(state: string): void {
    const pending = this.pendingCallbacks.get(state);
    if (pending) {
      logInfo('Cancelling OAuth callback for state', {
        name: pending.serverName,
      });
      pending.reject(new MetaError('OAuth flow cancelled'));
      this.pendingCallbacks.delete(state);
    }
  }

  /**
   * Cancel all pending callbacks for a specific server.
   * @param serverName - The server name to cancel callbacks for
   */
  cancelPendingCallbacksForServer(serverName: string): number {
    let cancelledCount = 0;

    for (const [state, pending] of this.pendingCallbacks.entries()) {
      if (pending.serverName === serverName) {
        logInfo('Cancelling OAuth callback for server', {
          name: serverName,
        });
        pending.reject(new MetaError('OAuth flow cancelled'));
        this.pendingCallbacks.delete(state);
        cancelledCount += 1;
      }
    }

    return cancelledCount;
  }

  /**
   * Cancel all pending callbacks.
   * Used during config changes to ensure clean state.
   */
  cancelAllPendingCallbacks(): void {
    logInfo('Cancelling all pending OAuth callbacks', {
      count: this.pendingCallbacks.size,
    });
    for (const pending of this.pendingCallbacks.values()) {
      logInfo('Cancelling OAuth callback', {
        name: pending.serverName,
      });
      pending.reject(new MetaError('OAuth flow cancelled'));
    }
    this.pendingCallbacks.clear();
  }

  /**
   * Submit an authorization code for a specific OAuth flow identified by state.
   * Used by remote/daemon sessions where the callback URL is not accessible locally.
   * The frontend relays the code through the daemon protocol.
   * @returns true if a matching pending callback was found and resolved
   */
  submitCodeForState(params: {
    state: string;
    serverName: string;
    code: string;
  }): boolean {
    const pending = this.pendingCallbacks.get(params.state);
    if (!pending || pending.serverName !== params.serverName) {
      logInfo('No pending callback for state', {
        pendingRequestCount: this.pendingCallbacks.size,
      });
      return false;
    }

    logInfo('Resolving pending callback with submitted code', {
      name: pending.serverName,
    });
    pending.resolve({ code: params.code, state: params.state });
    this.pendingCallbacks.delete(params.state);
    return true;
  }

  submitErrorForState(params: {
    state: string;
    serverName: string;
    error: string;
    errorDescription?: string;
  }): boolean {
    const pending = this.pendingCallbacks.get(params.state);
    if (!pending || pending.serverName !== params.serverName) {
      logInfo('No pending callback for OAuth error', {
        pendingRequestCount: this.pendingCallbacks.size,
      });
      return false;
    }

    pending.reject(
      new MetaError('OAuth authorization failed', {
        errorMessage: params.error,
        ...(params.errorDescription ? { reason: params.errorDescription } : {}),
      })
    );
    this.pendingCallbacks.delete(params.state);
    return true;
  }

  close(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch (_error) {
        // Log but don't throw - close() should be safe to call
      } finally {
        this.server = null;
      }
    }
  }

  get isStarted(): boolean {
    return !!this.server;
  }

  getPort(): number {
    return this.port;
  }

  getRedirectUri(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }
}
