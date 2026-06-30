import { COLORS } from '@/components/chat/themedColors';
import { DAILY_MORNING_CRON_EXPRESSION } from '@/services/crons/constants';
import { cronExpressionToIntervalMs } from '@/services/crons/loopSchedule';
import type { CronStatusBadge } from '@/services/crons/types';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

import type { CronRecord } from '@industry/common/daemon';

const RUNNABLE_STATUSES = new Set(['active', 'running']);
const PAUSED_STATUSES = new Set(['held', 'paused']);
const PROMPT_EXCERPT_LENGTH = 48;

export function isUserVisibleCron(cron: Pick<CronRecord, 'status'>): boolean {
  return cron.status !== 'cancelled' && cron.status !== 'expired';
}

export function formatCronStatusBadge(
  status: CronRecord['status']
): CronStatusBadge {
  switch (status) {
    case 'active':
      return { label: 'active', color: COLORS.success };
    case 'running':
      return { label: 'running', color: COLORS.primary };
    case 'held':
      return { label: 'held', color: COLORS.warning };
    case 'paused':
      return { label: 'paused', color: COLORS.text.muted };
    case 'error':
      return { label: 'error', color: COLORS.error };
    case 'expired':
      return { label: 'expired', color: COLORS.text.muted };
    case 'cancelled':
      return { label: 'cancelled', color: COLORS.text.muted };
    default:
      return { label: status, color: COLORS.text.muted };
  }
}

export function formatHoldReason(cron: CronRecord): string | null {
  if (cron.status !== 'held') return null;
  if (!cron.holdReason) return 'held';
  const cleaned = cron.holdReason.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? `held: ${cleaned}` : 'held';
}

function formatEvery(minutes: number): string {
  if (minutes % 60 === 0) {
    return `every ${minutes / 60}h`;
  }
  return `every ${minutes}m`;
}

export function formatCronCadence(expression: string): string {
  if (expression === DAILY_MORNING_CRON_EXPRESSION) {
    return 'daily at 09:00 UTC';
  }

  const intervalMs = cronExpressionToIntervalMs(expression);
  if (intervalMs === null) {
    return 'custom schedule';
  }

  return formatEvery(intervalMs / 60_000);
}

export function formatCronTime(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(date)
    .replace(/\s/g, '')
    .toLowerCase();
}

export function formatCronCountdown(
  value: string | undefined,
  now: number = Date.now()
): string | null {
  if (!value) {
    return null;
  }
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) {
    return null;
  }
  const deltaMs = target - now;
  if (deltaMs <= 0) {
    return 'now';
  }
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) {
    return `in ${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `in ${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

export function formatPromptExcerpt(
  prompt: string,
  maxLength: number = PROMPT_EXCERPT_LENGTH
): string {
  const normalized = sanitizeTerminalDisplayText(prompt, { stripSgr: true })
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function compareCronRecords(
  left: CronRecord,
  right: CronRecord
): number {
  const leftPriority = RUNNABLE_STATUSES.has(left.status) ? 0 : 1;
  const rightPriority = RUNNABLE_STATUSES.has(right.status) ? 0 : 1;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  const nextRunDelta = (left.schedule.nextRunAt ?? '').localeCompare(
    right.schedule.nextRunAt ?? ''
  );
  if (nextRunDelta !== 0) {
    return nextRunDelta;
  }
  return left.id.localeCompare(right.id);
}

export function formatCronRecord(cron: CronRecord): string {
  const nextRun =
    cron.status === 'paused' ? null : formatCronTime(cron.schedule.nextRunAt);
  const schedule = nextRun
    ? `next ${nextRun}`
    : formatCronCadence(cron.schedule.expression);
  return `${cron.id} · ${cron.status} · ${schedule} · #${cron.stats.fireCount} · ${formatPromptExcerpt(cron.payload.prompt)}`;
}

export function formatCronRecordList(crons: CronRecord[]): string {
  if (crons.length === 0) {
    return 'No scheduled loops.';
  }
  return [...crons].sort(compareCronRecords).map(formatCronRecord).join('\n');
}

export function formatNextLoopSummary(crons: CronRecord[]): string | null {
  if (crons.length === 0) {
    return null;
  }

  const sorted = [...crons].sort(compareCronRecords);
  const runnable = sorted.filter((cron) => RUNNABLE_STATUSES.has(cron.status));
  const nextRunnable = runnable.find((cron) => cron.schedule.nextRunAt);
  const countLabel = crons.length === 1 ? '1 loop' : `${crons.length} loops`;
  const nextRun = formatCronTime(nextRunnable?.schedule.nextRunAt);

  if (nextRun) {
    return `${countLabel} active · next ${nextRun}`;
  }

  if (runnable.length > 0) {
    return `${countLabel} active · ${formatCronCadence(runnable[0].schedule.expression)}`;
  }

  if (sorted.every((cron) => PAUSED_STATUSES.has(cron.status))) {
    return `${countLabel} paused`;
  }

  return `${countLabel} ${sorted[0].status}`;
}
