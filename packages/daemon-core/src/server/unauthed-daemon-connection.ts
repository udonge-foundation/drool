import { serializeAuthGateResponse } from './auth-gate-response';
import { AuthedDaemonConnection } from './authed-daemon-connection';

import type {
  AuthGateConnection,
  AuthGateResponse,
  CreateAuthedDaemonConnectionParams,
  ServerTransport,
} from './types';

/**
 * Pre-authentication connection wrapping a {@link ServerTransport}. On
 * authenticate it mints an {@link AuthedDaemonConnection} carrying the same
 * transport, so both halves share one I/O channel.
 */
export class UnauthedDaemonConnection implements AuthGateConnection {
  private readonly serverTransport: ServerTransport;

  public constructor(transport: ServerTransport) {
    this.serverTransport = transport;
  }

  isOpen(): boolean {
    return this.serverTransport.isOpen();
  }

  close(): void {
    this.serverTransport.close();
  }

  sendAuthGateResponse(response: AuthGateResponse): void {
    this.serverTransport.send(serializeAuthGateResponse(response));
  }

  createAuthenticatedConnection(
    params: CreateAuthedDaemonConnectionParams
  ): AuthedDaemonConnection {
    return new AuthedDaemonConnection({
      user: params.user,
      connectionId: params.connectionId,
      tracingMetadata: params.tracingMetadata,
      sourceSessionId: params.sourceSessionId,
      caller: params.caller,
      interactive: params.interactive,
      transport: this.serverTransport,
    });
  }
}
