import { useCallback, useEffect, useRef, useState } from 'react';

import { BackgroundTaskItemType, ToolCallStatus } from '@/hooks/enums';
import type {
  BackgroundTaskItem,
  UseBackgroundTasksParams,
  UseBackgroundTasksResult,
} from '@/hooks/types';
import { backgroundProcessTracker } from '@/services/BackgroundProcessTracker';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import { isProcessAlive } from '@/utils/process-utils';
import {
  getRunningSessionBackedTasksFromState,
  readSessionBackedTaskProgress,
} from '@/utils/sessionBackedTaskState';

export function useBackgroundTasks({
  getToolExecutions,
}: UseBackgroundTasksParams): UseBackgroundTasksResult {
  const [items, setItems] = useState<BackgroundTaskItem[]>([]);
  const prevSnapshotRef = useRef<string>('');

  const refresh = useCallback(() => {
    const sessionId = getSessionService().getCurrentSessionId() ?? undefined;
    const bgProcesses = backgroundProcessTracker.getProcesses(sessionId);
    const toolExecutions = getToolExecutions();
    const sessionStateManager = getTuiDaemonAdapter().getSessionStateManager();

    const result: BackgroundTaskItem[] = [];

    // Background processes (fire-and-forget shell commands)
    for (const proc of bgProcesses) {
      if (!isProcessAlive(proc.pid)) continue;
      result.push({
        id: `proc-${proc.pid}`,
        type: BackgroundTaskItemType.Process,
        label: proc.command,
        detail: `pid: ${proc.pid}`,
        pid: proc.pid,
        startTime: proc.startTime,
        outputFile: proc.outputFile,
      });
    }

    if (sessionId) {
      const sessionTasks = getRunningSessionBackedTasksFromState(
        sessionStateManager,
        sessionId
      );
      for (const task of sessionTasks) {
        result.push({
          id: `session-bgtask-${task.taskId}`,
          type: BackgroundTaskItemType.Agent,
          label: task.subagentType ?? 'sub-agent',
          detail: task.description ?? '',
          sessionId: task.sessionId,
          startTime: task.startTime,
          progressUpdates: readSessionBackedTaskProgress({
            sessionStateManager,
            taskId: task.taskId,
          }),
        });
      }
    }

    // Subagent Task UI is sourced only from session state above. Tool
    // executions here are limited to fire-and-forget Execute tools.
    for (const [toolId, execution] of toolExecutions) {
      if (
        execution.status !== ToolCallStatus.Executing &&
        execution.status !== ToolCallStatus.Pending
      ) {
        continue;
      }

      if (execution.name === 'Task') {
        continue;
      } else if (
        execution.name === 'Execute' &&
        execution.input?.fireAndForget === true
      ) {
        const command = (execution.input?.command as string) || '';
        result.push({
          id: `exec-${toolId}`,
          type: BackgroundTaskItemType.Execute,
          label: command,
          detail: 'fire-and-forget',
          toolId,
          startTime: execution.startTime,
          progressUpdates: execution.progressUpdates,
        });
      }
    }

    // Only update state if items changed to avoid unnecessary re-renders
    const snapshot = JSON.stringify(
      result.map((r) => ({
        id: r.id,
        type: r.type,
        label: r.label,
        progressCount: r.progressUpdates?.length ?? 0,
        lastProgress:
          r.progressUpdates?.[r.progressUpdates.length - 1]?.text ??
          r.progressUpdates?.[r.progressUpdates.length - 1]?.details,
      }))
    );
    if (snapshot !== prevSnapshotRef.current) {
      prevSnapshotRef.current = snapshot;
      setItems(result);
    }
  }, [getToolExecutions]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => {
      clearInterval(interval);
    };
  }, [refresh]);

  const processCount = items.filter(
    (i) =>
      i.type === BackgroundTaskItemType.Process ||
      i.type === BackgroundTaskItemType.Execute
  ).length;
  const agentCount = items.filter(
    (i) => i.type === BackgroundTaskItemType.Agent
  ).length;

  return {
    items,
    processCount,
    agentCount,
    refresh,
  };
}
