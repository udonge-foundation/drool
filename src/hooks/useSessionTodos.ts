import { useMemo, useRef, useSyncExternalStore } from 'react';

import { parseTodos } from '@industry/drool-core/tools/definitions/todo';
import {
  MessageContentBlockType,
  type IndustryDroolMessage,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { TOOL_LLM_ID_TODO_WRITE } from '@industry/drool-sdk-ext/protocol/tools';

import { createSessionStoreSubscribe } from '@/hooks/utils/sessionStoreSubscribe';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

import type { TodoWriteToolParams } from '@industry/drool-core/tools/definitions/todo';
import type { MutableRefObject } from 'react';

function extractTodosFromMessages(
  messages: IndustryDroolMessage[]
): TodoWriteToolParams | null {
  // Scan messages in reverse to find the last TodoWrite tool_use block
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (
        block.type === MessageContentBlockType.ToolUse &&
        block.name === TOOL_LLM_ID_TODO_WRITE &&
        block.input
      ) {
        const input = block.input as { todos?: unknown };
        if (input.todos) {
          const parsed = parseTodos(input.todos);
          if (parsed.length > 0) {
            return { todos: parsed };
          }
        }
      }
    }
  }
  return null;
}

function createGetSnapshot(
  sessionId: string | null,
  cacheRef: MutableRefObject<{
    lastVersion: number;
    lastOutput: TodoWriteToolParams | null;
  }>
) {
  return (): TodoWriteToolParams | null => {
    if (!sessionId) return null;
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const mgr = ssm.getSessionManager(sessionId);
    if (!mgr) return null;

    const version = mgr.getStore().getVersion();
    const cache = cacheRef.current;

    if (cache.lastVersion === version) {
      return cache.lastOutput;
    }

    const messages = mgr.getStore().getMessages();
    const result = extractTodosFromMessages(messages);

    cache.lastVersion = version;
    cache.lastOutput = result;
    return result;
  };
}

export function useSessionTodos(
  sessionId: string | null
): TodoWriteToolParams | null {
  const cacheRef = useRef<{
    lastVersion: number;
    lastOutput: TodoWriteToolParams | null;
  }>({ lastVersion: -1, lastOutput: null });

  const prevSessionIdRef = useRef<string | null>(null);
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId;
    cacheRef.current = { lastVersion: -1, lastOutput: null };
  }

  const subscribe = useMemo(
    () => createSessionStoreSubscribe(sessionId),
    [sessionId]
  );
  const getSnapshot = useMemo(
    () => createGetSnapshot(sessionId, cacheRef),
    [sessionId]
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
