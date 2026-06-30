import {
  DaemonCloseTerminalRequestParamsSchema,
  CloseTerminalResult,
  DaemonCreateTerminalRequestParamsSchema,
  CreateTerminalResult,
  CreateTerminalError,
  DaemonDroolEvent,
  DaemonListTerminalsRequestParamsSchema,
  DaemonTerminalEvent,
  ListTerminalsResult,
  DaemonResizeRequestParamsSchema,
  ResizeResult,
  DaemonTerminalMethod,
  DaemonWriteDataRequestParamsSchema,
  WriteDataResult,
} from '@industry/common/daemon';
import {
  INDUSTRY_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  JsonRpcBaseNotification,
  JsonRpcErrorCode,
  JsonRpcBaseRequest,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import {
  createInternalErrorResponse,
  createMethodNotFoundResponse,
} from '../envelope-helpers';
import { BaseRequestHandler } from './base-request-handler';
import { TerminalManager } from '../../terminal/terminal-manager';

import type { ConnectionCleanupHook, IAuthedDaemonConnection } from '../types';
import type { BaseResponse } from './types';

const ORPHAN_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

export class TerminalRequestHandler extends BaseRequestHandler {
  private readonly terminalManager: TerminalManager;

  constructor(terminalManager: TerminalManager) {
    super();
    this.terminalManager = terminalManager;

    this.terminalManager.on(
      DaemonTerminalEvent.DATA,
      (terminalId: string, data: string) => {
        const sessionId = this.terminalManager.getSessionId(terminalId);
        if (!sessionId) {
          logWarn('Terminal has no associated sessionId (data event)', {
            terminalId,
          });
          return;
        }
        this.broadcast(terminalId, {
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          jsonrpc: JSONRPC_VERSION,
          type: 'notification',
          method: DaemonDroolEvent.SESSION_NOTIFICATION,
          params: {
            sessionId,
            notification: {
              type: DaemonTerminalEvent.DATA,
              terminalId,
              data,
            },
          },
        });
      }
    );

    this.terminalManager.on(
      DaemonTerminalEvent.EXIT,
      (terminalId: string, exitCode: number, signal: string) => {
        const sessionId = this.terminalManager.getSessionId(terminalId);
        if (!sessionId) {
          logWarn('Terminal has no associated sessionId (exit event)', {
            terminalId,
          });
          this.terminalManager.removeTerminalAssociations(terminalId);
          return;
        }
        this.broadcast(terminalId, {
          industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
          industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
          jsonrpc: JSONRPC_VERSION,
          type: 'notification',
          method: DaemonDroolEvent.SESSION_NOTIFICATION,
          params: {
            sessionId,
            notification: {
              type: DaemonTerminalEvent.EXIT,
              terminalId,
              exitCode,
              signal,
            },
          },
        });
        this.terminalManager.removeTerminalAssociations(terminalId);
      }
    );

    this.terminalManager.startOrphanCleanup({
      intervalMs: ORPHAN_CLEANUP_INTERVAL_MS,
      onOrphanFound: (terminalId) => {
        const sessionId = this.terminalManager.getSessionId(terminalId);
        logInfo('Cleaning up orphaned terminal', {
          terminalId,
          sessionId: sessionId ?? 'unknown',
        });
        this.terminalManager.removeTerminalAssociations(terminalId);
        this.terminalManager.closeTerminal(terminalId);
      },
    });
  }

  /**
   * Builds the connection-cleanup hook that schedules PTY teardown when a
   * daemon connection disconnects. Returned to the capability so it can be
   * registered with the toolbox via `setConnectionCleanup`.
   */
  buildConnectionCleanup(): ConnectionCleanupHook {
    return (connection) => {
      const terminalIds = this.terminalManager.unregisterClient(connection);
      if (terminalIds.length === 0) {
        return;
      }
      logInfo('Daemon connection disconnected, scheduling terminal cleanup', {
        count: terminalIds.length,
      });
      for (const terminalId of terminalIds) {
        this.terminalManager.scheduleTerminalCleanup(terminalId, () => {
          const sessionId = this.terminalManager.getSessionId(terminalId);
          logInfo('Closing terminal after disconnect grace period', {
            terminalId,
            sessionId: sessionId ?? 'unknown',
          });
          this.terminalManager.removeTerminalAssociations(terminalId);
          this.terminalManager.closeTerminal(terminalId);
        });
      }
    };
  }

  /**
   * Fans out a JSON-RPC notification to every open client associated with the
   * given terminal. Serializes once and skips clients whose socket is closed;
   * short-circuits when the terminal has no associated clients.
   */
  private broadcast(
    terminalId: string,
    notification: JsonRpcBaseNotification
  ): void {
    const clients = this.terminalManager.getClientsForTerminal(terminalId);
    if (clients.size === 0) {
      return;
    }

    const payload = JSON.stringify(notification);
    for (const client of clients) {
      if (client.isOpen()) {
        client.sendMessage(payload);
      }
    }
  }

  shutdown(): void {
    this.terminalManager.stopOrphanCleanup();
    this.terminalManager.closeAllTerminals();
  }

  protected async dispatch(
    context: IAuthedDaemonConnection,
    request: JsonRpcBaseRequest
  ): Promise<BaseResponse> {
    try {
      switch (request.method) {
        case DaemonTerminalMethod.CREATE:
          return {
            type: 'response',
            id: request.id,
            result: await this.handleCreate(context, request.params),
          };
        case DaemonTerminalMethod.WRITE_DATA:
          return {
            type: 'response',
            id: request.id,
            result: await this.handleWriteData(context, request.params),
          };
        case DaemonTerminalMethod.RESIZE:
          return {
            type: 'response',
            id: request.id,
            result: await this.handleResize(context, request.params),
          };
        case DaemonTerminalMethod.CLOSE:
          return {
            type: 'response',
            id: request.id,
            result: await this.handleClose(context, request.params),
          };
        case DaemonTerminalMethod.LIST:
          return {
            type: 'response',
            id: request.id,
            result: await this.handleList(context, request.params),
          };
        default:
          return createMethodNotFoundResponse(request.id, request.method);
      }
    } catch (error: unknown) {
      logException(error, 'JSON-RPC handler error (terminal request)', {
        method: request.method,
        requestId: request.id,
        code: JsonRpcErrorCode.INTERNAL_ERROR,
      });

      return createInternalErrorResponse(request.id);
    }
  }

  private async handleCreate(
    context: IAuthedDaemonConnection,
    params: unknown
  ): Promise<CreateTerminalResult> {
    const typedParams = DaemonCreateTerminalRequestParamsSchema.parse(params);

    // Check if terminal already exists
    const existingTerminal = this.terminalManager.getTerminal(
      typedParams.terminalId
    );
    if (existingTerminal) {
      return {
        success: false,
        error: CreateTerminalError.TerminalIdExists,
      };
    }

    this.terminalManager.createTerminal(typedParams);

    this.terminalManager.associateTerminal(context, typedParams.terminalId);
    return { success: true };
  }

  private async handleWriteData(
    context: IAuthedDaemonConnection,
    params: unknown
  ): Promise<WriteDataResult> {
    const typedParams = DaemonWriteDataRequestParamsSchema.parse(params);

    this.ensureTerminalOwnership(context, typedParams.terminalId);

    const success = this.terminalManager.writeData(
      typedParams.terminalId,
      typedParams.data
    );

    if (!success) {
      this.terminalManager.disassociateTerminal(
        context,
        typedParams.terminalId
      );
      throw new MetaError('Terminal not found', {
        terminalId: typedParams.terminalId,
      });
    }

    return { success };
  }

  private async handleResize(
    context: IAuthedDaemonConnection,
    params: unknown
  ): Promise<ResizeResult> {
    const typedParams = DaemonResizeRequestParamsSchema.parse(params);

    this.ensureTerminalOwnership(context, typedParams.terminalId);

    const success = this.terminalManager.resize(
      typedParams.terminalId,
      typedParams.cols,
      typedParams.rows
    );

    if (!success) {
      this.terminalManager.disassociateTerminal(
        context,
        typedParams.terminalId
      );
      throw new MetaError('Terminal not found', {
        terminalId: typedParams.terminalId,
      });
    }

    return { success };
  }

  private async handleClose(
    context: IAuthedDaemonConnection,
    params: unknown
  ): Promise<CloseTerminalResult> {
    const typedParams = DaemonCloseTerminalRequestParamsSchema.parse(params);

    this.ensureTerminalOwnership(context, typedParams.terminalId);

    const success = this.terminalManager.closeTerminal(typedParams.terminalId);
    this.terminalManager.disassociateTerminal(context, typedParams.terminalId);

    if (!success) {
      throw new MetaError('Terminal not found', {
        terminalId: typedParams.terminalId,
      });
    }

    return { success };
  }

  private async handleList(
    context: IAuthedDaemonConnection,
    params: unknown
  ): Promise<ListTerminalsResult> {
    const typedParams = DaemonListTerminalsRequestParamsSchema.parse(params);

    // When a client reconnects after page refresh, re-associate ALL orphaned terminals
    // with this client. This handles the case where a user has multiple sessions open
    // (e.g., sessions 1, 2, 3) and refreshes the page. When they reconnect to any session,
    // all their terminals across all sessions should be restored.
    const allTerminals = this.terminalManager.listTerminals();
    for (const terminal of allTerminals) {
      const owners = this.terminalManager.getClientsForTerminal(terminal.id);
      if (owners.size === 0) {
        // Terminal is orphaned (no owners), re-associate it with this client
        // associateTerminal will cancel any pending cleanup
        this.terminalManager.associateTerminal(context, terminal.id);
      }
    }

    // Get terminals for this specific session
    const terminalDetails = this.terminalManager.listTerminalsForSession(
      typedParams.sessionId
    );

    // Filter to only return terminals owned by this client
    const ownedTerminals = terminalDetails.filter((terminal) =>
      this.terminalManager.ownsTerminal(context, terminal.id)
    );

    return { terminals: ownedTerminals };
  }

  private ensureTerminalOwnership(
    context: IAuthedDaemonConnection,
    terminalId: string
  ): void {
    if (!this.terminalManager.ownsTerminal(context, terminalId)) {
      throw new MetaError('Terminal not found:', { terminalId });
    }
  }
}
