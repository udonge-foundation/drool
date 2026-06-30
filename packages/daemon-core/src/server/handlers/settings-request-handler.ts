import {
  DaemonDeleteCustomModelRequestSchema,
  DaemonGetDefaultSettingsRequestSchema,
  DaemonListCustomModelsRequestSchema,
  DaemonSettingsMethod,
  DaemonUpdateSessionDefaultsRequestSchema,
  DaemonUpsertCustomModelRequestSchema,
} from '@industry/common/daemon';
import {
  JsonRpcBaseRequest,
  JsonRpcErrorCode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logWarn } from '@industry/logging';

import { BaseRequestHandler } from './base-request-handler';
import {
  deleteCustomModel,
  listCustomModels,
  upsertCustomModel,
} from '../../utils/custom-models';
import {
  getDefaultSettings,
  updateSessionDefaults,
} from '../../utils/settings';

import type { BaseResponse } from './types';
import type { IAuthedDaemonConnection } from '../types';

export class SettingsHandler extends BaseRequestHandler {
  shutdown(): void {}

  protected async dispatch(
    _context: IAuthedDaemonConnection,
    request: JsonRpcBaseRequest
  ): Promise<BaseResponse> {
    const requestId = String(request.id);
    try {
      switch (request.method) {
        case DaemonSettingsMethod.GET_DEFAULT_SETTINGS: {
          DaemonGetDefaultSettingsRequestSchema.parse(request);
          return {
            type: 'response',
            id: requestId,
            result: await getDefaultSettings(),
          };
        }
        case DaemonSettingsMethod.UPDATE_SESSION_DEFAULTS: {
          const parsed =
            DaemonUpdateSessionDefaultsRequestSchema.parse(request);
          return {
            type: 'response',
            id: requestId,
            result: await updateSessionDefaults(parsed.params),
          };
        }
        case DaemonSettingsMethod.LIST_CUSTOM_MODELS: {
          DaemonListCustomModelsRequestSchema.parse(request);
          return {
            type: 'response',
            id: requestId,
            result: await listCustomModels(),
          };
        }
        case DaemonSettingsMethod.UPSERT_CUSTOM_MODEL: {
          const parsed = DaemonUpsertCustomModelRequestSchema.parse(request);
          return {
            type: 'response',
            id: requestId,
            result: await upsertCustomModel(parsed.params),
          };
        }
        case DaemonSettingsMethod.DELETE_CUSTOM_MODEL: {
          const parsed = DaemonDeleteCustomModelRequestSchema.parse(request);
          return {
            type: 'response',
            id: requestId,
            result: await deleteCustomModel(parsed.params),
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
      logWarn('[Daemon] Settings request failed', {
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
}
