import { AuthedWebSocketConnection } from './authed-web-socket-connection';
import { UnauthedDaemonConnection } from './unauthed-daemon-connection';
import { WebSocketServerTransport } from './web-socket-server-transport';

import type {
  CreateAuthedDaemonConnectionParams,
  DaemonWebSocket,
} from './types';

export class UnauthedWebSocketConnection extends UnauthedDaemonConnection {
  private readonly ws: DaemonWebSocket;

  private readonly transport: WebSocketServerTransport;

  public constructor(ws: DaemonWebSocket) {
    const transport = new WebSocketServerTransport(ws);
    super(transport);
    this.ws = ws;
    this.transport = transport;
  }

  createAuthenticatedConnection(
    params: CreateAuthedDaemonConnectionParams
  ): AuthedWebSocketConnection {
    return new AuthedWebSocketConnection({
      unauthenticatedConnection: this,
      user: params.user,
      connectionId: params.connectionId,
      tracingMetadata: params.tracingMetadata,
      sourceSessionId: params.sourceSessionId,
      caller: params.caller,
      interactive: params.interactive,
    });
  }

  getWebSocket(): DaemonWebSocket {
    return this.ws;
  }

  getTransport(): WebSocketServerTransport {
    return this.transport;
  }
}
