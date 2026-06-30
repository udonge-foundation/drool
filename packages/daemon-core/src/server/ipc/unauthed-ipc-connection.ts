import { UnauthedDaemonConnection } from '../unauthed-daemon-connection';
import { AuthedIpcConnection } from './authed-ipc-connection';
import { IpcServerTransport } from './ipc-server-transport';

import type { CreateAuthedDaemonConnectionParams } from '../types';
import type { IpcProcessRef } from '@industry/drool-sdk-ext/protocol/node';

export class UnauthedIpcConnection extends UnauthedDaemonConnection {
  private readonly transport: IpcServerTransport;

  public constructor(processRef: IpcProcessRef) {
    const transport = new IpcServerTransport(processRef);
    super(transport);
    this.transport = transport;
  }

  createAuthenticatedConnection(
    params: CreateAuthedDaemonConnectionParams
  ): AuthedIpcConnection {
    return new AuthedIpcConnection({
      unauthenticatedConnection: this,
      user: params.user,
      connectionId: params.connectionId,
      tracingMetadata: params.tracingMetadata,
      sourceSessionId: params.sourceSessionId,
      caller: params.caller,
      interactive: params.interactive,
    });
  }

  getTransport(): IpcServerTransport {
    return this.transport;
  }
}
