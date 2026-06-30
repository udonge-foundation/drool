import { EventEmitter } from 'eventemitter3';
import { z } from 'zod';

import {
  DaemonDroolEvent,
  DaemonConnectionEvent,
  DaemonCronEvent,
  DaemonRelayEvent,
  DaemonSessionNotificationSchema,
  DaemonRequestPermissionSchema,
  DaemonAskUserSchema,
  DaemonConnectionStatusNotificationSchema,
  DaemonCronStateChangedNotificationSchema,
  DaemonRelayStatusChangedNotificationSchema,
} from '@industry/common/daemon';
import {
  JsonRpcMessageSchema,
  JsonRpcBaseResponseSchema,
  JsonRpcErrorCode,
  JsonRpcMessageType,
  type JsonRpcProtocolVersionMismatchErrorData,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { OtelTracing, SpanName, SpanAttribute } from '@industry/logging/tracing';
import { inspectJsonRpcEnvelope } from '@industry/utils/protocol';

import { JsonRpcRequestError } from '../errors';

import type { MessageRouterEvents } from './types';

interface MessageRouterOptions {
  emitReceiveSpans?: boolean;
}

export class MessageRouter extends EventEmitter<MessageRouterEvents> {
  private readonly emitReceiveSpans: boolean;

  constructor(options: MessageRouterOptions = {}) {
    super();
    this.emitReceiveSpans = options.emitReceiveSpans ?? true;
  }

  private traceReceive(
    spanName:
      | typeof SpanName.WEB_RECEIVE_NOTIFICATION
      | typeof SpanName.WEB_RECEIVE_PERMISSION_REQUEST
      | typeof SpanName.WEB_RECEIVE_ASK_USER_REQUEST,
    callback: () => void,
    options: {
      attributes: Record<string, string>;
      parentContext: ReturnType<typeof OtelTracing.extractContext>;
    }
  ): void {
    if (!this.emitReceiveSpans) {
      callback();
      return;
    }

    OtelTracing.trace(spanName, callback, options);
  }

  route(message: Record<string, unknown>): void {
    try {
      this.routeMessage(message);
    } catch (error) {
      logWarn('[MessageRouter] Failed to route message', { cause: error });
      const routedError =
        error instanceof JsonRpcRequestError
          ? error
          : new MetaError('Failed to route message', { cause: error });

      this.emit('error', routedError, message);
    }
  }

  private routeMessage(message: Record<string, unknown>): void {
    const { protocolVersionMismatch } = inspectJsonRpcEnvelope(message);

    // First, parse with the base JSON-RPC schema to get the message type
    const baseMsg = JsonRpcMessageSchema.parse(message);

    // Route based on message type, then parse with specific schemas
    if (baseMsg.type === JsonRpcMessageType.Response) {
      // Use base response schema to avoid union matching issues with result types
      // The specific result schema is not validated here - RequestManager handles type casting
      const msg = JsonRpcBaseResponseSchema.parse(message);

      // check if error is undefined, then we always have a requestId
      // otherwise, we need to handle missing requestId
      if (msg.error === undefined) {
        this.emit('response', { response: msg, requestId: msg.id });
      } else {
        this.emit('response', { response: msg, requestId: msg.id ?? null });
      }
    } else if (baseMsg.type === JsonRpcMessageType.Request) {
      // Handle different request types based on method
      if (baseMsg.method === DaemonDroolEvent.REQUEST_PERMISSION) {
        const msg = DaemonRequestPermissionSchema.parse(message);

        // Create span for receiving permission request, linked to daemon's trace context
        const traceContext = OtelTracing.extractContext(msg._meta);
        this.traceReceive(
          SpanName.WEB_RECEIVE_PERMISSION_REQUEST,
          () => {
            logInfo('[MessageRouter] Received permission request', {
              requestId: msg.id,
              sessionId: msg.params.sessionId,
              method: msg.method,
              toolCount: msg.params.toolUses.length,
            });
            this.emit('permissionRequest', {
              request: msg,
              requestId: msg.id,
              sessionId: msg.params.sessionId,
            });
          },
          {
            attributes: {
              [SpanAttribute.RPC_METHOD]: msg.method,
              [SpanAttribute.RPC_REQUEST_ID]: msg.id,
              [SpanAttribute.SESSION_ID]: msg.params.sessionId,
            },
            parentContext: traceContext,
          }
        );
      } else if (baseMsg.method === DaemonDroolEvent.ASK_USER) {
        const msg = DaemonAskUserSchema.parse(message);

        const traceContext = OtelTracing.extractContext(msg._meta);
        this.traceReceive(
          SpanName.WEB_RECEIVE_ASK_USER_REQUEST,
          () => {
            logInfo('[MessageRouter] Received ask-user request', {
              requestId: msg.id,
              sessionId: msg.params.sessionId,
              method: msg.method,
              questionCount: msg.params.questions.length,
              toolCallId: msg.params.toolCallId,
            });

            this.emit('askUserRequest', {
              request: msg,
              requestId: msg.id,
              sessionId: msg.params.sessionId,
            });
          },
          {
            attributes: {
              [SpanAttribute.RPC_METHOD]: msg.method,
              [SpanAttribute.RPC_REQUEST_ID]: msg.id,
              [SpanAttribute.SESSION_ID]: msg.params.sessionId,
            },
            parentContext: traceContext,
          }
        );
      } else {
        const rpcError = {
          code: JsonRpcErrorCode.METHOD_NOT_FOUND,
          message: `Method not found: ${baseMsg.method}`,
          data: protocolVersionMismatch
            ? { protocolVersionMismatch }
            : undefined,
        };

        throw new JsonRpcRequestError(rpcError.message, rpcError, baseMsg.id);
      }
    } else if (baseMsg.type === JsonRpcMessageType.Notification) {
      // Handle different notification types based on method
      if (baseMsg.method === DaemonConnectionEvent.CONNECTION_STATUS) {
        const msg = DaemonConnectionStatusNotificationSchema.parse(message);
        this.emit('connectionStatus', msg.params);
      } else if (baseMsg.method === DaemonRelayEvent.STATUS_CHANGED) {
        const msg = DaemonRelayStatusChangedNotificationSchema.parse(message);
        this.emit('relayStatusChanged', msg.params);
      } else if (baseMsg.method === DaemonCronEvent.STATE_CHANGED) {
        const msg = DaemonCronStateChangedNotificationSchema.parse(message);
        this.emit('cronStateChanged', msg.params);
      } else if (baseMsg.method === DaemonDroolEvent.SESSION_NOTIFICATION) {
        try {
          const msg = DaemonSessionNotificationSchema.parse(message);

          // Create span for receiving notification, linked to daemon's trace context
          const traceContext = OtelTracing.extractContext(msg._meta);
          this.traceReceive(
            SpanName.WEB_RECEIVE_NOTIFICATION,
            () => {
              // Session notification - extract notification data from the params
              this.emit('notification', {
                notification: msg.params.notification,
                sessionId: msg.params.sessionId,
              });
            },
            {
              attributes: {
                [SpanAttribute.RPC_METHOD]: msg.method,
                [SpanAttribute.SESSION_ID]: msg.params.sessionId,
                [SpanAttribute.NOTIFICATION_TYPE]: msg.params.notification.type,
              },
              parentContext: traceContext,
            }
          );
        } catch (error) {
          if (
            this.emitUnsupportedSessionNotificationIfNeeded(
              message,
              error,
              protocolVersionMismatch
            )
          ) {
            return;
          }

          throw error;
        }
      } else {
        if (protocolVersionMismatch) {
          logInfo(
            '[MessageRouter] Ignoring unsupported notification due to protocol version mismatch',
            {
              data: protocolVersionMismatch,
              method: protocolVersionMismatch.method,
              requestId: protocolVersionMismatch.requestId ?? undefined,
              type: protocolVersionMismatch.messageType,
            }
          );
          return;
        }

        throw new MetaError('Unknown notification type');
      }
    } else {
      // This should never happen if our schemas are correct
      throw new MetaError('Unexpected message type after validation');
    }
  }

  private emitUnsupportedSessionNotificationIfNeeded(
    message: Record<string, unknown>,
    error: unknown,
    protocolVersionMismatch: JsonRpcProtocolVersionMismatchErrorData | null
  ): boolean {
    if (!MessageRouter.isUnsupportedSessionNotificationParseError(error)) {
      return false;
    }

    const sessionId = MessageRouter.getNestedString(message, [
      'params',
      'sessionId',
    ]);
    const notificationType = MessageRouter.getNestedString(message, [
      'params',
      'notification',
      'type',
    ]);

    logInfo('[MessageRouter] Received unsupported session notification', {
      notificationType: notificationType ?? undefined,
      isError: !!protocolVersionMismatch,
      version: protocolVersionMismatch?.localIndustryProtocolVersion,
      sessionId: sessionId ?? undefined,
    });

    this.emit('unsupportedSessionNotification', {
      notificationType,
      protocolVersionMismatch,
      sessionId,
    });

    return true;
  }

  private static isUnsupportedSessionNotificationParseError(
    error: unknown
  ): error is z.ZodError {
    return (
      error instanceof z.ZodError &&
      error.issues.some((issue) =>
        MessageRouter.isUnsupportedNotificationTypeIssue(issue)
      )
    );
  }

  private static isUnsupportedNotificationTypeIssue(
    issue: z.ZodIssue
  ): boolean {
    if (
      issue.code === z.ZodIssueCode.invalid_union_discriminator &&
      MessageRouter.isNotificationTypePath(issue.path)
    ) {
      return true;
    }

    if (
      issue.code !== z.ZodIssueCode.invalid_union ||
      !MessageRouter.isNotificationPath(issue.path)
    ) {
      return false;
    }

    return issue.unionErrors.every((unionError) =>
      unionError.issues.some(
        (unionIssue) =>
          (unionIssue.code === z.ZodIssueCode.invalid_literal ||
            unionIssue.code === z.ZodIssueCode.invalid_enum_value) &&
          MessageRouter.isNotificationTypePath(unionIssue.path)
      )
    );
  }

  private static isNotificationPath(path: (string | number)[]): boolean {
    return (
      path.length === 2 && path[0] === 'params' && path[1] === 'notification'
    );
  }

  private static isNotificationTypePath(path: (string | number)[]): boolean {
    return (
      path.length === 3 &&
      path[0] === 'params' &&
      path[1] === 'notification' &&
      path[2] === 'type'
    );
  }

  private static getNestedString(
    value: Record<string, unknown>,
    path: string[]
  ): string | null {
    let current: unknown = value;

    for (const segment of path) {
      if (current === null || typeof current !== 'object') {
        return null;
      }

      current = Reflect.get(current, segment);
    }

    return typeof current === 'string' ? current : null;
  }
}
