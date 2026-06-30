import { RelayFrameType } from '@industry/common/relay';

import { AuthedRelayConnection } from './authed-relay-connection';
import { RelayServerTransport } from './relay-server-transport';
import { serializeAuthGateResponse } from '../server/auth-gate-response';

import type {
  AuthGateConnection,
  AuthGateResponse,
  CreateAuthedDaemonConnectionParams,
} from '../server/types';

type SendRelayFrame = (data: string, frameType: RelayFrameType) => void;
type CloseRelayClient = () => void;

type RelayDaemonConnectionParams = {
  clientId: string;
  sendFrame: SendRelayFrame;
  closeClient: CloseRelayClient;
};

export class UnauthedRelayConnection implements AuthGateConnection {
  public readonly clientId: string;

  private readonly sendFrame: SendRelayFrame;

  private readonly closeClient: CloseRelayClient;

  private readonly transport: RelayServerTransport;

  private open = true;

  public constructor({
    clientId,
    sendFrame,
    closeClient,
  }: RelayDaemonConnectionParams) {
    this.clientId = clientId;
    this.sendFrame = sendFrame;
    this.closeClient = closeClient;
    this.transport = new RelayServerTransport(this);
  }

  getTransport(): RelayServerTransport {
    return this.transport;
  }

  isOpen(): boolean {
    return this.open;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.closeClient();
  }

  closeFromTransport(): void {
    this.open = false;
  }

  sendAuthGateResponse(response: AuthGateResponse): void {
    this.sendFrame(serializeAuthGateResponse(response), RelayFrameType.Text);
  }

  createAuthenticatedConnection(
    params: CreateAuthedDaemonConnectionParams
  ): AuthedRelayConnection {
    return new AuthedRelayConnection({
      relayConnection: this,
      user: params.user,
      connectionId: params.connectionId,
      tracingMetadata: params.tracingMetadata,
      sourceSessionId: params.sourceSessionId,
      caller: params.caller,
      interactive: params.interactive,
    });
  }

  sendAuthenticatedMessage(message: string): void {
    if (!this.open) return;
    this.sendFrame(message, RelayFrameType.Text);
  }
}
