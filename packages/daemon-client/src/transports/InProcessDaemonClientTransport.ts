import { v4 as uuidv4 } from 'uuid';

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { DaemonClientTransportKind } from './enums';

import type {
  DaemonClientTransport,
  DaemonClientTransportEvents,
  InProcessDaemonClientTransportOptions,
} from './types';

/**
 * A DaemonClientTransport that forwards JSON-RPC frames directly to an
 * in-process runtime instead of crossing an IPC/WS boundary.
 *
 * Why this exists: the TUI's "parent" mode previously plugged
 * `InProcessDaemonClient` straight into `DaemonSessionController`, which
 * meant every method had to re-implement DaemonClient's envelope/error
 * handling. That's how the recent `/bug` and `/compact` regressions
 * happened (`response.result` returned without `if (response.error)`).
 *
 * Routing the same calls through `DaemonClient(transport: this)` means
 * envelope construction, schema validation, timeouts, and error
 * propagation live in exactly one place; the runtime handles frames.
 */
export class InProcessDaemonClientTransport implements DaemonClientTransport {
  private readonly connectionId = uuidv4();

  private readonly options: InProcessDaemonClientTransportOptions;

  private connected = false;

  private readonly unsubscribeFns = new Set<() => void>();

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

  constructor(options: InProcessDaemonClientTransportOptions) {
    this.options = options;
  }

  async connect(url: string): Promise<void> {
    if (this.connected) return;

    this.registerUnsubscribe(
      this.options.onMessage?.((data) => this.emitMessage(data))
    );
    this.registerUnsubscribe(
      this.options.onClose?.((code, reason) => this.handleClose(code, reason))
    );
    this.registerUnsubscribe(
      this.options.onError?.((error) => this.emitError(error))
    );

    await this.options.connect?.(url);

    this.connected = true;
    queueMicrotask(() => {
      if (!this.connected) return;
      for (const handler of this.handlers.open) handler();
    });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    try {
      this.options.disconnect?.();
    } catch (error) {
      logWarn(
        '[InProcessDaemonClientTransport] Client disconnect threw, ignoring',
        { cause: error }
      );
    }
    this.cleanupSubscriptions();
    for (const handler of this.handlers.close) {
      handler(1000, 'In-process transport disconnect');
    }
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

  getTransportKind(): DaemonClientTransportKind.InProcess {
    return DaemonClientTransportKind.InProcess;
  }

  send(data: string): void {
    if (!this.connected) {
      throw new MetaError('In-process transport is not connected');
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

  /**
   * Escape hatch for the in-process-only `setPendingSessionReady`
   * coordination hook. Routed via the transport so DaemonSessionController
   * can share in-flight session initialization/loading with the in-process
   * runtime after it moves behind `DaemonClient`.
   */
  setPendingSessionReady(sessionId: string, promise: Promise<unknown>): void {
    this.options.setPendingSessionReady?.(sessionId, promise);
  }

  private async sendWhenAvailable(data: string): Promise<void> {
    try {
      await this.options.sendMessage(data);
    } catch (error) {
      const normalized = this.normalizeError(error);
      logWarn(
        '[InProcessDaemonClientTransport] Failed to send in-process frame',
        { cause: normalized }
      );
      this.emitError(normalized);
    }
  }

  private registerUnsubscribe(unsubscribe: (() => void) | void): void {
    if (unsubscribe) {
      this.unsubscribeFns.add(unsubscribe);
    }
  }

  private cleanupSubscriptions(): void {
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns.clear();
  }

  private emitMessage(data: string): void {
    for (const handler of this.handlers.message) {
      handler(data);
    }
  }

  private emitError(error: Error): void {
    for (const handler of this.handlers.error) {
      handler(error);
    }
  }

  private handleClose(code: number, reason: string): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.cleanupSubscriptions();
    if (!wasConnected) return;
    for (const handler of this.handlers.close) {
      handler(code, reason);
    }
  }

  private normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
