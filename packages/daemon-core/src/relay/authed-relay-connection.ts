import { AuthedDaemonConnection } from '../server/authed-daemon-connection';

import type { UnauthedRelayConnection } from './unauthed-relay-connection';
import type { CreateAuthedDaemonConnectionParams } from '../server/types';

type AuthedRelayConnectionParams = CreateAuthedDaemonConnectionParams & {
  relayConnection: UnauthedRelayConnection;
};

export class AuthedRelayConnection extends AuthedDaemonConnection {
  public constructor(params: AuthedRelayConnectionParams) {
    super({
      user: params.user,
      connectionId: params.connectionId,
      tracingMetadata: params.tracingMetadata,
      sourceSessionId: params.sourceSessionId,
      caller: params.caller,
      interactive: params.interactive,
      transport: params.relayConnection.getTransport(),
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
