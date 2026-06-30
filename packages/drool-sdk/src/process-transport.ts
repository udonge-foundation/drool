import { Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import { DroolProcessManager } from './DroolProcessManager';
import { DroolProcessMode } from './enums';
import { ConnectionError } from './errors';

import type { ManagedProcess } from './types';
import type {
  DroolClientTransport,
  ProcessTransportOptions,
} from '@industry/drool-sdk-ext/protocol/drool';
/**
 * ProcessTransport implements the DroolClientTransport interface using a spawned
 * drool child process. It uses DroolProcessManager internally for process management.
 *
 * This is a thin wrapper that maintains the existing API while delegating to
 * the more general-purpose DroolProcessManager.
 */
export class ProcessTransport implements DroolClientTransport {
  private managedProcess: ManagedProcess | null = null;

  private processManager: DroolProcessManager;

  private options: ProcessTransportOptions;

  // Store handlers that may be registered before connect() is called
  private messageHandler: ((message: string) => void) | null = null;

  private errorHandler: ((error: Error) => void) | null = null;

  constructor(options: ProcessTransportOptions = {}) {
    this.options = options;
    this.processManager = new DroolProcessManager();
  }

  async connect(): Promise<void> {
    // Check if already connected (managedProcess exists AND is still connected)
    // This allows reconnection after unexpected exit without calling close()
    if (this.managedProcess && this.managedProcess.isConnected) {
      throw new ConnectionError('Transport already connected');
    }

    const config = {
      execPath: this.options.droolExecPath,
      isDevelopment: this.options.isDevelopment,
      mode: DroolProcessMode.StreamJsonRpc,
      cwd: this.options.cwd,
      env: this.options.env,
      extraArgs: this.options.droolExecExtraArgs,
      enableIpc: this.options.enableIpc,
    };

    // The Job Object spawn race that motivated the retry wrapper only exists
    // on Windows (FAC-19070). On other platforms use the plain synchronous
    // spawn so we don't incur the grace-period observer.
    const spawnStart = performance.now();
    let spawnOutcome: 'success' | 'error' = 'error';
    try {
      this.managedProcess =
        process.platform === 'win32'
          ? await this.processManager.spawnWithWindowsRetry(config)
          : this.processManager.spawn(config);
      spawnOutcome = 'success';
    } finally {
      Metrics.addToCounter(
        Metric.CLI_JSONRPC_CHILD_SPAWN_LATENCY,
        performance.now() - spawnStart,
        { outcome: spawnOutcome, source: 'process_transport' }
      );
    }

    // Apply any handlers that were registered before connect()
    if (this.messageHandler) {
      this.managedProcess.onMessage(this.messageHandler);
    }
    if (this.errorHandler) {
      this.managedProcess.onError(this.errorHandler);
    }
  }

  async send(message: string): Promise<void> {
    if (!this.managedProcess) {
      throw new ConnectionError('Transport not connected');
    }
    return this.managedProcess.send(message);
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
    if (this.managedProcess) {
      this.managedProcess.onMessage(handler);
    }
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
    if (this.managedProcess) {
      this.managedProcess.onError(handler);
    }
  }

  async close(): Promise<void> {
    if (this.managedProcess) {
      await this.managedProcess.close();
      this.managedProcess = null;
    }
  }

  get isConnected(): boolean {
    return this.managedProcess?.isConnected ?? false;
  }

  getManagedProcess(): ManagedProcess | null {
    return this.managedProcess;
  }
}
