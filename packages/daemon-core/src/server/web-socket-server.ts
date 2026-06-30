import { posix as pathPosix } from 'path';

import { Server, ServerWebSocket } from 'bun';

import { WebSocketCloseCode } from '@industry/common/shared';
import {
  logException,
  logInfo,
  logWarn,
  Metric,
  Metrics,
} from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { DEFAULT_E2B_KILL_TIMEOUT_MS } from '@industry/utils/workspaces';

import {
  DAEMON_PROXY_TOKEN_COOKIE_NAME,
  DAEMON_PROXY_TOKEN_QUERY_PARAM,
} from './auth/constants';
import { getDaemonProxyToken } from './auth/proxy-token';
import { WebSocketType } from './enums';
import { UnauthedWebSocketConnection } from './unauthed-web-socket-connection';
import { debugLog } from '../utils/debug-log';
import { MonotonicClock } from '../utils/monotonic-clock';

import type {
  DaemonConfig,
  DaemonConnectionLifecycleHandler,
  DaemonTransportServer,
  DaemonWebSocket,
  JsonRpcWebSocketHandler,
  JsonRpcWsData,
  PortProxyWsData,
  WebSocketData,
} from './types';

// Align with idle timeout for E2B machines
const WEBSOCKET_IDLE_TIMEOUT_SECONDS = DEFAULT_E2B_KILL_TIMEOUT_MS / 1000;

// Retry config for Bun.serve() on TCP when the port is temporarily in
// TIME_WAIT after killing a previous daemon process (common on Windows).
const SERVE_BIND_MAX_RETRIES = 5;
const SERVE_BIND_INITIAL_DELAY_MS = 500;

function isEADDRINUSE(err: unknown): boolean {
  if (err instanceof Error) {
    if ('code' in err && err.code === 'EADDRINUSE') return true;
    // Bun may wrap the error message instead of setting a code.
    // On Windows, Bun surfaces all listen failures (EADDRINUSE, EACCES,
    // TIME_WAIT) as "Failed to start server. Is port <N> in use?" without
    // setting an error code (oven-sh/bun#7187). Match that pattern so
    // the retry loop engages for port conflicts on Windows.
    if (
      err.message.includes('EADDRINUSE') ||
      err.message.includes('address already in use') ||
      /is port \d+ in use\?/i.test(err.message)
    )
      return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Interval for websocket pings to client
const PING_INTERVAL_MS = 30000;

const PORT_PROXY_HEADER_ALLOWLIST = [
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-modified-since',
  'if-none-match',
  'pragma',
  'range',
  'user-agent',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
] as const;

const LOCALHOST_PROXY_HOSTS = new Set(['localhost', '127.0.0.1']);

type PortProxyWsConnection = {
  socket: WebSocket;
  pendingMessages: Array<string | Buffer>;
};

function buildPortProxyAuthCookie(
  token: string,
  port: number,
  reqUrl: URL
): string {
  const base = `${DAEMON_PROXY_TOKEN_COOKIE_NAME}=${token}; Path=/port-proxy/${port}; HttpOnly; SameSite=Strict`;
  return reqUrl.protocol === 'https:' ? `${base}; Secure` : base;
}

function authorizeProxyRequest(
  req: Request,
  url: URL
): { authorized: boolean; shouldSetCookie: boolean } {
  const expected = getDaemonProxyToken();
  if (!expected) {
    return { authorized: false, shouldSetCookie: false };
  }

  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookies = Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return idx === -1
          ? [part, '']
          : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      })
  );

  if (cookies[DAEMON_PROXY_TOKEN_COOKIE_NAME] === expected) {
    return { authorized: true, shouldSetCookie: false };
  }

  const queryToken = url.searchParams.get(DAEMON_PROXY_TOKEN_QUERY_PARAM);
  if (queryToken === expected) {
    return { authorized: true, shouldSetCookie: true };
  }

  const headerToken = req.headers.get('x-industryd-proxy-token');
  if (headerToken === expected) {
    return { authorized: true, shouldSetCookie: false };
  }

  return { authorized: false, shouldSetCookie: false };
}

function rewritePortProxyLocation(location: string, port: number): string {
  try {
    const target = new URL(location, `http://localhost:${port}/`);
    const targetPort =
      target.port || (target.protocol === 'https:' ? '443' : '80');

    if (
      !LOCALHOST_PROXY_HOSTS.has(target.hostname) ||
      targetPort !== `${port}`
    ) {
      return location;
    }

    const rewrittenPath = `/port-proxy/${port}${target.pathname}`;
    return `${rewrittenPath}${target.search}${target.hash}`;
  } catch (err) {
    logWarn('[PortProxy] Failed to rewrite redirect location', {
      location,
      cause: err instanceof Error ? err.message : String(err),
    });
    return location;
  }
}

async function proxyToLocalPort(
  req: Request,
  port: number,
  sanitizedPath: string,
  search: string
): Promise<Response> {
  const targetUrl = `http://localhost:${port}${sanitizedPath}${search}`;
  try {
    const headers = new Headers();
    for (const name of PORT_PROXY_HEADER_ALLOWLIST) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }

    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.body,
      redirect: 'manual',
    });

    const respHeaders = new Headers(resp.headers);
    respHeaders.delete('Content-Encoding');
    respHeaders.delete('Content-Length');
    respHeaders.set('Referrer-Policy', 'no-referrer');

    const location = respHeaders.get('Location');
    if (location) {
      respHeaders.set('Location', rewritePortProxyLocation(location, port));
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    logWarn('[PortProxy] Failed to proxy request', {
      port,
      path: sanitizedPath,
      cause: err instanceof Error ? err.message : String(err),
    });
    return new Response('Service unavailable on target port', {
      status: 502,
    });
  }
}

function isJsonRpcWs(
  ws: ServerWebSocket<WebSocketData>
): ws is ServerWebSocket<JsonRpcWsData> {
  return ws.data.type === WebSocketType.JSONRPC;
}

export class DaemonWebSocketServer implements DaemonTransportServer {
  private server: Server<WebSocketData> | null = null;

  private readonly connectionHandler: DaemonConnectionLifecycleHandler;

  private readonly config: DaemonConfig;

  private readonly unauthenticatedConnections = new WeakMap<
    DaemonWebSocket,
    UnauthedWebSocketConnection
  >();

  /**
   * Tracks ping intervals for each WebSocket connection.
   * Used to send periodic pings to keep connections alive.
   */
  private readonly pingIntervals = new WeakMap<
    DaemonWebSocket,
    ReturnType<typeof setInterval>
  >();

  private readonly activeJsonRpcWebSockets = new Set<DaemonWebSocket>();

  private readonly activityClock = new MonotonicClock();

  private readonly portProxyWsConnections = new WeakMap<
    ServerWebSocket<WebSocketData>,
    PortProxyWsConnection
  >();

  constructor(
    connectionHandler: DaemonConnectionLifecycleHandler,
    config: DaemonConfig
  ) {
    this.config = config;
    this.connectionHandler = connectionHandler;
  }

  private getJsonRpcWebSocketHandler(): JsonRpcWebSocketHandler {
    return {
      open: (ws: DaemonWebSocket) => this.handleJsonRpcOpen(ws),
      message: (ws: DaemonWebSocket, message: string | Buffer) =>
        this.handleJsonRpcMessage(ws, message).catch((error) => {
          this.handleJsonRpcError(error);
        }),
      close: (ws: DaemonWebSocket, code: number, reason: string) =>
        this.handleJsonRpcClose(ws, code, reason),
      pong: (ws: DaemonWebSocket) => this.handleJsonRpcPong(ws),
    };
  }

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const fetchHandler = (req: Request, server: Server<WebSocketData>) => {
      const url = new URL(req.url);

      if (req.method === 'GET' && url.pathname === '/health') {
        // Body is intentionally specific (rather than a bare "ok") so the
        // desktop's pre-kill HTTP probe in
        // `apps/desktop/src/main/daemon/manager.ts::probeIndustryDaemonOnPort`
        // can positively identify a Industry daemon on a fixed preselected
        // port without depending on `Win32_Process` introspection (which
        // EDR / Windows 24H2 hardening can silently filter). The desktop
        // probe also accepts the legacy `ok` body for in-flight upgrades.
        return new Response('industry-daemon ok', { status: 200 });
      }

      // Port proxy: forward requests to localhost:<port> on the daemon machine
      if (url.pathname.startsWith('/port-proxy/')) {
        const match = url.pathname.match(/^\/port-proxy\/(\d+)(\/.*)?$/);
        if (!match) {
          return new Response('Invalid port-proxy path', { status: 400 });
        }

        const port = parseInt(match[1], 10);
        if (Number.isNaN(port) || port < 1024 || port > 65535) {
          return new Response('Port must be between 1024 and 65535', {
            status: 400,
          });
        }

        const auth = authorizeProxyRequest(req, url);
        if (!auth.authorized) {
          return new Response('Unauthorized', { status: 401 });
        }

        const queryToken = url.searchParams.get(DAEMON_PROXY_TOKEN_QUERY_PARAM);
        const isWebSocketUpgrade =
          req.headers.get('upgrade')?.toLowerCase() === 'websocket';
        if (
          queryToken &&
          !isWebSocketUpgrade &&
          (req.method === 'GET' || req.method === 'HEAD')
        ) {
          const cleanAuthUrl = new URL(req.url);
          cleanAuthUrl.searchParams.delete(DAEMON_PROXY_TOKEN_QUERY_PARAM);
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${cleanAuthUrl.pathname}${cleanAuthUrl.search}`,
              'Referrer-Policy': 'no-referrer',
              'Set-Cookie': buildPortProxyAuthCookie(queryToken, port, url),
            },
          });
        }

        const forwardPath = match[2] ?? '/';
        const cleanedUrl = new URL(req.url);
        cleanedUrl.searchParams.delete(DAEMON_PROXY_TOKEN_QUERY_PARAM);
        const search = cleanedUrl.search;

        // Sanitize path to prevent SSRF/CRLF injection
        const sanitizedPath = pathPosix.normalize(
          forwardPath.replace(/[\r\n]/g, '').replace(/\\/g, '/')
        );

        if (sanitizedPath !== '/' && !sanitizedPath.startsWith('/')) {
          logWarn('[PortProxy] Path traversal rejected', {
            targetPath: `${forwardPath} -> ${sanitizedPath}`,
          });
          return new Response('Invalid path', { status: 400 });
        }

        if (
          sanitizedPath !== '/' &&
          !/^\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/.test(sanitizedPath)
        ) {
          logWarn('[PortProxy] Invalid path rejected', {
            targetPath: `${forwardPath} -> ${sanitizedPath}`,
          });
          return new Response('Invalid path', { status: 400 });
        }

        if (isWebSocketUpgrade) {
          const ppData: PortProxyWsData = {
            type: WebSocketType.PORT_PROXY,
            targetUrl: `ws://localhost:${port}${sanitizedPath}${search}`,
          };
          const upgraded = server!.upgrade(req, { data: ppData });
          if (!upgraded) {
            return new Response('WebSocket upgrade failed', { status: 400 });
          }
          return undefined;
        }

        return proxyToLocalPort(req, port, sanitizedPath, search);
      }

      // Handle WebSocket upgrades
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        // Regular WebSocket connection (JSON-RPC)
        const jsonRpcData: JsonRpcWsData = { type: WebSocketType.JSONRPC };
        const upgraded = server!.upgrade(req, { data: jsonRpcData });
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', {
            status: 400,
          });
        }
        return undefined;
      }

      return new Response('Not Found', { status: 404 });
    };

    const jsonRpcWebSocketHandler = this.getJsonRpcWebSocketHandler();

    // Create unified WebSocket handler that routes to port proxy or JSON-RPC.
    const websocketHandler = {
      open: (ws: ServerWebSocket<WebSocketData>) => {
        this.activityClock.update();
        if (ws.data.type === WebSocketType.PORT_PROXY) {
          this.connectPortProxyWs(ws, ws.data.targetUrl);
        } else if (isJsonRpcWs(ws)) {
          jsonRpcWebSocketHandler.open(ws);
        }
      },
      message: (
        ws: ServerWebSocket<WebSocketData>,
        message: string | Buffer
      ) => {
        this.activityClock.update();
        if (ws.data.type === WebSocketType.PORT_PROXY) {
          this.handlePortProxyWsMessage(ws, message);
        } else if (isJsonRpcWs(ws)) {
          void jsonRpcWebSocketHandler.message(ws, message);
        }
      },
      close: (
        ws: ServerWebSocket<WebSocketData>,
        code: number,
        reason: string
      ) => {
        this.activityClock.update();
        if (ws.data.type === WebSocketType.PORT_PROXY) {
          this.closePortProxyWs(ws);
        } else if (isJsonRpcWs(ws)) {
          jsonRpcWebSocketHandler.close(ws, code, reason);
        }
      },
      pong: (ws: ServerWebSocket<WebSocketData>) => {
        if (isJsonRpcWs(ws)) {
          jsonRpcWebSocketHandler.pong(ws);
        }
      },
    };

    if ('unix' in this.config && this.config.unix) {
      const unix = this.config.unix;
      // Unix socket mode - used with systemd-socket-proxyd for zero-downtime restarts
      // The proxy handles TCP connections on port 37643 and forwards to this Unix socket.
      // During industryd restart, TCP connections queue at the proxy level.
      this.server = Bun.serve({
        unix,
        fetch: fetchHandler,
        websocket: {
          ...websocketHandler,
          idleTimeout: WEBSOCKET_IDLE_TIMEOUT_SECONDS,
          perMessageDeflate: false, // Disable compression for lower latency
        },
      });

      logInfo('industryd listening on Unix socket', {
        path: unix,
      });
    } else {
      // TCP mode (default) -- retry on EADDRINUSE with exponential backoff.
      // On Windows the previous daemon's socket can linger in TIME_WAIT
      // after a force-kill, causing the new Bun.serve() to fail transiently.
      if (!('host' in this.config) || !('port' in this.config)) {
        throw new MetaError(
          'WebSocket daemon transport requires host and port'
        );
      }

      const { host, port } = this.config;

      const serveOptions = {
        hostname: host,
        port,
        fetch: fetchHandler,
        websocket: {
          ...websocketHandler,
          idleTimeout: WEBSOCKET_IDLE_TIMEOUT_SECONDS,
          perMessageDeflate: false, // Disable compression for lower latency
        },
      };

      let lastError: unknown;
      for (let attempt = 0; attempt <= SERVE_BIND_MAX_RETRIES; attempt++) {
        try {
          this.server = Bun.serve(serveOptions);
          if (attempt > 0) {
            logInfo('[DaemonServer] Bun.serve() succeeded after retry', {
              attempt,
              port,
            });
          }
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (!isEADDRINUSE(err) || attempt === SERVE_BIND_MAX_RETRIES) {
            throw err;
          }
          const delay = SERVE_BIND_INITIAL_DELAY_MS * 2 ** attempt;
          logWarn('[DaemonServer] Port in use, retrying Bun.serve()', {
            attempt: attempt + 1,
            port,
            delay,
            cause: err,
          });
          await sleep(delay);
        }
      }

      // Shouldn't be reachable (loop either breaks on success or throws),
      // but guard defensively.
      if (lastError) throw lastError;

      logInfo('industryd listening', {
        host,
        port,
      });
      logInfo('Health check endpoint available', {
        host,
        port,
      });
    }

    if (this.config.debug) {
      debugLog('WebSocket server ready for connections');
    }
  }

  private connectPortProxyWs(
    ws: ServerWebSocket<WebSocketData>,
    targetUrl: string
  ): void {
    try {
      const socket = new WebSocket(targetUrl);
      const connection: PortProxyWsConnection = {
        socket,
        pendingMessages: [],
      };
      this.portProxyWsConnections.set(ws, connection);

      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => {
        for (const message of connection.pendingMessages) {
          socket.send(message);
        }
        connection.pendingMessages = [];
      });
      socket.addEventListener('message', (event) => {
        const data = event.data;
        if (typeof data === 'string' || data instanceof ArrayBuffer) {
          ws.send(data);
          return;
        }
        if (data instanceof Blob) {
          void data
            .arrayBuffer()
            .then((buffer) => ws.send(buffer))
            .catch((err) => {
              logWarn('[PortProxy] Failed to forward websocket blob', {
                cause: err instanceof Error ? err.message : String(err),
              });
            });
        }
      });
      socket.addEventListener('close', (event) => {
        ws.close(event.code || 1000, event.reason);
      });
      socket.addEventListener('error', () => {
        ws.close(1011, 'Port proxy websocket error');
      });
    } catch (err) {
      logWarn('[PortProxy] Failed to connect websocket', {
        url: targetUrl,
        cause: err instanceof Error ? err.message : String(err),
      });
      ws.close(1011, 'Port proxy websocket unavailable');
    }
  }

  private handlePortProxyWsMessage(
    ws: ServerWebSocket<WebSocketData>,
    message: string | Buffer
  ): void {
    const connection = this.portProxyWsConnections.get(ws);
    if (!connection) return;

    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(message);
      return;
    }

    connection.pendingMessages.push(message);
  }

  private closePortProxyWs(ws: ServerWebSocket<WebSocketData>): void {
    const connection = this.portProxyWsConnections.get(ws);
    if (!connection) return;

    if (
      connection.socket.readyState !== WebSocket.CLOSING &&
      connection.socket.readyState !== WebSocket.CLOSED
    ) {
      connection.socket.close();
    }
  }

  getLastActivityAt(): number {
    return this.activityClock.now();
  }

  private getUnauthenticatedConnection(
    ws: DaemonWebSocket
  ): UnauthedWebSocketConnection {
    let connection = this.unauthenticatedConnections.get(ws);
    if (!connection) {
      connection = new UnauthedWebSocketConnection(ws);
      this.unauthenticatedConnections.set(ws, connection);
    }
    return connection;
  }

  private handleJsonRpcOpen(ws: DaemonWebSocket): void {
    this.getUnauthenticatedConnection(ws);
    this.activeJsonRpcWebSockets.add(ws);
    Metrics.addToCounter(Metric.DAEMON_WS_CONNECTION_COUNT, 1);

    if (this.config.debug) {
      debugLog('WebSocket new connection established');
    }

    const pingInterval = setInterval(() => {
      try {
        ws.ping();
      } catch (error) {
        logWarn('Failed to send WebSocket ping', { error });
        this.clearJsonRpcPingInterval(ws);
      }
    }, PING_INTERVAL_MS);

    this.pingIntervals.set(ws, pingInterval);
  }

  private async handleJsonRpcMessage(
    ws: DaemonWebSocket,
    message: string | Buffer
  ): Promise<void> {
    const data = typeof message === 'string' ? message : message.toString();
    await this.connectionHandler.handleMessage(
      this.getUnauthenticatedConnection(ws),
      data
    );
  }

  private handleJsonRpcClose(
    ws: DaemonWebSocket,
    code: number,
    reason: string
  ): void {
    Metrics.addToCounter(Metric.DAEMON_WS_DISCONNECTION_COUNT, 1);

    const unauthenticatedConnection = this.getUnauthenticatedConnection(ws);
    const authenticatedWs = this.connectionHandler.getAuthenticatedConnection(
      unauthenticatedConnection
    );
    const connectionId = authenticatedWs?.connectionId;

    // Always log connection close with details for debugging E2E flakiness.
    if (authenticatedWs) {
      logInfo('WebSocket connection closed (authenticated)', {
        code,
        reason: reason || 'no reason provided',
        connectionId,
      });
    } else {
      logInfo('WebSocket connection closed (unauthenticated)', {
        code,
        reason: reason || 'no reason provided',
      });
    }

    this.clearJsonRpcPingInterval(ws);

    if (
      code !== WebSocketCloseCode.NORMAL_CLOSURE &&
      code !== WebSocketCloseCode.GOING_AWAY
    ) {
      logWarn('WebSocket closed abnormally', {
        code,
        reason,
      });
    }

    this.connectionHandler.handleClose(unauthenticatedConnection);
    this.unauthenticatedConnections.delete(ws);
    this.activeJsonRpcWebSockets.delete(ws);
  }

  private handleJsonRpcPong(ws: DaemonWebSocket): void {
    if (this.config.debug) {
      const authenticatedWs = this.connectionHandler.getAuthenticatedConnection(
        this.getUnauthenticatedConnection(ws)
      );
      if (authenticatedWs) {
        debugLog('[WebSocket] Received pong from authenticated client');
      } else {
        debugLog('[WebSocket] Received pong from unauthenticated client');
      }
    }
  }

  private handleJsonRpcError(error: unknown): void {
    logException(error, '[WebSocket] Connection error');
  }

  private clearJsonRpcPingInterval(ws: DaemonWebSocket): void {
    const pingInterval = this.pingIntervals.get(ws);
    if (pingInterval) {
      clearInterval(pingInterval);
      this.pingIntervals.delete(ws);
    }
  }

  public async close(): Promise<void> {
    for (const ws of this.activeJsonRpcWebSockets) {
      this.clearJsonRpcPingInterval(ws);
    }
    this.activeJsonRpcWebSockets.clear();

    if (this.server) {
      await this.server.stop();
      this.server = null;
      if (this.config.debug) {
        debugLog('WebSocket server closed');
      }
    }
  }

  public async stop(): Promise<void> {
    await this.close();
  }

  public isRunning(): boolean {
    return this.server !== null;
  }
}
