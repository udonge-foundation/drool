import { randomUUID } from 'crypto';

import { ClientType } from '@industry/common/shared';
import { logException, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { ClientUiSurface } from '@industry/logging/tracing';

import { UnauthedIpcConnection } from './unauthed-ipc-connection';

import type {
  AttachChildProcessParams,
  ChildIpcConnection,
  DaemonIpcConnectionServerParams,
} from './types';
import type { DaemonConnectionHandler } from '../daemon-connection-handler';
import type { DaemonTransportServer, IAuthedDaemonConnection } from '../types';
import type {
  IpcDisconnectListener,
  IpcMessageListener,
  IpcProcessRef,
} from '@industry/drool-sdk-ext/protocol/node';
import type { ChildProcess } from 'child_process';

function removeIpcMessageListener(
  target: IpcProcessRef,
  listener: IpcMessageListener
): void {
  if (typeof target.off === 'function') {
    target.off('message', listener);
    return;
  }
  target.removeListener?.('message', listener);
}

function removeIpcDisconnectListener(
  target: IpcProcessRef,
  listener: IpcDisconnectListener
): void {
  if (typeof target.off === 'function') {
    target.off('disconnect', listener);
    return;
  }
  target.removeListener?.('disconnect', listener);
}

function isIpcProcessRefAvailable(target: IpcProcessRef): boolean {
  return typeof target.send === 'function' && target.connected !== false;
}

function shouldUseInteractiveChildIpc(
  context: IAuthedDaemonConnection
): boolean {
  return (
    context.caller === ClientType.WebDesktop ||
    context.tracingMetadata?.app === ClientUiSurface.Desktop
  );
}

export class DaemonIpcConnectionServer implements DaemonTransportServer {
  private readonly connectionHandler: DaemonConnectionHandler;

  private readonly enableParentIpc: boolean;

  private readonly parentProcessRef: IpcProcessRef;

  private readonly onActivity: () => void;

  private readonly onParentIpcDisconnected?: () => void;

  private parentConnection: UnauthedIpcConnection | null = null;

  private parentCleanup: (() => void) | null = null;

  private readonly childConnections = new Map<
    ChildProcess,
    ChildIpcConnection
  >();

  private started = false;

  constructor({
    connectionHandler,
    enableParentIpc,
    parentProcessRef = process,
    onActivity,
    onParentIpcDisconnected,
  }: DaemonIpcConnectionServerParams) {
    this.connectionHandler = connectionHandler;
    this.enableParentIpc = enableParentIpc;
    this.parentProcessRef = parentProcessRef;
    this.onActivity = onActivity;
    this.onParentIpcDisconnected = onParentIpcDisconnected;
  }

  start(): void {
    if (this.started) {
      return;
    }

    if (this.enableParentIpc) {
      this.attachParentConnection();
    }
    this.started = true;
  }

  stop(): void {
    if (
      !this.started &&
      !this.parentConnection &&
      this.childConnections.size === 0
    ) {
      return;
    }

    this.cleanupParentConnection({ close: true });
    this.cleanupChildConnections({ close: true });
    this.started = false;
  }

  isRunning(): boolean {
    return this.started;
  }

  attachChildProcess({
    childProcess,
    context,
    sourceSessionId,
  }: AttachChildProcessParams): void {
    if (this.childConnections.has(childProcess)) {
      return;
    }

    if (!isIpcProcessRefAvailable(childProcess)) {
      logWarn('Child IPC channel unavailable', {
        sessionId: sourceSessionId,
      });
      return;
    }

    const connection = new UnauthedIpcConnection(childProcess);
    this.connectionHandler.authenticateTrustedConnection(connection, {
      user: context.user,
      connectionId: `drool-ipc-${randomUUID()}`,
      caller: context.caller,
      tracingMetadata: context.tracingMetadata,
      sourceSessionId,
      interactive: shouldUseInteractiveChildIpc(context),
    });

    const onMessage: IpcMessageListener = (message) => {
      if (typeof message !== 'string') {
        return;
      }

      this.onActivity();
      void this.connectionHandler
        .handleMessage(connection, message)
        .catch((error) => {
          logException(error, '[IPC] Failed to handle child IPC message', {
            sessionId: sourceSessionId,
          });
        });
    };

    const onDisconnect: IpcDisconnectListener = () => {
      this.cleanupChildConnection(childProcess, { close: false });
    };

    childProcess.on('message', onMessage);
    childProcess.on('disconnect', onDisconnect);
    childProcess.on('exit', onDisconnect);

    this.childConnections.set(childProcess, {
      connection,
      sourceSessionId,
      cleanup: () => {
        removeIpcMessageListener(childProcess, onMessage);
        removeIpcDisconnectListener(childProcess, onDisconnect);
        childProcess.removeListener('exit', onDisconnect);
      },
    });
  }

  private attachParentConnection(): void {
    if (this.parentConnection) {
      return;
    }

    if (!isIpcProcessRefAvailable(this.parentProcessRef)) {
      throw new MetaError('Parent IPC channel is unavailable');
    }

    const connection = new UnauthedIpcConnection(this.parentProcessRef);

    const onMessage: IpcMessageListener = (message) => {
      if (typeof message !== 'string') {
        return;
      }

      this.onActivity();
      void this.connectionHandler
        .handleMessage(connection, message)
        .catch((error) => {
          logException(error, '[IPC] Failed to handle parent IPC message');
        });
    };

    const onDisconnect: IpcDisconnectListener = () => {
      this.cleanupParentConnection({ close: false });
      try {
        this.onParentIpcDisconnected?.();
      } catch (error) {
        logException(
          error,
          '[IPC] Failed to handle parent IPC disconnect callback'
        );
      }
    };

    this.parentConnection = connection;
    this.parentCleanup = () => {
      removeIpcMessageListener(this.parentProcessRef, onMessage);
      removeIpcDisconnectListener(this.parentProcessRef, onDisconnect);
    };

    try {
      this.parentProcessRef.on('message', onMessage);
      this.parentProcessRef.on('disconnect', onDisconnect);

      if (!isIpcProcessRefAvailable(this.parentProcessRef)) {
        this.cleanupParentConnection({ close: false });
        throw new MetaError('Parent IPC channel is unavailable');
      }
    } catch (error) {
      this.cleanupParentConnection({ close: true });
      throw error;
    }
  }

  private cleanupParentConnection({ close }: { close: boolean }): void {
    const connection = this.parentConnection;
    if (!connection) {
      return;
    }

    this.parentConnection = null;
    this.parentCleanup?.();
    this.parentCleanup = null;
    this.connectionHandler.handleClose(connection);

    if (close) {
      connection.close();
    }
  }

  private cleanupChildConnections({ close }: { close: boolean }): void {
    for (const childProcess of Array.from(this.childConnections.keys())) {
      this.cleanupChildConnection(childProcess, { close });
    }
  }

  private cleanupChildConnection(
    childProcess: ChildProcess,
    { close }: { close: boolean }
  ): void {
    const attached = this.childConnections.get(childProcess);
    if (!attached) {
      return;
    }

    this.childConnections.delete(childProcess);
    attached.cleanup();
    this.connectionHandler.handleClose(attached.connection);

    if (close) {
      attached.connection.close();
    }
  }
}
