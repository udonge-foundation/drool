import type {
  AuthedDaemonConnectionParams,
  DaemonConnectionTracingMetadata,
  DaemonUser,
  IAuthedDaemonConnection,
  ServerTransport,
} from './types';

/**
 * Authenticated daemon connection. Holds identity/metadata and delegates all
 * I/O to the required injected {@link ServerTransport} (WS / IPC / same-process).
 */
export class AuthedDaemonConnection implements IAuthedDaemonConnection {
  public readonly user: DaemonUser;

  public readonly connectionId: string;

  public readonly interactive: boolean;

  public readonly caller: AuthedDaemonConnectionParams['caller'];

  public readonly tracingMetadata?: DaemonConnectionTracingMetadata;

  public readonly sourceSessionId?: string;

  private readonly transport: ServerTransport;

  public constructor(
    params: AuthedDaemonConnectionParams & { transport: ServerTransport }
  ) {
    this.user = params.user;
    this.connectionId = params.connectionId;
    this.tracingMetadata = params.tracingMetadata;
    this.sourceSessionId = params.sourceSessionId;
    this.caller = params.caller;
    this.interactive = params.interactive ?? true;
    this.transport = params.transport;
  }

  sendMessage(message: string): void {
    this.transport.send(message);
  }

  isOpen(): boolean {
    return this.transport.isOpen();
  }

  close(): void {
    this.transport.close();
  }
}
