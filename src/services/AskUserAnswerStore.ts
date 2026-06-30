import { MetaError, ToolAbortError } from '@industry/logging/errors';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import type { AskUserCollectedAnswer } from '@/services/askUser/types';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { playAwaitingInputSound } from '@/services/soundCallbacks';
import type { AskUserParsedQuestion } from '@/utils/askUser/types';
import { formatToolRoundtripFailure } from '@/utils/toolRoundtripFailure';
import type { ToolRoundtripFailure } from '@/utils/toolRoundtripFailure/types';
import { generateUUID } from '@/utils/uuid';

// Pending answer requests - AskUser executor waits on these
type PendingAskUserRequest = {
  toolCallId: string;
  // Daemon request id, used to clear auto-replayed UI entries.
  requestId?: string;
  questions: AskUserParsedQuestion[];
  resolve: (answers: AskUserCollectedAnswer[]) => void;
  reject: (error: Error) => void;
};

const pendingRequests = new Map<string, PendingAskUserRequest>();

// Subscribers that want to be notified when requests change (add/remove)
type AskUserChangeSubscriber = () => void;
const changeSubscribers = new Set<AskUserChangeSubscriber>();

function notifyChangeSubscribers(): void {
  changeSubscribers.forEach((subscriber) => subscriber());
}

/**
 * Request answers from the user. Called by AskUser executor.
 * Returns a promise that resolves when the user completes the questionnaire.
 */
export function requestAskUserAnswers(
  toolCallId: string,
  questions: AskUserParsedQuestion[],
  abortSignal?: AbortSignal,
  sessionId?: string
): Promise<AskUserCollectedAnswer[]> {
  const isJsonRpcMode = getDroolRuntimeService().isJsonRpcMode();

  // In JSON-RPC mode (daemon/web), ask-user needs to roundtrip through stdout/stdin.
  if (isJsonRpcMode) {
    if (!sessionId) {
      throw new Error(
        '[AskUserAnswerStore] sessionId is required in JSON-RPC mode for proper routing'
      );
    }

    const requestId = generateUUID();

    return new Promise((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      let onAskUserResponse: (payload: {
        requestId: string;
        result: { cancelled?: boolean; answers: AskUserCollectedAnswer[] };
        sessionId: string;
        failure?: ToolRoundtripFailure;
      }) => void;

      const cleanup = () => {
        agentEventBus.off(AgentEvent.AskUserResponse, onAskUserResponse);
        if (abortSignal && onAbort) {
          abortSignal.removeEventListener('abort', onAbort);
        }
      };

      onAskUserResponse = (payload) => {
        if (payload.requestId !== requestId) return;
        cleanup();

        if (payload.failure) {
          const failureReason = formatToolRoundtripFailure(payload.failure);
          reject(new MetaError('AskUser failed', { failureReason }));
          return;
        }

        if (payload.result.cancelled === true) {
          // Treat a genuine user cancellation as an interrupt so the agent
          // loop stops instead of receiving a recoverable error result.
          reject(new ToolAbortError());
          return;
        }

        resolve(payload.result.answers);
      };

      // Handle abort - emit a cancelled response so the adapter can clean
      // up its pendingAskUserRequests Map (prevents zombie entries in loadSession)
      if (abortSignal) {
        onAbort = () => {
          cleanup();
          agentEventBus.emit(AgentEvent.AskUserResponse, {
            requestId,
            result: { cancelled: true, answers: [] },
            sessionId: sessionId!,
          });
          reject(new ToolAbortError());
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      agentEventBus.on(AgentEvent.AskUserResponse, onAskUserResponse);

      agentEventBus.emit(AgentEvent.AskUserRequest, {
        sessionId,
        requestId,
        toolCallId,
        questions,
      });
    });
  }

  return new Promise((resolve, reject) => {
    // Handler for abort signal - needs to be captured for cleanup
    let onAbort: (() => void) | undefined;

    // Wrapper to clean up abort listener before resolving/rejecting
    const cleanup = () => {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    };

    const wrappedResolve = (answers: AskUserCollectedAnswer[]) => {
      cleanup();
      resolve(answers);
    };

    const wrappedReject = (error: Error) => {
      cleanup();
      reject(error);
    };

    const request: PendingAskUserRequest = {
      toolCallId,
      questions,
      resolve: wrappedResolve,
      reject: wrappedReject,
    };
    pendingRequests.set(toolCallId, request);

    // Play awaiting input sound when showing AskUser questionnaire.
    // No-op in daemon mode (no callback registered).
    playAwaitingInputSound();

    // Handle abort
    if (abortSignal) {
      onAbort = () => {
        pendingRequests.delete(toolCallId);
        notifyChangeSubscribers();
        reject(new ToolAbortError());
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    // Notify subscribers
    notifyChangeSubscribers();
  });
}

/**
 * Get all pending AskUser requests. Used by UI to render questionnaires.
 */
export function getPendingAskUserRequests(): PendingAskUserRequest[] {
  return Array.from(pendingRequests.values());
}

/**
 * Resolve a pending AskUser request with answers. Called by UI when user completes.
 */
export function resolveAskUserAnswers(
  toolCallId: string,
  answers: AskUserCollectedAnswer[]
): void {
  const pending = pendingRequests.get(toolCallId);
  if (pending) {
    pendingRequests.delete(toolCallId);
    pending.resolve(answers);
    notifyChangeSubscribers();
  }
}

/**
 * Reject a pending AskUser request. Called by UI when user cancels.
 */
export function rejectAskUserAnswers(toolCallId: string, error?: Error): void {
  const pending = pendingRequests.get(toolCallId);
  if (pending) {
    pendingRequests.delete(toolCallId);
    // Default to ToolAbortError so a user cancellation interrupts the agent
    // loop. Callers that pass an explicit error (e.g. daemon disconnect)
    // keep their own semantics.
    pending.reject(error || new ToolAbortError());
    notifyChangeSubscribers();
  }
}

/** Drop an auto-replayed daemon AskUser request without resolving it locally. */
export function clearAskUserAnswersByRequestId(requestId: string): boolean {
  for (const [toolCallId, pending] of pendingRequests.entries()) {
    if (pending.requestId === requestId) {
      pendingRequests.delete(toolCallId);
      notifyChangeSubscribers();
      return true;
    }
  }
  return false;
}

/**
 * Register a daemon AskUser request in the pending requests store.
 * Used by daemon-backed sessions where the request comes from the
 * DaemonSessionController instead of a local executor.
 *
 * The resolve/reject callbacks route the user's response back to the
 * daemon via the TuiDaemonAdapter instead of resolving a local Promise.
 */
export function registerDaemonAskUserRequest(
  toolCallId: string,
  questions: AskUserParsedQuestion[],
  onResolve: (answers: AskUserCollectedAnswer[]) => void,
  onReject: () => void,
  requestId?: string,
  options?: { suppressSound?: boolean }
): void {
  const request: PendingAskUserRequest = {
    toolCallId,
    ...(requestId ? { requestId } : {}),
    questions,
    resolve: onResolve,
    reject: () => onReject(),
  };
  pendingRequests.set(toolCallId, request);

  // Avoid duplicate sounds for auto-resumed prompts.
  if (!options?.suppressSound) {
    try {
      playAwaitingInputSound();
    } catch {
      // Non-fatal: sound playback should not block the flow
    }
  }

  // Notify subscribers so usePendingAskUser picks up the new request
  notifyChangeSubscribers();
}

/**
 * Subscribe to changes in pending requests (add/remove). Returns unsubscribe function.
 */
export function subscribeToAskUserChanges(
  callback: AskUserChangeSubscriber
): () => void {
  changeSubscribers.add(callback);
  return () => changeSubscribers.delete(callback);
}
