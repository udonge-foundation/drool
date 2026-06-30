import {
  JsonRpcBaseNotificationSchema,
  JsonRpcBaseRequestSchema,
  JsonRpcBaseResponseSchema,
  JsonRpcErrorCode,
  type JsonRpcBaseNotification,
  type JsonRpcBaseRequest,
  type JsonRpcBaseResponse,
  type JsonRpcProtocolVersionMismatchErrorData,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logWarn } from '@industry/logging';
import { inspectJsonRpcEnvelope } from '@industry/utils/protocol';

type ParsedEnvelope =
  | {
      kind: 'request';
      request: JsonRpcBaseRequest;
      protocolVersionMismatch: JsonRpcProtocolVersionMismatchErrorData | null;
    }
  | {
      kind: 'response';
      response: JsonRpcBaseResponse;
      protocolVersionMismatch: JsonRpcProtocolVersionMismatchErrorData | null;
    }
  | {
      kind: 'notification';
      notification: JsonRpcBaseNotification;
      protocolVersionMismatch: JsonRpcProtocolVersionMismatchErrorData | null;
    }
  | {
      kind: 'parse_error';
      response: {
        type: 'response';
        id: null;
        error: {
          code: JsonRpcErrorCode;
          message: 'Parse error';
          data?: {
            protocolVersionMismatch?: JsonRpcProtocolVersionMismatchErrorData;
          };
        };
      };
    };

function createParseErrorResponse(
  protocolVersionMismatch?: JsonRpcProtocolVersionMismatchErrorData | null
) {
  return {
    type: 'response' as const,
    id: null,
    error: {
      code: JsonRpcErrorCode.PARSE_ERROR,
      message: 'Parse error' as const,
      data: protocolVersionMismatch ? { protocolVersionMismatch } : undefined,
    },
  };
}

export function parseEnvelope(message: string): ParsedEnvelope {
  let protocolVersionMismatch: JsonRpcProtocolVersionMismatchErrorData | null =
    null;
  let messageObj: unknown;

  try {
    messageObj = JSON.parse(message);
    ({ protocolVersionMismatch } = inspectJsonRpcEnvelope(messageObj));
  } catch (parseError) {
    logWarn('Failed to parse JSON-RPC envelope', { cause: parseError });
    return {
      kind: 'parse_error',
      response: createParseErrorResponse(protocolVersionMismatch),
    };
  }

  const responseResult = JsonRpcBaseResponseSchema.safeParse(messageObj);
  if (responseResult.success) {
    return {
      kind: 'response',
      response: responseResult.data,
      protocolVersionMismatch,
    };
  }

  const requestResult = JsonRpcBaseRequestSchema.safeParse(messageObj);
  if (requestResult.success) {
    return {
      kind: 'request',
      request: requestResult.data,
      protocolVersionMismatch,
    };
  }

  const notificationResult =
    JsonRpcBaseNotificationSchema.safeParse(messageObj);
  if (notificationResult.success) {
    return {
      kind: 'notification',
      notification: notificationResult.data,
      protocolVersionMismatch,
    };
  }

  return {
    kind: 'parse_error',
    response: createParseErrorResponse(protocolVersionMismatch),
  };
}

export function createMethodNotFoundResponse(
  id: string,
  method: string,
  protocolVersionMismatch?: JsonRpcProtocolVersionMismatchErrorData | null
) {
  return {
    type: 'response' as const,
    id,
    error: {
      code: JsonRpcErrorCode.METHOD_NOT_FOUND,
      message: `Method not found: ${method}`,
      data: protocolVersionMismatch ? { protocolVersionMismatch } : undefined,
    },
  };
}

export function createInternalErrorResponse(id: string) {
  return {
    type: 'response' as const,
    id,
    error: {
      code: JsonRpcErrorCode.INTERNAL_ERROR,
      message: 'Internal error',
    },
  };
}
