import { MachineType } from '@industry/common/daemon';

import {
  DEFAULT_WEBSOCKET_CONFIG,
  MACHINE_TYPE_WEBSOCKET_OVERRIDES,
} from './constants';

import type { WebSocketConnectionConfig } from './types';

export function getWebSocketConfigForMachine(
  type: MachineType
): WebSocketConnectionConfig {
  return {
    ...DEFAULT_WEBSOCKET_CONFIG,
    ...MACHINE_TYPE_WEBSOCKET_OVERRIDES[type],
  };
}
