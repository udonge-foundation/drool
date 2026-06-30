import { MachineType } from '@industry/common/daemon';
import { MetaError } from '@industry/logging/errors';

import { DaemonClient } from './DaemonClient';
import { WebSocketDaemonTransport } from './transports';
import { getWebSocketConfigForMachine } from './utils';

import type { WebSocketDaemonTransportConfig } from './transports';
import type { ComputerProviderType } from '@industry/common/api/v0/computers';
import type { ClientUiSurface } from '@industry/logging/tracing';

export function createWebSocketDaemonClient(config: {
  machineType: MachineType;
  providerType?: ComputerProviderType;
  getAccessToken?: () => Promise<string | null>;
  requestTimeout?: number;
  transportConfig?: Partial<WebSocketDaemonTransportConfig>;
  clientSurface?: ClientUiSurface;
}): DaemonClient {
  const transport = new WebSocketDaemonTransport({
    ...getWebSocketConfigForMachine(config.machineType),
    ...config.transportConfig,
    isRelayConnection: config.machineType === MachineType.Computer,
    getAccessToken: config.getAccessToken,
  });

  switch (config.machineType) {
    case MachineType.Local:
      return new DaemonClient({
        machineType: MachineType.Local,
        requestTimeout: config.requestTimeout,
        clientSurface: config.clientSurface,
        transport,
      });
    case MachineType.Ephemeral:
      return new DaemonClient({
        machineType: MachineType.Ephemeral,
        requestTimeout: config.requestTimeout,
        clientSurface: config.clientSurface,
        transport,
      });
    case MachineType.Computer:
      if (!config.providerType) {
        throw new MetaError(
          'providerType is required when creating a computer daemon client'
        );
      }
      return new DaemonClient({
        machineType: MachineType.Computer,
        providerType: config.providerType,
        requestTimeout: config.requestTimeout,
        clientSurface: config.clientSurface,
        transport,
      });
    default: {
      const exhaustiveCheck: never = config.machineType;
      throw new MetaError('Unsupported type', {
        machineType: exhaustiveCheck,
      });
    }
  }
}
