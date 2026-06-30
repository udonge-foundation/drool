import { AuthedDaemonConnection } from '../authed-daemon-connection';

import type { AuthedDaemonConnectionParams } from '../types';
import type { UnauthedIpcConnection } from './unauthed-ipc-connection';

type AuthedIpcConnectionParams = AuthedDaemonConnectionParams & {
  unauthenticatedConnection: UnauthedIpcConnection;
};

export class AuthedIpcConnection extends AuthedDaemonConnection {
  public constructor(params: AuthedIpcConnectionParams) {
    super({
      user: params.user,
      connectionId: params.connectionId,
      tracingMetadata: params.tracingMetadata,
      sourceSessionId: params.sourceSessionId,
      caller: params.caller,
      interactive: params.interactive,
      // Reuse the unauthed connection's transport so isOpen/close reflect a
      // single processRef.
      transport: params.unauthenticatedConnection.getTransport(),
    });
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
}
