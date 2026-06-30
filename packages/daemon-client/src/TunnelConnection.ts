import { EventEmitter } from 'eventemitter3';
import { WebSocket } from 'isows';

import { WebSocketCloseCode } from '@industry/common/shared';
import { MetaError } from '@industry/logging';
import {
  IndustryDaemonTransport,
  OtelTracing,
  SpanAttribute,
  SpanName,
} from '@industry/logging/tracing';
import { retry } from '@industry/utils/function';

import { authenticateRelay } from './relay-auth';

import type { TunnelConnectionEvents, TunnelConnectionOptions } from './types';

const CONNECT_TIMEOUT_MS = 30_000;
const MAX_CONNECT_RETRIES = 10;
const CONNECT_RETRY_POLL_INTERVAL_MS = 2_000;

/**
 * A raw binary WebSocket tunnel to a daemon's localhost port via the relay.
 *
 * Connects to the relay's `/v0/computer/:id/tunnel?port=X` route, performs
 * relay auth, then provides a bidirectional binary stream.
 */
export class TunnelConnection extends EventEmitter<TunnelConnectionEvents> {
  private ws: WebSocket | null = null;

  private readonly options: TunnelConnectionOptions;

  constructor(options: TunnelConnectionOptions) {
    super();
    this.options = options;
  }

  /* eslint-disable no-use-before-define -- mutual recursion between handlers */
  private doConnect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        ws.close();
        reject(new MetaError('Tunnel connection timeout', { url }));
      }, CONNECT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
      };

      const onOpen = () => {
        cleanup();
        this.ws = ws;
        this.setupConnectHandlers();
        resolve();
      };

      const onError = () => {
        // Wait for close event
      };

      const onClose = (event: CloseEvent) => {
        cleanup();
        reject(
          new MetaError('Tunnel connection failed', {
            reason: event.reason,
            code: event.code,
          })
        );
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    });
  }

  // Callers must ensure the sandbox is awake before calling connect().
  // connectWithRetry handles this via its ensureRunning param.
  async connect(): Promise<void> {
    const url = new URL(
      `/v0/computer/${this.options.computerId}/tunnel`,
      this.options.relayUrl.replace(/^http/, 'ws')
    );
    url.searchParams.set('port', String(this.options.port));

    const maxRetries = MAX_CONNECT_RETRIES;

    await OtelTracing.trace(
      SpanName.WEBSOCKET_CONNECT,
      async () => {
        const attempt = retry(
          async () => {
            try {
              await this.doConnect(url.toString());
              await this.authenticateRelay();
              this.setupDataHandlers();
            } catch (error) {
              this.close();
              throw error;
            }
          },
          {
            retries: maxRetries + 1,
            delay: CONNECT_RETRY_POLL_INTERVAL_MS,
          }
        );

        await attempt();
      },
      {
        attributes: {
          [SpanAttribute.WEBSOCKET_URL]: url.toString(),
          [SpanAttribute.INDUSTRY_DAEMON_TRANSPORT]:
            IndustryDaemonTransport.WsRelay,
          'industry.relay.target_port': this.options.port,
          'industry.relay.computer_id': this.options.computerId,
        },
      }
    );
  }

  send(data: ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new MetaError('Tunnel is not connected');
    }
    this.ws.send(data);
  }

  close(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(WebSocketCloseCode.NORMAL_CLOSURE, 'tunnel closed');
      }
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /* eslint-enable no-use-before-define */

  private setupConnectHandlers(): void {
    if (!this.ws) return;

    this.ws.addEventListener('close', (event) => {
      this.emit('close', event.code, event.reason);
      this.ws = null;
    });

    this.ws.addEventListener('error', () => {
      this.emit('error', new Error('Tunnel WebSocket error'));
    });
  }

  private setupDataHandlers(): void {
    if (!this.ws) return;

    this.ws.addEventListener('message', (event) => {
      const { data } = event;
      if (data instanceof ArrayBuffer) {
        this.emit('data', data);
      } else if (ArrayBuffer.isView(data)) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        this.emit('data', copy.buffer);
      } else if (typeof data !== 'string') {
        this.emit('data', new Uint8Array(data as never).buffer);
      }
    });
  }

  private async authenticateRelay(): Promise<void> {
    const token = await this.options.getAccessToken();
    if (!token) {
      this.close();
      throw new MetaError('No access token for relay authentication');
    }

    if (!this.ws) {
      throw new MetaError('Not connected');
    }

    const ws = this.ws;
    const wrappedHandlers = new Map<
      (data: string) => void,
      (e: MessageEvent) => void
    >();

    return authenticateRelay(
      {
        send: (data) => ws.send(data),
        addMessageListener: (listener) => {
          const handler = (event: MessageEvent) => {
            if (typeof event.data === 'string') listener(event.data);
          };
          wrappedHandlers.set(listener, handler);
          ws.addEventListener('message', handler);
        },
        removeMessageListener: (listener) => {
          const handler = wrappedHandlers.get(listener);
          if (handler) {
            ws.removeEventListener('message', handler);
            wrappedHandlers.delete(listener);
          }
        },
      },
      token,
      // TunnelConnection.authenticateRelay runs inside the outer
      // WEBSOCKET_CONNECT trace; no inner handshake span to capture a
      // bulletproof spanContext from. getCurrentContext() is safe here
      // because TunnelConnection only runs in Node (CLI), where
      // AsyncHooks preserves the active context across awaits.
      OtelTracing.getCurrentContext()
    );
  }
}
