import { useEffect, useRef, useState } from 'react';

import type { PendingAskUserRequest } from '@/hooks/types';
import {
  getPendingAskUserRequests,
  subscribeToAskUserChanges,
} from '@/services/AskUserAnswerStore';

/**
 * Hook to track pending AskUser requests.
 * Returns the first pending request (if any) for UI rendering.
 */
export function usePendingAskUser(): PendingAskUserRequest | null {
  const [pendingRequest, setPendingRequest] =
    useState<PendingAskUserRequest | null>(() => {
      const requests = getPendingAskUserRequests();
      return requests.length > 0
        ? {
            toolCallId: requests[0].toolCallId,
            questions: requests[0].questions,
          }
        : null;
    });

  // Track current toolCallId to avoid unnecessary state updates
  const currentToolCallIdRef = useRef<string | null>(
    pendingRequest?.toolCallId ?? null
  );

  useEffect(() => {
    // Subscribe to any changes (add/remove) in pending requests
    const unsubscribe = subscribeToAskUserChanges(() => {
      const requests = getPendingAskUserRequests();
      if (requests.length > 0) {
        const firstRequest = requests[0];
        // Only update state if the toolCallId changed
        if (currentToolCallIdRef.current !== firstRequest.toolCallId) {
          currentToolCallIdRef.current = firstRequest.toolCallId;
          setPendingRequest({
            toolCallId: firstRequest.toolCallId,
            questions: firstRequest.questions,
          });
        }
      } else if (currentToolCallIdRef.current !== null) {
        // No pending requests - clear state
        currentToolCallIdRef.current = null;
        setPendingRequest(null);
      }
    });

    // Check for existing requests on mount
    const requests = getPendingAskUserRequests();
    if (
      requests.length > 0 &&
      currentToolCallIdRef.current !== requests[0].toolCallId
    ) {
      currentToolCallIdRef.current = requests[0].toolCallId;
      setPendingRequest({
        toolCallId: requests[0].toolCallId,
        questions: requests[0].questions,
      });
    }

    return unsubscribe;
  }, []);

  return pendingRequest;
}
