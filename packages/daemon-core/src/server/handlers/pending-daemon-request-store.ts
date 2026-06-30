import {
  DaemonBroadcastMessage,
  DaemonDroolEvent,
} from '@industry/common/daemon';
import { JsonRpcErrorCode } from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { PendingDaemonRequestDispatchResult } from './enums';

import type { IAuthedDaemonConnection } from '../types';

type PendingDaemonRequestMessage = Extract<
  DaemonBroadcastMessage,
  { type: 'request' }
>;

type PendingDaemonRequestMethod = PendingDaemonRequestMessage['method'];

type PendingDaemonRequestRecord = {
  requestId: string;
  sessionId: string;
  method: PendingDaemonRequestMethod;
  payload: PendingDaemonRequestMessage;
  createdAt: number;
  expiresAt: number | undefined;
  attempts: number;
  maxAttempts: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
};

type PendingDaemonRequestStoreOptions = {
  defaultTtlMs: number;
  defaultMaxResendAttempts: number;
  noTimeoutMethods?: readonly PendingDaemonRequestMethod[];
};

type AddPendingRequestParams = {
  sessionId: string;
  payload: PendingDaemonRequestMessage;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  ttlMs?: number;
  maxResendAttempts?: number;
};

export class PendingDaemonRequestStore {
  private readonly byRequestId = new Map<string, PendingDaemonRequestRecord>();

  private readonly bySessionId = new Map<string, string[]>();

  private readonly defaultTtlMs: number;

  private readonly defaultMaxResendAttempts: number;

  private readonly noTimeoutMethods: ReadonlySet<PendingDaemonRequestMethod>;

  constructor(options: PendingDaemonRequestStoreOptions) {
    this.defaultTtlMs = options.defaultTtlMs;
    this.defaultMaxResendAttempts = options.defaultMaxResendAttempts;
    this.noTimeoutMethods = new Set(options.noTimeoutMethods ?? []);
  }

  addRequest({
    sessionId,
    payload,
    resolve,
    reject,
    ttlMs,
    maxResendAttempts,
  }: AddPendingRequestParams): string {
    const requestId = String(payload.id);
    if (this.byRequestId.has(requestId)) {
      throw new MetaError('Duplicate pending daemon request ID', {
        requestId,
        sessionId,
        method: payload.method,
        code: JsonRpcErrorCode.CONFLICT,
      });
    }

    const createdAt = Date.now();
    const effectiveTtlMs = this.noTimeoutMethods.has(payload.method)
      ? undefined
      : (ttlMs ?? this.defaultTtlMs);
    const effectiveMaxAttempts =
      maxResendAttempts ?? this.defaultMaxResendAttempts;
    const expiresAt =
      effectiveTtlMs === undefined ? undefined : createdAt + effectiveTtlMs;

    const timeoutHandle =
      effectiveTtlMs === undefined
        ? undefined
        : setTimeout(() => {
            this.rejectRequest(
              requestId,
              new MetaError('Pending daemon request timed out', {
                requestId,
                sessionId,
                method: payload.method,
                durationMs: effectiveTtlMs,
              })
            );
          }, effectiveTtlMs);

    timeoutHandle?.unref?.();

    this.byRequestId.set(requestId, {
      requestId,
      sessionId,
      method: payload.method,
      payload,
      createdAt,
      expiresAt,
      attempts: 0,
      maxAttempts: effectiveMaxAttempts,
      resolve,
      reject,
      timeoutHandle,
    });

    const requestQueue = this.bySessionId.get(sessionId) ?? [];
    requestQueue.push(requestId);
    this.bySessionId.set(sessionId, requestQueue);

    return requestId;
  }

  getPendingMethod(requestId: string): DaemonDroolEvent | undefined {
    const pending = this.byRequestId.get(requestId);
    if (!pending) {
      return undefined;
    }

    return pending.method;
  }

  getRequestIdsForSession(sessionId: string): string[] {
    return [...(this.bySessionId.get(sessionId) ?? [])];
  }

  dispatchRequest(params: {
    requestId: string;
    listener: IAuthedDaemonConnection;
    send: (
      listener: IAuthedDaemonConnection,
      message: PendingDaemonRequestMessage
    ) => void;
  }): PendingDaemonRequestDispatchResult {
    const pending = this.byRequestId.get(params.requestId);
    if (!pending) {
      return PendingDaemonRequestDispatchResult.Missing;
    }

    if (pending.attempts >= pending.maxAttempts) {
      this.rejectRequest(
        pending.requestId,
        new MetaError('Pending daemon request exceeded retry attempts', {
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          method: pending.method,
          attempt: pending.attempts,
          limit: pending.maxAttempts,
        })
      );
      return PendingDaemonRequestDispatchResult.Failed;
    }

    try {
      params.send(params.listener, pending.payload);
      return PendingDaemonRequestDispatchResult.Sent;
    } catch (error) {
      pending.attempts += 1;

      if (pending.attempts >= pending.maxAttempts) {
        this.rejectRequest(
          pending.requestId,
          new MetaError('Pending daemon request exceeded retry attempts', {
            requestId: pending.requestId,
            sessionId: pending.sessionId,
            method: pending.method,
            attempt: pending.attempts,
            limit: pending.maxAttempts,
            cause: error,
          })
        );
        return PendingDaemonRequestDispatchResult.Failed;
      }

      logWarn('[PendingDaemonRequestStore] Request dispatch failed', {
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        method: pending.method,
        attempt: pending.attempts,
        limit: pending.maxAttempts,
        cause: error,
      });

      return PendingDaemonRequestDispatchResult.Failed;
    }
  }

  resolveRequest<TResponse>(
    requestId: string,
    expectedMethod: PendingDaemonRequestMethod,
    result: TResponse
  ): boolean {
    const pending = this.byRequestId.get(requestId);
    if (!pending) {
      return false;
    }

    if (pending.method !== expectedMethod) {
      logWarn('[PendingDaemonRequestStore] Method mismatch on resolve', {
        requestId,
        method: expectedMethod,
        result: pending.method,
      });
      return false;
    }

    this.removeRequest(pending);
    pending.resolve(result);
    return true;
  }

  rejectRequest(requestId: string, error: Error): boolean {
    const pending = this.byRequestId.get(requestId);
    if (!pending) {
      return false;
    }

    this.removeRequest(pending);
    pending.reject(error);
    return true;
  }

  rejectRequestsForSession(sessionId: string, error: Error): number {
    const requestIds = this.getRequestIdsForSession(sessionId);
    let rejectedCount = 0;

    for (const requestId of requestIds) {
      if (this.rejectRequest(requestId, error)) {
        rejectedCount += 1;
      }
    }

    if (rejectedCount > 0) {
      logInfo('[PendingDaemonRequestStore] Rejected pending requests', {
        sessionId,
        count: rejectedCount,
      });
    }

    return rejectedCount;
  }

  /** Drop pending requests for an inactive session without rejecting them. */
  dropRequestsForSession(sessionId: string): number {
    const requestIds = [...(this.bySessionId.get(sessionId) ?? [])];
    let droppedCount = 0;

    for (const requestId of requestIds) {
      const pending = this.byRequestId.get(requestId);
      if (pending) {
        this.removeRequest(pending);
        droppedCount += 1;
      }
    }

    if (droppedCount > 0) {
      logInfo(
        '[PendingDaemonRequestStore] Dropped pending requests (no reject)',
        {
          sessionId,
          count: droppedCount,
        }
      );
    }

    return droppedCount;
  }

  clear(): void {
    const requestIds = [...this.byRequestId.keys()];
    for (const requestId of requestIds) {
      this.rejectRequest(
        requestId,
        new MetaError('Pending daemon request store cleared', { requestId })
      );
    }
  }

  getPendingCount(): number {
    return this.byRequestId.size;
  }

  private removeRequest(pending: PendingDaemonRequestRecord): void {
    if (pending.timeoutHandle) {
      clearTimeout(pending.timeoutHandle);
    }
    this.byRequestId.delete(pending.requestId);

    const requestIds = this.bySessionId.get(pending.sessionId);
    if (!requestIds) {
      return;
    }

    const filtered = requestIds.filter((id) => id !== pending.requestId);
    if (filtered.length === 0) {
      this.bySessionId.delete(pending.sessionId);
      return;
    }

    this.bySessionId.set(pending.sessionId, filtered);
  }
}
