import { EventEmitter } from 'eventemitter3';

import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import type {
  AskUserRequestHandlerEvents,
  PendingAskUserRequest,
} from './types';
import type { DaemonAskUser } from '@industry/common/daemon';
import type { AskUserResult } from '@industry/drool-sdk-ext/protocol/drool';
/**
 * AskUserRequestHandler manages incoming ask-user requests from the daemon
 * and tracks pending questionnaires awaiting user response.
 */
export class AskUserRequestHandler extends EventEmitter<AskUserRequestHandlerEvents> {
  private pendingRequests = new Map<string, PendingAskUserRequest>();

  handleAskUserRequest(request: DaemonAskUser, id: string, sessionId: string) {
    logInfo('[AskUserRequestHandler] Handling ask-user request', {
      requestId: id,
      sessionId,
      toolCallId: request.params.toolCallId,
      questionCount: request.params.questions.length,
    });

    const pending: PendingAskUserRequest = {
      requestId: id,
      sessionId,
      toolCallId: request.params.toolCallId,
      questions: request.params.questions,
      timestamp: Date.now(),
    };

    const existingRequest = this.pendingRequests.get(id);
    if (existingRequest) {
      this.pendingRequests.set(id, pending);

      logInfo('[AskUserRequestHandler] Duplicate ask-user request replay', {
        requestId: id,
        sessionId,
      });

      return;
    }

    this.pendingRequests.set(id, pending);
    this.emit('askUserRequested', pending);
  }

  resolveAskUser(id: string, result: AskUserResult): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      // Don't throw on unknown/duplicate responses from daemon - just log and ignore
      // to avoid crashing the session event pipeline on out-of-order network events.
      logWarn('[AskUserRequestHandler] No pending ask-user request found', {
        requestId: id,
      });
      return;
    }

    AskUserRequestHandler.validateResult(pending, result);

    this.pendingRequests.delete(id);
    this.emit('askUserResolved', id, result);
  }

  clearAskUser(id: string): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      logWarn(
        '[AskUserRequestHandler] No pending ask-user request found to clear',
        {
          requestId: id,
        }
      );
      return;
    }

    this.pendingRequests.delete(id);
    this.emit('askUserResolved', id);
  }

  clearSessionAskUserRequests(sessionId: string): void {
    const requestsToRemove = Array.from(this.pendingRequests.values()).filter(
      (request) => request.sessionId === sessionId
    );

    for (const request of requestsToRemove) {
      this.clearAskUser(request.requestId);
    }
  }

  cancelAskUser(id: string): void {
    this.resolveAskUser(id, { cancelled: true, answers: [] });
  }

  getPendingAskUserRequests(): PendingAskUserRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  getPendingAskUserRequest(id: string): PendingAskUserRequest | undefined {
    return this.pendingRequests.get(id);
  }

  clearAll(): void {
    this.pendingRequests.clear();
  }

  destroy(): void {
    this.clearAll();
    this.removeAllListeners();
  }

  private static validateResult(
    pending: PendingAskUserRequest,
    result: AskUserResult
  ) {
    // If cancelled, allow empty answers (or partial answers).
    if (result.cancelled === true) {
      return;
    }

    const questionsByIndex = new Map(
      pending.questions.map((q) => [q.index, q] as const)
    );

    const answered = new Set<number>();
    for (const answer of result.answers) {
      const question = questionsByIndex.get(answer.index);
      if (!question) {
        throw new MetaError('Answer references unknown question index', {
          requestId: pending.requestId,
          index: answer.index,
        });
      }

      if (answered.has(answer.index)) {
        throw new MetaError('Duplicate answers for question index', {
          requestId: pending.requestId,
          index: answer.index,
        });
      }

      answered.add(answer.index);
    }

    // Require all questions to be answered when not cancelled.
    const missing = pending.questions
      .map((q) => q.index)
      .filter((idx) => !answered.has(idx));

    if (missing.length > 0) {
      throw new MetaError('Missing answers for some questions', {
        requestId: pending.requestId,
        missing: missing.map(String),
      });
    }
  }
}
