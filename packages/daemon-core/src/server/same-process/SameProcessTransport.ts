import { randomUUID } from 'crypto';

import { ClientType } from '@industry/common/shared';
import { logException } from '@industry/logging';

import { serializeAuthGateResponse } from '../auth-gate-response';
import { AuthedDaemonConnection } from '../authed-daemon-connection';

import type { DaemonConnectionHandler } from '../daemon-connection-handler';
import type {
  AuthGateConnection,
  AuthGateResponse,
  CreateAuthedDaemonConnectionParams,
  DaemonUser,
  ServerTransport,
} from '../types';
import type { SameProcessTransportOptions } from './types';

export class SameProcessTransport implements ServerTransport {
  private readonly deliverToClient: (frame: string) => void;

  private readonly connectionHandler: DaemonConnectionHandler;

  private readonly user: DaemonUser;

  private readonly connectionId: string;

  private readonly caller: string;

  private readonly interactive: boolean;

  private open = true;

  private started = false;

  private gate: AuthGateConnection | null = null;

  private authedConnection: AuthedDaemonConnection | null = null;

  public constructor(opts: SameProcessTransportOptions) {
    this.deliverToClient = opts.deliverToClient;
    this.connectionHandler = opts.connectionHandler;
    this.user = opts.user;
    this.connectionId = opts.connectionId ?? `same-process-${randomUUID()}`;
    this.caller = opts.caller ?? ClientType.CLI;
    this.interactive = opts.interactive ?? true;
  }

  send(message: string): void {
    this.deliverToClient(message);
  }

  isOpen(): boolean {
    return this.open;
  }

  close(): void {
    this.stop();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.connectionHandler.authenticateTrustedConnection(this.asGate(), {
      user: this.user,
      connectionId: this.connectionId,
      caller: this.caller,
      interactive: this.interactive,
    });
  }

  handleInboundFrame(frame: string): void {
    void this.connectionHandler
      .handleMessage(this.asGate(), frame)
      .catch((error) => {
        logException(
          error,
          '[SameProcessTransport] inbound handleMessage rejected'
        );
      });
  }

  stop(): void {
    this.open = false;
    this.connectionHandler.handleClose(this.asGate());
  }

  private asGate(): AuthGateConnection {
    if (this.gate) {
      return this.gate;
    }

    const gate: AuthGateConnection = {
      isOpen: () => this.isOpen(),
      close: () => this.close(),
      sendAuthGateResponse: (response: AuthGateResponse) =>
        this.send(serializeAuthGateResponse(response)),
      createAuthenticatedConnection: (
        params: CreateAuthedDaemonConnectionParams
      ): AuthedDaemonConnection => {
        if (!this.authedConnection) {
          this.authedConnection = new AuthedDaemonConnection({
            ...params,
            transport: this,
          });
        }
        return this.authedConnection;
      },
    };

    this.gate = gate;
    return gate;
  }
}
