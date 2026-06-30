import os from 'os';

import {
  Computer,
  ComputerProviderType,
  ComputerSchema,
  UpdateComputerRequestSchema,
} from '@industry/common/api/v0/computers';
import {
  DaemonRelayMethod,
  DaemonRelayStartResultSchema,
  DaemonRelayStopResultSchema,
  DaemonRelayGetStatusResultSchema,
} from '@industry/common/daemon';
import {
  JsonRpcBaseRequest,
  JsonRpcErrorCode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  getFreshTokenWithSource,
  TokenSourceType,
} from '@industry/runtime/auth';

import { BaseRequestHandler } from './base-request-handler';
import { getApiClient } from '../../services/ApiClient';

import type { IAuthedDaemonConnection } from '../types';
import type { BaseResponse, RelayControl } from './types';
import type { AuthCredential } from '@industry/common/api/shared';
import type { RuntimeAuthConfig } from '@industry/runtime/auth';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export class RelayRequestHandler extends BaseRequestHandler {
  private readonly relayControl: RelayControl;

  private readonly runtimeAuthConfig: RuntimeAuthConfig;

  constructor(
    relayControl: RelayControl,
    runtimeAuthConfig: RuntimeAuthConfig
  ) {
    super();
    this.relayControl = relayControl;
    this.runtimeAuthConfig = runtimeAuthConfig;
  }

  /** No-op: owns no core-lifetime resources. */
  shutdown(): void {}

  protected async dispatch(
    context: IAuthedDaemonConnection,
    request: JsonRpcBaseRequest
  ): Promise<BaseResponse> {
    const requestId = String(request.id ?? '');

    switch (request.method) {
      case DaemonRelayMethod.START:
        return this.handleStart(requestId, context);
      case DaemonRelayMethod.STOP:
        return this.handleStop(requestId);
      case DaemonRelayMethod.GET_STATUS:
        return this.handleGetStatus(requestId);
      default:
        return {
          type: 'response',
          id: requestId,
          error: {
            code: JsonRpcErrorCode.METHOD_NOT_FOUND,
            message: `Unknown relay method: ${request.method}`,
          },
        };
    }
  }

  private async handleStart(
    requestId: string,
    context: IAuthedDaemonConnection
  ): Promise<BaseResponse> {
    try {
      const computerRegistration =
        await this.relayControl.getComputerRegistration();
      if (!computerRegistration) {
        return {
          type: 'response',
          id: requestId,
          error: {
            code: JsonRpcErrorCode.INVALID_REQUEST,
            message:
              'No computer registered. Run `drool computer register` first.',
          },
        };
      }
      const { computerId } = computerRegistration;

      const relayUrl = await RelayRequestHandler.resolveRelayUrl(computerId);
      if (!relayUrl) {
        return {
          type: 'response',
          id: requestId,
          error: {
            code: JsonRpcErrorCode.INTERNAL_ERROR,
            message: 'No relay URL available for this computer.',
          },
        };
      }

      const status = this.relayControl.getStatus();
      if (status.connected && status.url === relayUrl) {
        logInfo('[Relay RPC] Already connected to same relay URL, no-op');
        const result = DaemonRelayStartResultSchema.parse({
          relayUrl,
          computerId,
        });
        return { type: 'response', id: requestId, result };
      }

      await this.relayControl.start({
        relayUrl,
        computerId,
        resolveCredential: () =>
          RelayRequestHandler.resolveAuthCredential(
            context,
            this.runtimeAuthConfig
          ),
      });
      logInfo('[Relay RPC] Relay started', {
        url: relayUrl,
        computerId,
      });

      const result = DaemonRelayStartResultSchema.parse({
        relayUrl,
        computerId,
      });
      return { type: 'response', id: requestId, result };
    } catch (error) {
      logWarn('[Relay RPC] Failed to start relay connection', { cause: error });
      return {
        type: 'response',
        id: requestId,
        error: {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: getErrorMessage(error, 'Failed to start relay connection'),
        },
      };
    }
  }

  private handleStop(requestId: string): BaseResponse {
    try {
      this.relayControl.stop();
      logInfo('[Relay RPC] Relay stopped');
      const result = DaemonRelayStopResultSchema.parse({});
      return { type: 'response', id: requestId, result };
    } catch (error) {
      logWarn('[Relay RPC] Failed to stop relay connection', { cause: error });
      return {
        type: 'response',
        id: requestId,
        error: {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: getErrorMessage(error, 'Failed to stop relay connection'),
        },
      };
    }
  }

  private handleGetStatus(requestId: string): BaseResponse {
    const status = this.relayControl.getStatus();
    const result = DaemonRelayGetStatusResultSchema.parse(status);
    return { type: 'response', id: requestId, result };
  }

  private static async resolveRelayUrl(
    computerId: string
  ): Promise<string | undefined> {
    const computer = await RelayRequestHandler.getComputer(computerId);
    return computer?.relayAgentUrl;
  }

  private static async backfillRemoteUserIfNeeded(
    computer: Computer,
    apiClient: NonNullable<ReturnType<typeof getApiClient>>
  ): Promise<void> {
    if (
      computer.providerType !== ComputerProviderType.Byom ||
      computer.remoteUser
    ) {
      return;
    }

    const remoteUser = os.userInfo().username;
    const body = UpdateComputerRequestSchema.parse({ remoteUser });
    const response = await apiClient.patch<Computer>(
      `/api/v0/computers/${encodeURIComponent(computer.id)}`,
      body
    );
    if (!response.ok) {
      logWarn(
        'Failed to backfill remoteUser on computer while fetching computer',
        {
          computerId: computer.id,
        }
      );
    }
  }

  private static async getComputer(
    computerId: string
  ): Promise<Computer | undefined> {
    const apiClient = getApiClient();
    if (!apiClient) {
      return undefined;
    }

    const response = await apiClient.get<Computer>(
      `/api/v0/computers/${encodeURIComponent(computerId)}`
    );
    const parsed = ComputerSchema.safeParse(response.data);
    if (!parsed.success) {
      return undefined;
    }

    if (!parsed.data.remoteUser) {
      // Backfill remoteUser for existing computers that don't have it
      await RelayRequestHandler.backfillRemoteUserIfNeeded(
        parsed.data,
        apiClient
      );
    }

    return parsed.data;
  }

  private static async resolveAuthCredential(
    context: IAuthedDaemonConnection,
    runtimeAuthConfig: RuntimeAuthConfig
  ): Promise<AuthCredential> {
    if (context.user.apiKey) {
      const credential = {
        apiKey: context.user.apiKey,
      } satisfies AuthCredential;

      return credential;
    }

    if (context.user.token) {
      const freshToken = await getFreshTokenWithSource(runtimeAuthConfig);
      if (!freshToken) {
        throw new MetaError(
          'Could not obtain auth credential for relay authentication'
        );
      }

      if (freshToken.type === TokenSourceType.ApiKey) {
        const credential = {
          apiKey: freshToken.token,
        } satisfies AuthCredential;

        return credential;
      }
      if (freshToken.type === TokenSourceType.WorkOS) {
        const credential = { token: freshToken.token } satisfies AuthCredential;

        return credential;
      }
    }

    throw new MetaError(
      'No daemon auth credential available for relay authentication'
    );
  }
}
