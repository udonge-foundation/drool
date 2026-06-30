import { AuthedDaemonConnection } from './authed-daemon-connection';

import type { AuthedDaemonConnectionParams, DaemonWebSocket } from './types';
import type { UnauthedWebSocketConnection } from './unauthed-web-socket-connection';

type AuthedWebSocketConnectionParams = AuthedDaemonConnectionParams & {
  unauthenticatedConnection: UnauthedWebSocketConnection;
};

export class AuthedWebSocketConnection extends AuthedDaemonConnection {
  private readonly ws: DaemonWebSocket;

  public constructor(params: AuthedWebSocketConnectionParams) {
    super({
      user: params.user,
      connectionId: params.connectionId,
      tracingMetadata: params.tracingMetadata,
      sourceSessionId: params.sourceSessionId,
      caller: params.caller,
      interactive: params.interactive,
      transport: params.unauthenticatedConnection.getTransport(),
    });
    this.ws = params.unauthenticatedConnection.getWebSocket();
  }

  getWebSocket(): DaemonWebSocket {
    return this.ws;
  }

  sendMessage(message: string): void {
    super.sendMessage(message);
  }

  isOpen(): boolean {
    return super.isOpen();
  }

  close(): void {
    super.close();
  }

  send(data: string | ArrayBuffer, compress?: boolean): number {
    return compress !== undefined
      ? this.ws.send(data, compress)
      : this.ws.send(data);
  }

  get readyState(): number {
    return this.ws.readyState;
  }
}
