import { AuthedDaemonConnection } from '@industry/daemon-core/authed-daemon-connection';

import type { AuthedConnectionOptions } from '@/services/daemon/types';

import type { ServerTransport } from '@industry/daemon-core/server-types';

export class IpcConnection extends AuthedDaemonConnection {
  public readonly isChildIpc: boolean;

  public constructor(
    options: AuthedConnectionOptions & {
      sourceSessionId?: string;
      isChildIpc?: boolean;
    }
  ) {
    const transport: ServerTransport = {
      send: (message) => {
        options.sendMessage(message);
      },
      isOpen: () => options.isOpen(),
      close: () => {},
    };
    super({
      user: options.user,
      connectionId: options.connectionId,
      tracingMetadata: options.tracingMetadata,
      sourceSessionId: options.sourceSessionId,
      caller: options.caller,
      interactive: options.interactive,
      transport,
    });
    this.isChildIpc = options.isChildIpc ?? false;
  }
}
