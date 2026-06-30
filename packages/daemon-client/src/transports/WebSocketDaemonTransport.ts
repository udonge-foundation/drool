import { RelayCloseCode } from '@industry/common/shared';
import { MetaError } from '@industry/logging/errors';
import { OtelTracing, SpanAttribute, SpanName } from '@industry/logging/tracing';
import {
  RelayAuthRequirement,
  probeRelayAuthRequirement,
} from '@industry/utils/relay';

import { RelayConnectionError, WebSocketConnectionError } from '../errors';
import { authenticateRelay } from '../relay-auth';
import { DaemonClientTransportKind } from './enums';
import { ConnectionFailureReason } from '../session/enums';
import { WebSocketConnection } from '../WebSocketConnection';

import type {
  DaemonClientTransport,
  DaemonClientTransportEvents,
  WebSocketDaemonTransportConfig,
} from './types';

export class WebSocketDaemonTransport implements DaemonClientTransport {
  private connection: WebSocketConnection;

  private readonly relayConnection: boolean;

  private readonly getAccessToken: () => Promise<string | null>;

  private readonly onHandlers = {
    open: (handler: DaemonClientTransportEvents['open']) => {
      this.connection.on('open', handler);
    },
    close: (handler: DaemonClientTransportEvents['close']) => {
      this.connection.on('close', handler);
    },
    error: (handler: DaemonClientTransportEvents['error']) => {
      this.connection.on('error', handler);
    },
    message: (handler: DaemonClientTransportEvents['message']) => {
      this.connection.on('message', handler);
    },
  } satisfies {
    [K in keyof DaemonClientTransportEvents]: (
      handler: DaemonClientTransportEvents[K]
    ) => void;
  };

  private readonly offHandlers = {
    open: (handler: DaemonClientTransportEvents['open']) => {
      this.connection.off('open', handler);
    },
    close: (handler: DaemonClientTransportEvents['close']) => {
      this.connection.off('close', handler);
    },
    error: (handler: DaemonClientTransportEvents['error']) => {
      this.connection.off('error', handler);
    },
    message: (handler: DaemonClientTransportEvents['message']) => {
      this.connection.off('message', handler);
    },
  } satisfies {
    [K in keyof DaemonClientTransportEvents]: (
      handler: DaemonClientTransportEvents[K]
    ) => void;
  };

  constructor(config: WebSocketDaemonTransportConfig) {
    this.connection = new WebSocketConnection(config);
    this.relayConnection = config.isRelayConnection ?? false;
    this.getAccessToken =
      config.getAccessToken ?? (() => Promise.resolve(null));
  }

  async connect(url: string): Promise<void> {
    await this.connection.connect(url);

    if (this.relayConnection) {
      await this.authenticateRelay(url);
    }
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  getConnectionId(): string | null {
    return this.connection.getConnectionId();
  }

  send(data: string): void {
    this.connection.send(data);
  }

  isRelayConnection(): boolean {
    return this.relayConnection;
  }

  getTransportKind(): DaemonClientTransportKind.WebSocket {
    return DaemonClientTransportKind.WebSocket;
  }

  on<T extends keyof DaemonClientTransportEvents>(
    event: T,
    handler: DaemonClientTransportEvents[T]
  ): void {
    const delegate = this.onHandlers[event] as (
      eventHandler: DaemonClientTransportEvents[T]
    ) => void;
    delegate(handler);
  }

  off<T extends keyof DaemonClientTransportEvents>(
    event: T,
    handler: DaemonClientTransportEvents[T]
  ): void {
    const delegate = this.offHandlers[event] as (
      eventHandler: DaemonClientTransportEvents[T]
    ) => void;
    delegate(handler);
  }

  private async authenticateRelay(url: string): Promise<void> {
    await OtelTracing.trace(SpanName.WEB_RELAY_AUTH, async () => {
      const requirement = await OtelTracing.trace(
        SpanName.WEB_RELAY_AUTH_PROBE,
        async () => probeRelayAuthRequirement(url)
      );
      OtelTracing.setActiveSpanAttributes({
        [SpanAttribute.INDUSTRY_RELAY_AUTH_REQUIREMENT]: requirement,
      });

      if (requirement === RelayAuthRequirement.ProbeFailed) {
        this.disconnect();
        throw new RelayConnectionError(
          ConnectionFailureReason.RelayUnreachable
        );
      }

      if (requirement === RelayAuthRequirement.RequiresAuth) {
        const token = await OtelTracing.trace(
          SpanName.WEB_RELAY_AUTH_TOKEN_FETCH,
          async () => this.getAccessToken()
        );
        if (!token) {
          this.disconnect();
          throw new RelayConnectionError(
            ConnectionFailureReason.RelayUnreachable
          );
        }

        try {
          await OtelTracing.trace(
            SpanName.WEB_RELAY_AUTH_HANDSHAKE,
            async (_span, spanContext) =>
              authenticateRelay(
                {
                  send: (data) => this.connection.send(data),
                  addMessageListener: (listener) =>
                    this.connection.on('message', listener),
                  removeMessageListener: (listener) =>
                    this.connection.off('message', listener),
                  addCloseListener: (listener) =>
                    this.connection.on('close', listener),
                  removeCloseListener: (listener) =>
                    this.connection.off('close', listener),
                  addErrorListener: (listener) =>
                    this.connection.on('error', listener),
                  removeErrorListener: (listener) =>
                    this.connection.off('error', listener),
                },
                token,
                spanContext
              )
          );
        } catch (error) {
          this.disconnect();
          if (error instanceof RelayConnectionError) {
            throw error;
          }
          throw new RelayConnectionError(
            WebSocketDaemonTransport.classifyRelayError(error),
            error instanceof Error ? error : undefined
          );
        }
      }
    });
  }

  private static classifyRelayError(error: unknown): ConnectionFailureReason {
    if (error instanceof MetaError && error.message.includes('timeout')) {
      return ConnectionFailureReason.RelayTimeout;
    }

    const wsError =
      error instanceof WebSocketConnectionError
        ? error
        : error instanceof Error &&
            error.cause instanceof WebSocketConnectionError
          ? error.cause
          : null;

    if (wsError?.closeCode != null) {
      return (
        WebSocketDaemonTransport.failureReasonFromCloseCode(
          wsError.closeCode
        ) ?? ConnectionFailureReason.RelayAuthRejected
      );
    }

    if (
      error instanceof MetaError &&
      typeof error.metadata?.code === 'number'
    ) {
      return (
        WebSocketDaemonTransport.failureReasonFromCloseCode(
          error.metadata.code
        ) ?? ConnectionFailureReason.RelayAuthRejected
      );
    }

    return ConnectionFailureReason.RelayAuthRejected;
  }

  private static failureReasonFromCloseCode(
    closeCode: number
  ): ConnectionFailureReason | null {
    switch (closeCode) {
      case RelayCloseCode.ComputerOffline:
        return ConnectionFailureReason.ComputerOffline;
      case RelayCloseCode.ComputerDisconnected:
        return ConnectionFailureReason.ComputerDisconnected;
      case RelayCloseCode.AuthTimeout:
        return ConnectionFailureReason.RelayTimeout;
      case RelayCloseCode.Unauthorized:
        return ConnectionFailureReason.RelayUnauthorized;
      default:
        return null;
    }
  }
}
