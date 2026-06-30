import { useMemo, useRef, useSyncExternalStore } from 'react';

import { createSessionStoreSubscribe } from './createSessionStoreSubscribe';

import type { MultiSessionStateManager } from '../state/MultiSessionStateManager';
import type { SessionTodoList } from '../state/types';
import type { MutableRefObject } from 'react';

interface TodoListCache {
  ssm: MultiSessionStateManager | null;
  sessionId: string | null;
  version: number;
  todoList: SessionTodoList | null;
}

function createGetSnapshot(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null,
  cacheRef: MutableRefObject<TodoListCache>
) {
  return (): SessionTodoList | null => {
    if (!ssm || !sessionId) return null;

    const manager = ssm.getSessionManager(sessionId);
    if (!manager) return null;

    const version = manager.getStore().getVersion();
    const cache = cacheRef.current;
    if (
      cache.ssm === ssm &&
      cache.sessionId === sessionId &&
      cache.version === version
    ) {
      return cache.todoList;
    }

    const todoList = ssm.getCurrentTodos(sessionId);
    cacheRef.current = { ssm, sessionId, version, todoList };
    return todoList;
  };
}

export function useSessionTodoList(
  ssm: MultiSessionStateManager | null,
  sessionId: string | null
): SessionTodoList | null {
  const cacheRef = useRef<TodoListCache>({
    ssm: null,
    sessionId: null,
    version: -1,
    todoList: null,
  });

  const subscribe = useMemo(
    () => createSessionStoreSubscribe(ssm, sessionId),
    [ssm, sessionId]
  );
  const getSnapshot = useMemo(
    () => createGetSnapshot(ssm, sessionId, cacheRef),
    [ssm, sessionId]
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
