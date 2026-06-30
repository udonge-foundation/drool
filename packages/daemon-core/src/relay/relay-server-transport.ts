import type { UnauthedRelayConnection } from './unauthed-relay-connection';
import type { ServerTransport } from '../server/types';

export class RelayServerTransport implements ServerTransport {
  private readonly relayConnection: UnauthedRelayConnection;

  public constructor(relayConnection: UnauthedRelayConnection) {
    this.relayConnection = relayConnection;
  }

  send(message: string): void {
    this.relayConnection.sendAuthenticatedMessage(message);
  }

  isOpen(): boolean {
    return this.relayConnection.isOpen();
  }

  close(): void {
    this.relayConnection.close();
  }
}
