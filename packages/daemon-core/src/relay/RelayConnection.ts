import {
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PING_TIMEOUT_MS,
  RelayControlType,
  RelayEnvelopeType,
  RelayFrameType,
} from '@industry/common/relay';
import {
  RelayPingSchema,
  RelayPongSchema,
} from '@industry/common/relay/schemas';
import { logError, logException, logInfo, logWarn } from '@industry/logging';
import { OtelTracing, SpanAttribute, SpanName } from '@industry/logging/tracing';
import { decodeEnvelope, encodeEnvelope } from '@industry/utils/relay';

import {
  extractMessageTraceMeta,
  injectMessageTraceMeta,
} from './trace-context';
import { UnauthedRelayConnection } from './unauthed-relay-connection';
import { MonotonicClock } from '../utils/monotonic-clock';

import type { RelayConnectionConfig, RelayTransport } from './types';
import type { TraceContextMeta } from '@industry/drool-sdk-ext/protocol/shared';
import type { Context, Span } from '@opentelemetry/api';
import type { Socket } from 'bun';

const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_BACKOFF_FACTOR = 2;

const INITIAL_CONNECT_MAX_ATTEMPTS = 3;
const INITIAL_CONNECT_RETRY_DELAY_MS = 500;
const MAX_PENDING_TUNNEL_FRAMES = 256;
const MAX_PENDING_TUNNEL_BYTES = 1024 * 1024;

interface PendingTunnelConnection {
  port: number;
  frames: Buffer[];
  byteLength: number;
  closed: boolean;
}

interface ClientFrameParams {
  clientId: string;
  frameType: RelayFrameType;
  data: string;
  spanContext: Context;
}

interface TunnelClientFrameParams {
  clientId: string;
  frameType: RelayFrameType;
  data: string;
}

/**
 * Maintains a persistent outbound WebSocket to the relay server and
 * multiplexes N remote clients onto the daemon's auth + RPC pipeline.
 *
 * Each relay clientId maps to a logical daemon connection. The web client
 * sends `daemon.authenticate` as its first JSON-RPC message, identical to
 * direct WebSocket and IPC connections.
 *
 * Reconnects to the relay with exponential backoff on disconnection.
 */
export class RelayConnection {
  private readonly config: RelayConnectionConfig;

  private readonly transport: RelayTransport;

  private readonly clientConnections = new Map<
    string,
    UnauthedRelayConnection
  >();

  private readonly tunnelConnections = new Map<string, Socket>();

  private readonly pendingTunnelConnections = new Map<
    string,
    PendingTunnelConnection
  >();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private lastPongAt = 0;

  private reconnectDelay: number;

  private stopped = false;

  /**
   * True while `start()` is driving its bounded initial-connect retry
   * loop. Suppresses reconnect-on-close scheduling so a synchronous
   * close fired by `transport.close()` after a failed initial attempt
   * doesn't race a parallel reconnect timer in alongside the explicit
   * retry loop.
   */
  private inInitialConnect = false;

  private readonly activityClock = new MonotonicClock();

  /**
   * Tracks whether the very first relay handshake has succeeded. The
   * first connect must surface failures synchronously so `daemon.start()`
   * (and therefore systemd's `Type=notify` readiness signal) reflects
   * actual relay registration. Subsequent reconnects continue to retry
   * silently with backoff so mid-session relay outages don't crash the
   * daemon.
   */
  private hasConnectedOnce = false;

  constructor(config: RelayConnectionConfig, transport: RelayTransport) {
    this.config = config;
    this.transport = transport;
    this.reconnectDelay = DEFAULT_INITIAL_DELAY_MS;
  }

  get url(): string {
    return this.config.relayUrl;
  }

  get isConnected(): boolean {
    return this.transport.isConnected;
  }

  get clientCount(): number {
    return this.clientConnections.size;
  }

  get tunnelClientCount(): number {
    return this.tunnelConnections.size;
  }

  /** Timestamp of last relay activity (client frames, tunnel data, etc.). */
  getLastActivityAt(): number {
    return this.activityClock.now();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.transport.onMessage((data) => this.handleEnvelope(data));
    this.transport.onClose((code, reason) =>
      this.handleTransportClose(code, reason)
    );
    this.transport.onError((error) =>
      RelayConnection.handleTransportError(error)
    );
    // Retry the very first relay handshake a few times to absorb
    // transient issues (DNS hiccups, relay deploy mid-flight, slow
    // sandbox network bring-up). Once connected, normal reconnect
    // backoff in `handleTransportClose` takes over.
    this.inInitialConnect = true;
    let lastError: unknown;
    try {
      for (
        let attempt = 1;
        attempt <= INITIAL_CONNECT_MAX_ATTEMPTS;
        attempt++
      ) {
        try {
          await this.connect();
          return;
        } catch (error) {
          lastError = error;
          if (this.stopped || attempt === INITIAL_CONNECT_MAX_ATTEMPTS) break;
          logWarn('[Relay] Initial connect attempt failed, retrying', {
            attempt,
            maxAttempts: INITIAL_CONNECT_MAX_ATTEMPTS,
          });
          await new Promise((resolve) => {
            setTimeout(resolve, INITIAL_CONNECT_RETRY_DELAY_MS);
          });
        }
      }
    } finally {
      this.inInitialConnect = false;
    }
    throw lastError;
  }

  stop(): void {
    this.stopped = true;
    this.clearPingTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeAll();
    this.transport.close();
    logInfo('[Relay] Connection stopped');
  }

  /** Tear down all relay client and tunnel connections (e.g. on relay disconnect). */
  closeAll(): void {
    for (const clientId of Array.from(this.clientConnections.keys())) {
      this.closeClientConnection(clientId, 'relay disconnected');
    }

    for (const [clientId, socket] of this.tunnelConnections) {
      socket.end();
      logInfo('[Relay] Closed tunnel connection', { clientId });
    }
    this.tunnelConnections.clear();

    for (const [clientId, pending] of this.pendingTunnelConnections) {
      pending.closed = true;
      pending.frames = [];
      pending.byteLength = 0;
      logInfo('[Relay] Closed pending tunnel connection', { clientId });
    }
    this.pendingTunnelConnections.clear();
  }

  // -- Transport lifecycle --------------------------------------------------

  private async connect(): Promise<void> {
    return OtelTracing.trace(SpanName.DAEMON_RELAY_CONNECT, async (span) => {
      const isInitialConnect = !this.hasConnectedOnce;
      const connectStartedAt = Date.now();
      try {
        // Re-resolve the credential on every connect attempt (including
        // reconnects) so refreshable JWTs don't get stuck on an expired
        // snapshot captured at daemon boot.
        const credentialStartedAt = Date.now();
        const credential = await this.config.resolveCredential();
        const credentialMs = Date.now() - credentialStartedAt;
        // stop() may have been called while we awaited the resolver; bail
        // before touching the transport so shutdown stays terminal.
        if (this.stopped) return;

        const timings = await this.transport.connect(this.url, credential);
        // stop() races with transport.connect(): if the socket opened after
        // stop() set `stopped = true` (and its transport.close() saw no ws
        // yet), close the freshly opened connection and skip timer setup.
        if (this.stopped) {
          this.transport.close();
          return;
        }

        this.hasConnectedOnce = true;
        this.reconnectDelay = DEFAULT_INITIAL_DELAY_MS;
        this.startPingTimer();

        // Attribute the structural daemon.start() floor to a specific
        // phase: credential refresh vs socket bring-up vs auth probe vs
        // the relay.authenticate handshake.
        const totalMs = Date.now() - connectStartedAt;
        span.setAttributes({
          [SpanAttribute.INDUSTRY_RELAY_COMPUTER_ID]: this.config.computerId,
          [SpanAttribute.INDUSTRY_RELAY_CONNECT_IS_INITIAL]: isInitialConnect,
          [SpanAttribute.INDUSTRY_RELAY_CONNECT_CREDENTIAL_MS]: credentialMs,
          [SpanAttribute.INDUSTRY_RELAY_CONNECT_SOCKET_MS]: timings.socketOpenMs,
          [SpanAttribute.INDUSTRY_RELAY_CONNECT_PROBE_MS]: timings.probeMs,
          [SpanAttribute.INDUSTRY_RELAY_CONNECT_HANDSHAKE_MS]:
            timings.handshakeMs,
          [SpanAttribute.INDUSTRY_RELAY_CONNECT_TOTAL_MS]: totalMs,
        });
        // Per-substep durations (credential/socket/probe/handshake) are
        // stamped as `industry.relay.connect.*_ms` span attributes above;
        // the log carries only the aggregate so its metadata stays flat.
        logInfo('[Relay] Connect timing', {
          computerId: this.config.computerId,
          url: this.url,
          durationMs: totalMs,
          isInitial: isInitialConnect,
        });

        logInfo('[Relay] Connected', { url: this.url });
        this.config.onStatusChange?.();
      } catch (error) {
        if (!this.hasConnectedOnce) {
          // Surface the error to the caller (start()'s retry loop).
          // `inInitialConnect` guards `handleTransportClose` from
          // queueing a parallel reconnect when transport.close() fires
          // its close callback synchronously.
          this.transport.close();
          throw error;
        }
        logException(error, '[Relay] Connection failed');
        this.scheduleReconnect();
      }
    });
  }

  private handleTransportClose(code: number, reason: string): void {
    this.clearPingTimer();
    logWarn('[Relay] Disconnected', { code, reason });
    this.closeAll();
    if (!this.stopped && !this.inInitialConnect) {
      this.config.onStatusChange?.();
      this.scheduleReconnect();
    }
  }

  private static handleTransportError(error: Error): void {
    logWarn('[Relay] Transport error', { errorMessage: error.message });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    logInfo('[Relay] Scheduling reconnect', { delay: this.reconnectDelay });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * DEFAULT_BACKOFF_FACTOR,
      DEFAULT_MAX_DELAY_MS
    );
  }

  // -- Ping / pong -----------------------------------------------------------

  private startPingTimer(): void {
    this.clearPingTimer();
    this.lastPongAt = Date.now();

    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt > DEFAULT_PING_TIMEOUT_MS) {
        logWarn('[Relay] Pong timeout, closing connection');
        this.clearPingTimer();
        this.transport.close();
        return;
      }
      try {
        this.transport.send(JSON.stringify({ type: RelayControlType.Ping }));
      } catch (error) {
        logException(error, '[Relay] Failed to send ping, closing connection');
        this.clearPingTimer();
        this.transport.close();
      }
    }, DEFAULT_PING_INTERVAL_MS);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // -- Envelope multiplexing ------------------------------------------------

  private handleEnvelope(raw: string): void {
    // Intercept relay.pong before envelope decoding (it's not a valid envelope).
    // Pong frames are not counted as activity to avoid keeping idle computers alive.
    if (raw.includes(RelayControlType.Pong)) {
      try {
        if (RelayPongSchema.safeParse(JSON.parse(raw)).success) {
          this.lastPongAt = Date.now();
          return;
        }
      } catch (err) {
        // Not JSON -- fall through to normal envelope decoding
        logWarn('[Relay] Failed to parse pong message', { cause: err });
      }
    }

    // Answer relay-initiated pings. Not counted as activity,
    // same as pong above.
    if (raw.includes(RelayControlType.Ping)) {
      let isPing = false;
      try {
        isPing = RelayPingSchema.safeParse(JSON.parse(raw)).success;
      } catch (err) {
        // Not JSON -- fall through to normal envelope decoding
        logWarn('[Relay] Failed to parse ping message', { cause: err });
      }
      if (isPing) {
        try {
          this.transport.send(JSON.stringify({ type: RelayControlType.Pong }));
        } catch (error) {
          logException(
            error,
            '[Relay] Failed to send pong, closing connection'
          );
          this.transport.close();
        }
        return;
      }
    }

    this.activityClock.update();

    let envelope;
    try {
      envelope = decodeEnvelope(raw);
    } catch (error) {
      logException(error, '[Relay] Failed to decode envelope');
      return;
    }

    switch (envelope.type) {
      case RelayEnvelopeType.ClientConnected:
        this.traceRelayForward(envelope, false, () =>
          this.handleClientConnected(envelope.clientId)
        );
        break;
      case RelayEnvelopeType.ClientDisconnected:
        this.traceRelayForward(envelope, false, () =>
          this.handleClientDisconnected(envelope.clientId)
        );
        break;
      case RelayEnvelopeType.ClientFrame:
        this.traceRelayForward(envelope, false, (_span, spanContext) =>
          this.handleClientFrame({
            clientId: envelope.clientId,
            frameType: envelope.frameType,
            data: envelope.data,
            spanContext,
          })
        );
        break;
      case RelayEnvelopeType.TunnelClientFrame:
        this.traceRelayForward(envelope, true, () =>
          this.handleTunnelClientFrame({
            clientId: envelope.clientId,
            frameType: envelope.frameType,
            data: envelope.data,
          })
        );
        break;
      case RelayEnvelopeType.TunnelClientConnected:
        this.traceRelayForward(envelope, true, () => {
          void this.handleTunnelClientConnected(
            envelope.clientId,
            envelope.port
          );
        });
        break;
      case RelayEnvelopeType.TunnelClientDisconnected:
        this.traceRelayForward(envelope, true, () =>
          this.handleTunnelClientDisconnected(envelope.clientId)
        );
        break;
      default:
        break;
    }
  }

  private traceRelayForward<T>(
    envelope: {
      clientId: string;
      _meta?: TraceContextMeta;
    },
    isTunnel: boolean,
    fn: (span: Span, spanContext: Context) => T
  ): T {
    return OtelTracing.trace(SpanName.RELAY_FORWARD, fn, {
      parentContext: OtelTracing.extractContext(envelope._meta),
      attributes: {
        [SpanAttribute.INDUSTRY_RELAY_DIRECTION]: 'client_to_daemon',
        [SpanAttribute.INDUSTRY_RELAY_CLIENT_ID]: envelope.clientId,
        [SpanAttribute.INDUSTRY_RELAY_COMPUTER_ID]: this.config.computerId,
        [SpanAttribute.INDUSTRY_RELAY_TUNNEL]: isTunnel,
      },
    });
  }

  private handleClientConnected(clientId: string): void {
    if (this.clientConnections.has(clientId)) {
      logWarn('[Relay] Duplicate clientId', { clientId });
      return;
    }

    const sendFrame = (data: string, frameType: RelayFrameType) => {
      OtelTracing.trace(
        SpanName.RELAY_FORWARD,
        (_span, spanContext) => {
          const envelope = encodeEnvelope({
            type: RelayEnvelopeType.ClientFrame,
            clientId,
            frameType,
            data,
            _meta: OtelTracing.injectContext({}, spanContext),
          });
          this.transport.send(envelope);
        },
        {
          parentContext: OtelTracing.extractContext(
            extractMessageTraceMeta(data)
          ),
          attributes: {
            [SpanAttribute.INDUSTRY_RELAY_DIRECTION]: 'daemon_to_client',
            [SpanAttribute.INDUSTRY_RELAY_CLIENT_ID]: clientId,
            [SpanAttribute.INDUSTRY_RELAY_COMPUTER_ID]: this.config.computerId,
            [SpanAttribute.INDUSTRY_RELAY_TUNNEL]: false,
          },
        }
      );
    };

    const connection = new UnauthedRelayConnection({
      clientId,
      sendFrame,
      closeClient: () => {
        this.clientConnections.delete(clientId);
        try {
          this.transport.send(
            encodeEnvelope({
              type: RelayEnvelopeType.ClientDisconnected,
              clientId,
            })
          );
        } catch (error) {
          logException(error, '[Relay] Failed to send client disconnect', {
            clientId,
          });
        }
      },
    });
    this.clientConnections.set(clientId, connection);
    logInfo('[Relay] Client connected (daemon relay)', { clientId });
  }

  private handleClientDisconnected(clientId: string): void {
    if (!this.clientConnections.has(clientId)) {
      logWarn('[Relay] Disconnect for unknown clientId', { clientId });
      return;
    }
    this.closeClientConnection(clientId, 'client disconnected');
    logInfo('[Relay] Client disconnected (daemon relay)', { clientId });
  }

  private closeClientConnection(clientId: string, reason: string): void {
    const connection = this.clientConnections.get(clientId);
    if (!connection) return;

    this.clientConnections.delete(clientId);
    connection.closeFromTransport();
    this.config.connectionHandler.handleClose(connection);
    logInfo('[Relay] Closed client connection', { clientId, reason });
  }

  // -- Tunnel lifecycle -------------------------------------------------------

  private async handleTunnelClientConnected(
    clientId: string,
    port: number
  ): Promise<void> {
    if (
      this.tunnelConnections.has(clientId) ||
      this.pendingTunnelConnections.has(clientId)
    ) {
      logWarn('[Relay] Duplicate tunnel clientId', { clientId });
      return;
    }

    const pending: PendingTunnelConnection = {
      port,
      frames: [],
      byteLength: 0,
      closed: false,
    };
    this.pendingTunnelConnections.set(clientId, pending);

    try {
      const socket = await Bun.connect({
        hostname: 'localhost',
        port,
        socket: {
          data: (_socket, data) => {
            const envelope = encodeEnvelope({
              type: RelayEnvelopeType.TunnelClientFrame,
              clientId,
              frameType: RelayFrameType.Binary,
              data: Buffer.from(data).toString('base64'),
            });
            this.transport.send(envelope);
          },
          close: () => {
            this.tunnelConnections.delete(clientId);
            logInfo('[Relay] Tunnel TCP closed', { clientId, port });
          },
          error: (_socket, error) => {
            logError('[Relay] Tunnel TCP error', {
              error: error.message,
              clientId,
              port,
            });
            this.tunnelConnections.delete(clientId);
          },
        },
      });

      if (
        pending.closed ||
        this.pendingTunnelConnections.get(clientId) !== pending
      ) {
        socket.end();
        return;
      }

      this.pendingTunnelConnections.delete(clientId);
      this.tunnelConnections.set(clientId, socket);
      for (const frame of pending.frames) {
        socket.write(frame);
      }
      logInfo('[Relay] Tunnel opened', { clientId, port });
    } catch (error) {
      if (this.pendingTunnelConnections.get(clientId) === pending) {
        this.pendingTunnelConnections.delete(clientId);
      }
      logException(error, '[Relay] Failed to connect tunnel to port', {
        port,
        clientId,
      });
    }
  }

  private handleTunnelClientDisconnected(clientId: string): void {
    const socket = this.tunnelConnections.get(clientId);
    if (!socket) {
      const pending = this.pendingTunnelConnections.get(clientId);
      if (pending) {
        pending.closed = true;
        pending.frames = [];
        pending.byteLength = 0;
        this.pendingTunnelConnections.delete(clientId);
        logInfo('[Daemon] Pending tunnel client disconnected', { clientId });
        return;
      }
      logWarn('[Relay] Tunnel disconnect for unknown clientId', { clientId });
      return;
    }
    this.tunnelConnections.delete(clientId);
    socket.end();
    logInfo('[Daemon] Tunnel client disconnected', { clientId });
  }

  // -- Client frame routing --------------------------------------------------

  private handleClientFrame(params: ClientFrameParams): void {
    const { clientId, frameType, data, spanContext } = params;
    const connection = this.clientConnections.get(clientId);
    if (!connection) {
      logWarn('[Relay] Frame for unknown clientId (daemon relay)', {
        clientId,
      });
      return;
    }

    const payload =
      frameType === RelayFrameType.Binary
        ? Buffer.from(data, 'base64').toString()
        : data;
    const tracedPayload = injectMessageTraceMeta(payload, spanContext);

    Promise.resolve(
      this.config.connectionHandler.handleMessage(connection, tracedPayload)
    ).catch((err) => logException(err, '[Relay] Message handler error'));
  }

  private handleTunnelClientFrame(params: TunnelClientFrameParams): void {
    const { clientId, frameType, data } = params;
    const buffer =
      frameType === RelayFrameType.Binary
        ? Buffer.from(data, 'base64')
        : Buffer.from(data);

    const tunnelSocket = this.tunnelConnections.get(clientId);
    if (tunnelSocket) {
      tunnelSocket.write(buffer);
      return;
    }

    const pending = this.pendingTunnelConnections.get(clientId);
    if (pending) {
      const nextFrameCount = pending.frames.length + 1;
      const nextByteLength = pending.byteLength + buffer.byteLength;
      if (
        nextFrameCount > MAX_PENDING_TUNNEL_FRAMES ||
        nextByteLength > MAX_PENDING_TUNNEL_BYTES
      ) {
        pending.closed = true;
        pending.frames = [];
        pending.byteLength = 0;
        this.pendingTunnelConnections.delete(clientId);
        logWarn('[Relay] Pending tunnel frame buffer exceeded limit', {
          clientId,
          count: nextFrameCount,
          length: nextByteLength,
          port: pending.port,
        });
        return;
      }
      pending.frames.push(buffer);
      pending.byteLength = nextByteLength;
      return;
    }

    logWarn('[Relay] Tunnel frame for unknown clientId (daemon relay)', {
      clientId,
    });
  }
}
