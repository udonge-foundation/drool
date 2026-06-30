import {
  DaemonInstallSshKeyRequestSchema,
  DaemonManagementMethod,
  DaemonTriggerUpdateRequestSchema,
  DaemonTriggerUpdateResult,
} from '@industry/common/daemon';
import {
  JsonRpcBaseRequest,
  JsonRpcErrorCode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { BaseRequestHandler } from './base-request-handler';
import { installSshKey } from '../../utils/ssh-keys';

import type { BaseResponse } from './types';
import type { IAuthedDaemonConnection } from '../types';

export class ManagementHandler extends BaseRequestHandler {
  constructor(private readonly onUpdate?: () => Promise<void>) {
    super();
  }

  shutdown(): void {}

  protected async dispatch(
    _context: IAuthedDaemonConnection,
    request: JsonRpcBaseRequest
  ): Promise<BaseResponse> {
    const requestId = String(request.id);
    try {
      switch (request.method) {
        case DaemonManagementMethod.TRIGGER_UPDATE: {
          DaemonTriggerUpdateRequestSchema.parse(request);
          return {
            type: 'response',
            id: requestId,
            result: await this.handleTriggerUpdate(),
          };
        }
        case DaemonManagementMethod.INSTALL_SSH_KEY: {
          const parsed = DaemonInstallSshKeyRequestSchema.parse(request);
          return {
            type: 'response',
            id: requestId,
            result: this.handleInstallSshKey(parsed.params.publicKey),
          };
        }
        default:
          return {
            type: 'response',
            id: requestId,
            error: {
              code: JsonRpcErrorCode.METHOD_NOT_FOUND,
              message: `Method not found: ${request.method}`,
            },
          };
      }
    } catch (error) {
      logWarn('[Daemon] Management request failed', {
        cause: error,
        method: request.method,
      });
      return {
        type: 'response',
        id: requestId,
        error: {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async handleTriggerUpdate(): Promise<DaemonTriggerUpdateResult> {
    if (!this.onUpdate) {
      return {
        triggered: false,
        message: 'Update not available on this daemon',
      };
    }
    void this.onUpdate().catch((err) => {
      logWarn('[Daemon] Failed to trigger update', {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    });
    return { triggered: true };
  }

  private handleInstallSshKey(publicKey: string): { installed: boolean } {
    try {
      installSshKey(publicKey);
      return { installed: true };
    } catch (error) {
      throw new MetaError('Failed to install SSH key', { cause: error });
    }
  }
}
