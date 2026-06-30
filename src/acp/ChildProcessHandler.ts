/**
 * ChildProcessHandler - manages a single child process for an ACP session
 */
import { ManagedProcess } from '@industry/drool-sdk';
import { logError, logInfo, logWarn, MetaError } from '@industry/logging';

import type {
  AgentSideConnection,
  TerminalHandle,
} from '@agentclientprotocol/sdk';

interface PendingRequest {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Manages a single child process for a session
 */
export class ChildProcessHandler {
  private pendingRequests = new Map<string, PendingRequest>();

  private requestIdCounter = 0;

  private isSetup = false;

  // Track terminal handles by terminalId for forwarding terminal operations
  private terminalHandles = new Map<string, TerminalHandle>();

  constructor(
    public readonly sessionId: string,
    private readonly process: ManagedProcess,
    private readonly connection: AgentSideConnection
  ) {
    // Handler setup is deferred to first sendRequest via ensureSetup()
    // to avoid race conditions where messages arrive before caller is ready
    this.isSetup = false;
  }

  private ensureSetup(): void {
    if (!this.isSetup) {
      this.setupMessageHandler();
      this.isSetup = true;
    }
  }

  private setupMessageHandler(): void {
    this.process.onMessage((message) => {
      try {
        const parsed = JSON.parse(message);

        // Handle JSON-RPC response (to our requests)
        if ('id' in parsed && (parsed.result !== undefined || parsed.error)) {
          const pending = this.pendingRequests.get(String(parsed.id));
          if (pending) {
            this.pendingRequests.delete(String(parsed.id));
            if (parsed.error) {
              pending.reject(new Error(parsed.error.message || 'RPC error'));
            } else {
              pending.resolve(parsed.result);
            }
          }
          return;
        }

        // Handle JSON-RPC request from child (needs response)
        if ('method' in parsed && 'id' in parsed) {
          void this.handleChildRequest(parsed);
          return;
        }

        // Handle JSON-RPC notification (forward to client)
        if ('method' in parsed && !('id' in parsed)) {
          this.forwardNotificationToClient(parsed);
          return;
        }

        // Malformed message: has 'id' but neither 'result', 'error', nor 'method'
        // Log and ignore to prevent silent failures
        if ('id' in parsed) {
          logWarn('[ACPDaemon] Malformed JSON-RPC message from child', {
            sessionId: this.sessionId,
            message,
          });
        }
      } catch (error) {
        logWarn('[ACPDaemon] Failed to parse child message', {
          cause: error,
          message,
        });
      }
    });

    this.process.onError((error) => {
      logWarn('[ACPDaemon] Child process error', {
        sessionId: this.sessionId,
        cause: error,
      });
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(error);
      }
      this.pendingRequests.clear();
    });
  }

  /**
   * Handle a JSON-RPC request from the child process.
   * Forward to the client, get the response, and send it back to the child.
   */
  private async handleChildRequest(request: {
    id: string | number;
    method: string;
    params?: unknown;
  }): Promise<void> {
    logInfo('[ACPDaemon] Received request from child', {
      method: request.method,
      externalId: String(request.id),
      sessionId: this.sessionId,
    });

    try {
      let result: unknown;
      const params = request.params as Record<string, unknown>;

      switch (request.method) {
        case 'permission/request':
        case 'session/request_permission':
          result = await this.connection.requestPermission({
            sessionId: this.sessionId,
            ...params,
          } as Parameters<typeof this.connection.requestPermission>[0]);
          break;

        case 'textFile/read':
          result = await this.connection.readTextFile({
            sessionId: this.sessionId,
            ...params,
          } as Parameters<typeof this.connection.readTextFile>[0]);
          break;

        case 'textFile/write':
          result = await this.connection.writeTextFile({
            sessionId: this.sessionId,
            ...params,
          } as Parameters<typeof this.connection.writeTextFile>[0]);
          break;

        // Terminal methods - use SDK's TerminalHandle pattern
        case 'terminal/create': {
          const handle = await this.connection.createTerminal({
            sessionId: this.sessionId,
            ...params,
          } as Parameters<typeof this.connection.createTerminal>[0]);
          // Store handle for subsequent operations (handle.id is the terminalId)
          this.terminalHandles.set(handle.id, handle);
          result = { terminalId: handle.id };
          break;
        }

        case 'terminal/output': {
          const terminalId = params.terminalId as string;
          const handle = this.terminalHandles.get(terminalId);
          if (!handle) {
            throw new MetaError('Unknown terminal', { terminalId });
          }
          result = await handle.currentOutput();
          break;
        }

        case 'terminal/wait_for_exit': {
          const terminalId = params.terminalId as string;
          const handle = this.terminalHandles.get(terminalId);
          if (!handle) {
            throw new MetaError('Unknown terminal', { terminalId });
          }
          result = await handle.waitForExit();
          break;
        }

        case 'terminal/kill': {
          const terminalId = params.terminalId as string;
          const handle = this.terminalHandles.get(terminalId);
          if (!handle) {
            throw new MetaError('Unknown terminal', { terminalId });
          }
          result = await handle.kill();
          break;
        }

        case 'terminal/release': {
          const terminalId = params.terminalId as string;
          const handle = this.terminalHandles.get(terminalId);
          if (!handle) {
            throw new MetaError('Unknown terminal:', { terminalId });
          }
          result = await handle.release();
          this.terminalHandles.delete(terminalId);
          break;
        }

        default:
          logWarn('[ACPDaemon] Unknown request method from child', {
            method: request.method,
          });
          await this.sendResponse(request.id, null, {
            code: -32601,
            message: `Method not found: ${request.method}`,
          });
          return;
      }

      // Send success response back to child
      await this.sendResponse(request.id, result);
    } catch (error) {
      logWarn('[ACPDaemon] Error handling child request', {
        method: request.method,
        cause: error,
      });
      // Send error response back to child
      await this.sendResponse(request.id, null, {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }

  /**
   * Send a JSON-RPC response back to the child process.
   */
  private async sendResponse(
    id: string | number,
    result: unknown,
    error?: { code: number; message: string }
  ): Promise<void> {
    const response = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    await this.process.send(JSON.stringify(response));
  }

  private forwardNotificationToClient(notification: {
    method: string;
    params?: unknown;
  }): void {
    // Forward notifications from child to client, injecting our tracked sessionId
    logInfo('[ACPDaemon] Received notification from child', {
      method: notification.method,
      sessionId: this.sessionId,
    });
    try {
      if (notification.method === 'session/update') {
        // session/update needs the typed sessionUpdate method which expects { sessionId, update }
        const params = notification.params as { update: unknown };
        void this.connection.sessionUpdate({
          sessionId: this.sessionId,
          update: params.update as Parameters<
            typeof this.connection.sessionUpdate
          >[0]['update'],
        });
      } else {
        logError('[ACPDaemon] Unknown notification method from child', {
          method: notification.method,
        });
      }
    } catch (error) {
      logWarn('[ACPDaemon] Failed to forward notification', {
        method: notification.method,
        cause: error,
      });
    }
  }

  async sendRequest<T>(method: string, params: unknown): Promise<T> {
    // Setup handlers on first request to avoid race conditions
    this.ensureSetup();

    const id = String(++this.requestIdCounter);

    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (response: unknown) => void,
        reject,
      });

      this.process.send(JSON.stringify(request)).catch((error) => {
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  async sendNotification(method: string, params: unknown): Promise<void> {
    this.ensureSetup();

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    await this.process.send(JSON.stringify(notification));
  }

  async close(): Promise<void> {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Child process closing'));
    }
    this.pendingRequests.clear();
    await this.process.close();
  }

  get isConnected(): boolean {
    return this.process.isConnected;
  }
}
