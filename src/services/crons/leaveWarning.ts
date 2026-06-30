import { getI18n } from '@/i18n';

const SCHEDULED_TASK_LEAVE_WARNING_TTL_MS = 10_000;

interface ScheduledTaskLeaveWarningParams {
  currentSessionId: string | null | undefined;
  taskCount: number;
  actionKey: string;
  repeatInstruction: string;
  targetSessionId?: string;
}

export function createScheduledTaskLeaveWarningGate(): (
  params: ScheduledTaskLeaveWarningParams
) => string | null {
  const warnings = new Map<string, number>();

  return (params) => {
    if (
      !params.currentSessionId ||
      params.taskCount === 0 ||
      params.targetSessionId === params.currentSessionId
    ) {
      return null;
    }

    const key = [
      params.currentSessionId,
      params.actionKey,
      params.targetSessionId ?? '',
    ].join(':');
    const lastWarningAt = warnings.get(key);
    const now = Date.now();

    if (
      lastWarningAt !== undefined &&
      now - lastWarningAt <= SCHEDULED_TASK_LEAVE_WARNING_TTL_MS
    ) {
      warnings.delete(key);
      return null;
    }

    warnings.set(key, now);
    const messageKey =
      params.taskCount === 1
        ? 'commands:loop.leaveWarning.single'
        : 'commands:loop.leaveWarning.multiple';
    return getI18n().t(messageKey, {
      repeatInstruction: params.repeatInstruction,
    });
  };
}
