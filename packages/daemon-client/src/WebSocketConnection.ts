import { EventEmitter } from 'eventemitter3';
import { WebSocket } from 'isows';
import { v4 as uuidv4 } from 'uuid';

import { ConnectionState } from '@industry/common/daemon';
import { WebSocketCloseCode } from '@industry/common/shared';
import { logWarn } from '@industry/logging';
import {
  OtelTracing,
  SpanName,
  SpanEvent,
  SpanAttribute,
} from '@industry/logging/tracing';
import { toError } from '@industry/utils/errors';

import { WebSocketConnectionError } from './errors';

import type { DaemonClientTransportEvents } from './transports/types';
import type { WebSocketConnectionConfig } from './types';

export class WebSocketConnection extends EventEmitter<DaemonClientTransportEvents> {
  private readonly maxConnectRetries: number;

  private readonly initialRetryDelayMs: number;

  private readonly maxRetryDelayMs: number;

  private readonly connectionTimeoutMs: number;

  private ws: WebSocket | null = null;

  private isIntentionallyClosed = false;

  private connectionId: string | null = null;

  constructor(config: WebSocketConnectionConfig) {
    super();
    this.maxConnectRetries = config.maxConnectRetries;
    this.initialRetryDelayMs = config.initialRetryDelayMs;
    this.maxRetryDelayMs = config.maxRetryDelayMs;
    this.connectionTimeoutMs = config.connectionTimeoutMs;
  }

  /**
   * Connect to WebSocket server with automatic retries and exponential backoff.
   * Retries up to maxConnectRetries with exponential backoff capped at maxRetryDelayMs.
   */
  async connect(url: string): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxConnectRetries; attempt++) {
      try {
        await this.doConnect(url);
        return;
      } catch (error) {
        lastError = toError(error);
        logWarn('[WebSocketConnection] Connection attempt failed', {
          cause: error,
        });
        if (attempt < this.maxConnectRetries) {
          const delay = Math.min(
            this.initialRetryDelayMs * 2 ** attempt,
            this.maxRetryDelayMs
          );
          await new Promise((resolve) => {
            setTimeout(resolve, delay);
          });
        }
      }
    }

    throw lastError;
  }

  /**
   * Single connection attempt with configurable timeout
   */
  private async doConnect(url: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      throw new WebSocketConnectionError('WebSocket is already connected');
    }

    this.isIntentionallyClosed = false;
    this.connectionId = uuidv4();

    await OtelTracing.trace(
      SpanName.WEBSOCKET_CONNECT,
      async (span) => {
        span.addEvent(SpanEvent.CONNECTING);

        await new Promise<void>((resolve, reject) => {
          let timeoutId: NodeJS.Timeout | null = null;
          let errorOccurred = false;

          const cleanup = () => {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            if (this.ws) {
              // eslint-disable-next-line no-use-before-define
              this.ws.removeEventListener('open', handleOpen);
              // eslint-disable-next-line no-use-before-define
              this.ws.removeEventListener('error', handleError);
              // eslint-disable-next-line no-use-before-define
              this.ws.removeEventListener('close', handleClose);
            }
          };

          const handleOpen = () => {
            span.addEvent(SpanEvent.CONNECTED);
            cleanup();
            this.emit('open');

            // Set up ongoing handlers after successful connection
            this.setupOngoingHandlers();
            resolve();
          };

          const handleError = (_event: Event) => {
            // WebSocket error events don't provide detailed error information for security reasons.
            // Don't reject here - wait for close event which has more details (code/reason).
            // Per WebSocket spec, close should always fire after error, but if close doesn't fire, the timeout will reject.
            errorOccurred = true;
            span.addEvent(SpanEvent.ERROR);
          };

          const handleClose = (event: CloseEvent) => {
            const message =
              event.reason ||
              (errorOccurred
                ? `Failed to connect to ${url}`
                : 'Connection closed before opening');
            const closeError = new WebSocketConnectionError(
              `${message} (code: ${event.code})`,
              {
                closeCode: event.code,
                closeReason: event.reason,
              }
            );
            span.addEvent(SpanEvent.CLOSED, {
              [SpanAttribute.WEBSOCKET_CLOSE_CODE]: event.code,
              [SpanAttribute.WEBSOCKET_CLOSE_REASON]: event.reason,
            });
            cleanup();
            if (!this.isIntentionallyClosed) {
              this.emit('close', event.code, event.reason);
            }
            reject(closeError);
          };

          // Add timeout for connection attempt
          timeoutId = setTimeout(() => {
            cleanup();
            if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
              this.ws.close();
            }
            // eslint-disable-next-line industry/structured-logging
            const timeoutError = new WebSocketConnectionError(
              `Connection timeout after ${this.connectionTimeoutMs}ms: ${url}`
            );
            span.addEvent(SpanEvent.TIMEOUT);
            reject(timeoutError);
          }, this.connectionTimeoutMs);

          try {
            this.ws = new WebSocket(url);
            this.ws.addEventListener('open', handleOpen);
            this.ws.addEventListener('error', handleError);
            this.ws.addEventListener('close', handleClose);
          } catch (wsError) {
            logWarn('[WebSocketConnection] Failed to create WebSocket', {
              cause: wsError,
            });
            cleanup();
            span.addEvent(SpanEvent.ERROR);
            reject(
              new WebSocketConnectionError('Failed to create WebSocket', {
                originalError: toError(wsError),
              })
            );
          }
        });
      },
      {
        attributes: {
          [SpanAttribute.WEBSOCKET_URL]: url,
          [SpanAttribute.WEBSOCKET_CONNECTION_ID]: this.connectionId,
        },
      }
    );
  }

  /**
   * Set up ongoing event handlers after successful connection
   */
  private setupOngoingHandlers(): void {
    if (!this.ws) return;

    // Set up message handler
    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event);
    });

    // Set up ongoing error handler
    this.ws.addEventListener('error', (_event) => {
      // WebSocket error events don't provide detailed error information for security reasons

      const error = new WebSocketConnectionError('WebSocket error occurred');
      this.emit('error', error);
    });

    // Set up ongoing close handler
    this.ws.addEventListener('close', (event) => {
      if (!this.isIntentionallyClosed) {
        this.emit('close', event.code, event.reason);
      }
      this.ws = null;
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.isIntentionallyClosed = true;

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(WebSocketCloseCode.NORMAL_CLOSURE, 'Client disconnect');
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        // If still connecting, force close
        this.ws.close();
      }
      this.ws = null;
    }

    this.connectionId = null;
  }

  /**
   * Get the current connection ID for tracing
   * Returns null if not connected
   */
  getConnectionId(): string | null {
    return this.connectionId;
  }

  /**
   * Send data through WebSocket
   */
  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new WebSocketConnectionError('WebSocket is not connected');
    }

    try {
      this.ws.send(data);
    } catch (error) {
      throw new WebSocketConnectionError('Failed to send WebSocket message', {
        originalError: toError(error),
      });
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Check if WebSocket is currently connecting
   */
  isConnecting(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.CONNECTING;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    if (!this.ws) return ConnectionState.Disconnected;

    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return ConnectionState.Connecting;
      case WebSocket.OPEN:
        return ConnectionState.Connected;
      case WebSocket.CLOSING:
        return ConnectionState.Closing;
      case WebSocket.CLOSED:
      default:
        return ConnectionState.Disconnected;
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      this.emit('message', event.data);
    } else {
      const error = new WebSocketConnectionError(
        'Received non-string WebSocket message'
      );
      this.emit('error', error);
    }
  }
}
