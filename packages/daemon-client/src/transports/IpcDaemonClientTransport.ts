import { v4 as uuidv4 } from 'uuid';

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { DaemonClientTransportKind } from './enums';

import type {
  DaemonClientTransport,
  DaemonClientTransportEvents,
  DaemonIpcMessageChannel,
} from './types';
import type { DesktopDaemonDisconnectEvent } from '@industry/common/daemon';
import type {
  IpcDisconnectListener,
  IpcMessageListener,
  IpcProcessRef,
} from '@industry/drool-sdk-ext/protocol/node';

function removeIpcMessageListener(
  target: IpcProcessRef,
  listenerFn: IpcMessageListener
): void {
  if (typeof target.off === 'function') {
    target.off('message', listenerFn);
    return;
  }
  target.removeListener?.('message', listenerFn);
}

function removeIpcDisconnectListener(
  target: IpcProcessRef,
  listenerFn: IpcDisconnectListener
): void {
  if (typeof target.off === 'function') {
    target.off('disconnect', listenerFn);
    return;
  }
  target.removeListener?.('disconnect', listenerFn);
}

function createProcessDaemonIpcMessageChannel(
  processRef: IpcProcessRef
): DaemonIpcMessageChannel {
  return {
    isAvailable: () =>
      typeof processRef.send === 'function' && processRef.connected !== false,
    onMessage: (callback) => {
      const listener: IpcMessageListener = (message) => {
        if (typeof message === 'string') {
          callback(message);
        }
      };
      processRef.on('message', listener);
      return () => removeIpcMessageListener(processRef, listener);
    },
    onDisconnect: (callback) => {
      const listener: IpcDisconnectListener = () => callback();
      processRef.on('disconnect', listener);
      return () => removeIpcDisconnectListener(processRef, listener);
    },
    sendMessage: (message) =>
      new Promise<void>((resolve, reject) => {
        const send = processRef.send;
        if (typeof send !== 'function') {
          reject(new MetaError('IPC transport is not connected'));
          return;
        }

        send.call(
          processRef,
          message,
          undefined,
          undefined,
          (error: Error | null) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          }
        );
      }),
  };
}

export class IpcDaemonClientTransport implements DaemonClientTransport {
  private readonly connectionId = uuidv4();

  private connected = false;

  private readonly channel: DaemonIpcMessageChannel;

  private unsubscribeMessage: (() => void) | null = null;

  private unsubscribeDisconnect: (() => void) | null = null;

  private readonly handlers: {
    [K in keyof DaemonClientTransportEvents]: Set<
      DaemonClientTransportEvents[K]
    >;
  } = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    message: new Set(),
  };

  private readonly handleChannelMessage = (message: string) => {
    if (!this.connected) {
      return;
    }

    for (const handler of this.handlers.message) {
      handler(message);
    }
  };

  private readonly handleChannelDisconnect = (
    event?: DesktopDaemonDisconnectEvent
  ) => {
    const wasConnected = this.connected;
    this.connected = false;
    this.cleanupSubscriptions();
    if (!wasConnected) {
      return;
    }

    for (const handler of this.handlers.close) {
      handler(1000, event?.reason ?? 'IPC disconnected');
    }
  };

  constructor(
    channel: DaemonIpcMessageChannel = createProcessDaemonIpcMessageChannel(
      process
    )
  ) {
    this.channel = channel;
  }

  async connect(_url: string): Promise<void> {
    if (!(await this.isChannelAvailable())) {
      logWarn('[DaemonClientIPC] IPC transport unavailable on connect', {
        connectionId: this.connectionId,
      });
      throw new MetaError('IPC transport unavailable in this process');
    }

    if (this.connected) {
      return;
    }

    this.unsubscribeMessage = this.channel.onMessage(this.handleChannelMessage);
    this.unsubscribeDisconnect =
      this.channel.onDisconnect?.(this.handleChannelDisconnect) ?? null;
    this.connected = true;
    queueMicrotask(() => {
      if (!this.connected) {
        return;
      }
      for (const handler of this.handlers.open) {
        handler();
      }
    });
  }

  disconnect(): void {
    this.handleChannelDisconnect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionId(): string | null {
    return this.connected ? this.connectionId : null;
  }

  isRelayConnection(): boolean {
    return false;
  }

  getTransportKind(): DaemonClientTransportKind.Ipc {
    return DaemonClientTransportKind.Ipc;
  }

  send(data: string): void {
    if (!this.connected) {
      throw new MetaError('IPC transport is not connected');
    }

    void this.sendWhenAvailable(data);
  }

  on<T extends keyof DaemonClientTransportEvents>(
    event: T,
    handler: DaemonClientTransportEvents[T]
  ): void {
    this.handlers[event].add(handler);
  }

  off<T extends keyof DaemonClientTransportEvents>(
    event: T,
    handler: DaemonClientTransportEvents[T]
  ): void {
    this.handlers[event].delete(handler);
  }

  private cleanupSubscriptions(): void {
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = null;
  }

  private async isChannelAvailable(): Promise<boolean> {
    return this.channel.isAvailable();
  }

  private async sendWhenAvailable(data: string): Promise<void> {
    try {
      if (!(await this.isChannelAvailable())) {
        throw new MetaError('IPC transport is not connected');
      }
      await this.channel.sendMessage(data);
    } catch (error) {
      const normalized = this.normalizeError(error);
      for (const handler of this.handlers.error) {
        handler(normalized);
      }
      this.handleChannelDisconnect();
      logWarn('[DaemonClientIPC] IPC transport emitted error', {
        cause: normalized,
        connectionId: this.connectionId,
      });
    }
  }

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
