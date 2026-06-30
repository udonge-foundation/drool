import {
  RelayAuthMethod,
  RelayAuthResponseType,
} from '@industry/common/relay/enums';
import { RelayAuthenticateResponseSchema } from '@industry/common/relay/schemas';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  RelayAuthRequirement,
  probeRelayAuthRequirement,
  relaySubprotocolOffer,
} from '@industry/utils/relay';

import { PreOpenConnectionError } from './errors';

import type { RelayConnectTimings, RelayTransport } from './types';
import type { AuthCredential } from '@industry/common/api/shared';
import type { RelayAuthenticateRequest } from '@industry/common/relay';

/**
 * WebSocket close code Bun reports when the relay does not echo a matching
 * `Sec-WebSocket-Protocol`, i.e. it did not negotiate our subprotocol.
 */
const WS_SUBPROTOCOL_MISMATCH_CODE = 1002;

/**
 * RelayTransport implementation backed by the standard WebSocket API
 * (available in Bun and modern Node.js).
 *
 * When a token is provided to {@link connect}, the transport performs
 * relay.authenticate as the first message and waits for a relay.auth_ok
 * response before resolving. This mirrors the daemon's
 * daemon.authenticate pattern at the relay layer.
 */
export class WebSocketRelayTransport implements RelayTransport {
  private ws: WebSocket | null = null;

  private messageHandler: ((data: string) => void) | null = null;

  private closeHandler: ((code: number, reason: string) => void) | null = null;

  private errorHandler: ((error: Error) => void) | null = null;

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(
    url: string,
    credential?: AuthCredential
  ): Promise<RelayConnectTimings> {
    // Offer the relay subprotocol on the first attempt for liveness probing.
    // Per the WHATWG spec a client that offers a subprotocol the server does
    // not echo fails the connection; Bun surfaces this as close code 1002.
    // Only that signal triggers a no-subprotocol retry, so an unrelated
    // pre-open failure is left to the normal reconnect path.
    try {
      return await this.attemptConnect(
        url,
        credential,
        relaySubprotocolOffer()
      );
    } catch (error) {
      if (error instanceof PreOpenConnectionError) {
        // The relay deploys before the daemon, so once shipped this only
        // happens during a relay rollback. This is the expected recovery
        // path and the retry usually succeeds, so log at warn rather than
        // capturing an exception to Sentry; a genuine failure of the retry
        // below surfaces through the thrown error to the caller's handler.
        logWarn(
          '[WebSocketRelayTransport] Relay did not negotiate the industry-relay subprotocol; retrying without it',
          { code: error.code, reason: error.reason }
        );
        return await this.attemptConnect(url, credential, undefined);
      }
      throw error;
    }
  }

  private async attemptConnect(
    url: string,
    credential: AuthCredential | undefined,
    subprotocols: string[] | undefined
  ): Promise<RelayConnectTimings> {
    return new Promise<RelayConnectTimings>((resolve, reject) => {
      // Phase timestamps for connect-latency attribution. `attemptStartedAt`
      // anchors socket bring-up; the probe/handshake windows are measured
      // independently because they only run on the authenticated path.
      const attemptStartedAt = Date.now();
      let socketOpenedAt: number | undefined;
      let probeMs = 0;
      let handshakeStartedAt: number | undefined;
      const ws =
        subprotocols !== undefined
          ? new WebSocket(url, subprotocols)
          : new WebSocket(url);

      // Tracks whether we're waiting for relay.auth_ok
      let awaitingRelayAuth = false;
      let settled = false;
      let opened = false;
      // Becomes true only once this socket is the live, fully-established
      // connection. Gates the close-handler notification so a pre-open
      // failure (or a stale close from a superseded attempt) is reported
      // solely through the connect() promise.
      let established = false;
      let authTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanupFailedConnection = () => {
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = undefined;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        if (
          ws.readyState !== WebSocket.CLOSED &&
          ws.readyState !== WebSocket.CLOSING
        ) {
          try {
            ws.close();
          } catch (error) {
            logWarn(
              '[WebSocketRelayTransport] Failed to close rejected relay websocket',
              { cause: error }
            );
          }
        }
      };

      const settleReject = (
        error: MetaError,
        close?: { code: number; reason: string }
      ) => {
        if (settled) return;
        settled = true;
        cleanupFailedConnection();
        if (
          !opened &&
          subprotocols !== undefined &&
          close?.code === WS_SUBPROTOCOL_MISMATCH_CODE
        ) {
          reject(new PreOpenConnectionError(error, close.code, close.reason));
          return;
        }
        reject(error);
      };

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        established = true;
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = undefined;
        }
        resolve({
          socketOpenMs: (socketOpenedAt ?? Date.now()) - attemptStartedAt,
          probeMs,
          handshakeMs:
            handshakeStartedAt !== undefined
              ? Date.now() - handshakeStartedAt
              : 0,
        });
      };

      ws.onopen = async () => {
        opened = true;
        socketOpenedAt = Date.now();
        this.ws = ws;
        try {
          if (credential) {
            // Temporary backward-compat: old relays don't understand relay.authenticate
            // and will close the connection with MalformedEnvelope. Probe health first.
            const probeStartedAt = Date.now();
            const authRequirement = await probeRelayAuthRequirement(url);
            probeMs = Date.now() - probeStartedAt;
            if (settled || ws.readyState !== WebSocket.OPEN) {
              return;
            }
            if (authRequirement === RelayAuthRequirement.RequiresAuth) {
              awaitingRelayAuth = true;
              authTimer = setTimeout(() => {
                settleReject(new MetaError('Relay authentication timed out'));
              }, 10_000);
              const request = {
                method: RelayAuthMethod.AUTHENTICATE,
                ...credential,
              } satisfies RelayAuthenticateRequest;
              handshakeStartedAt = Date.now();
              ws.send(JSON.stringify(request));
            } else if (authRequirement === RelayAuthRequirement.LegacyRelay) {
              settleResolve();
            } else {
              settleReject(new MetaError('Relay authentication probe failed'));
            }
          } else {
            settleResolve();
          }
        } catch (error) {
          logWarn('[WebSocketRelayTransport] Relay connection setup failed', {
            cause: error,
          });
          settleReject(
            error instanceof MetaError
              ? error
              : new MetaError(
                  error instanceof Error
                    ? error.message
                    : 'Relay connection setup failed'
                )
          );
        }
      };

      ws.onerror = (event) => {
        const message = 'message' in event ? String(event.message) : 'unknown';
        const error = new MetaError('WebSocket transport error', { message });
        if (!settled) {
          settleReject(error);
        } else {
          this.errorHandler?.(error);
        }
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;

        if (awaitingRelayAuth) {
          awaitingRelayAuth = false;
          let json: unknown;
          try {
            json = JSON.parse(event.data);
          } catch (err) {
            logWarn(
              '[WebSocketRelayTransport] Failed to parse relay auth response',
              { cause: err }
            );
            settleReject(new MetaError('relay auth: invalid JSON response'));
            return;
          }
          const result = RelayAuthenticateResponseSchema.safeParse(json);
          if (
            result.success &&
            result.data.type === RelayAuthResponseType.AuthOk
          ) {
            settleResolve();
          } else {
            const errorMessage =
              result.success && 'message' in result.data
                ? result.data.message
                : 'relay authentication failed';
            settleReject(new MetaError(errorMessage));
          }
          return;
        }

        this.messageHandler?.(event.data);
      };

      ws.onclose = (event) => {
        // A pre-open retry can leave the prior socket's close firing after
        // the new socket is live; only clear it if it is still the active one.
        if (this.ws === ws) {
          this.ws = null;
        }
        const close = { code: event.code, reason: event.reason };
        if (awaitingRelayAuth) {
          settleReject(
            new MetaError('WebSocket closed during relay authentication'),
            close
          );
        } else {
          settleReject(
            new MetaError(
              'WebSocket closed before relay connection was established'
            ),
            close
          );
        }
        // Only notify the close handler for a connection that actually
        // went live. A pre-open close -- including the subprotocol-mismatch
        // fallback and a stale close from a superseded attempt -- is
        // surfaced through the connect() promise, so notifying here would
        // schedule a duplicate reconnect while connect() is still retrying.
        if (established) {
          this.closeHandler?.(event.code, event.reason);
        }
      };
    });
  }

  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new MetaError('WebSocket is not connected');
    }
    this.ws.send(data);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
}
