import {
  INDUSTRY_PROTOCOL_VERSION,
  LEGACY_INDUSTRY_API_VERSION,
  JSONRPC_VERSION,
} from '@industry/drool-sdk-ext/protocol/drool';

import type { AuthGateResponse } from './types';
import type { JsonRpcBaseResponseFailure } from '@industry/drool-sdk-ext/protocol/shared';

export function serializeAuthGateResponse(response: AuthGateResponse): string {
  const jsonRpcResponse: JsonRpcBaseResponseFailure = {
    jsonrpc: JSONRPC_VERSION,
    industryApiVersion: LEGACY_INDUSTRY_API_VERSION,
    industryProtocolVersion: INDUSTRY_PROTOCOL_VERSION,
    ...response,
  };
  return JSON.stringify(jsonRpcResponse);
}
