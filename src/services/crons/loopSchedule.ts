import { MetaError } from '@industry/logging/errors';

import { DAILY_MORNING_CRON_EXPRESSION } from '@/services/crons/constants';
import type { LoopSchedule, ParsedDuration } from '@/services/crons/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const DURATION_PATTERN =
  /^(\d+(?:\.\d{1,2})?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;

const CRON_MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const CRON_HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

function multiplierForUnit(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith('s')) return 1_000;
  if (normalized.startsWith('m')) return MINUTE_MS;
  if (normalized.startsWith('h')) return HOUR_MS;
  return DAY_MS;
}

export function parseDuration(text: string): ParsedDuration | null {
  const match = DURATION_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  const [whole, fraction = ''] = match[1].split('.');
  const centiUnits = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const intervalMs = Number(
    (centiUnits * BigInt(multiplierForUnit(match[2]))) / 100n
  );
  return { intervalMs, consumedText: match[0] };
}

export function isCronRepresentableIntervalMs(intervalMs: number): boolean {
  if (!Number.isInteger(intervalMs) || intervalMs < MINUTE_MS) {
    return false;
  }

  if (intervalMs % MINUTE_MS !== 0) {
    return false;
  }

  const minutes = intervalMs / MINUTE_MS;
  if (minutes < 60) {
    return CRON_MINUTE_STEPS.includes(minutes);
  }

  if (intervalMs % HOUR_MS !== 0) {
    return false;
  }

  const hours = intervalMs / HOUR_MS;
  return CRON_HOUR_STEPS.includes(hours);
}

export function intervalToCron(intervalMs: number): LoopSchedule {
  if (!isCronRepresentableIntervalMs(intervalMs)) {
    throw new MetaError('Loop interval cannot be represented exactly as cron', {
      reason: 'unrepresentable_cron_interval',
    });
  }

  const minutes = intervalMs / MINUTE_MS;
  if (minutes < 60) {
    return {
      expression: `*/${minutes} * * * *`,
      roundedIntervalMs: intervalMs,
    };
  }

  const hours = intervalMs / HOUR_MS;
  if (hours < 24) {
    return {
      expression: `0 */${hours} * * *`,
      roundedIntervalMs: intervalMs,
    };
  }

  return {
    expression: DAILY_MORNING_CRON_EXPRESSION,
    roundedIntervalMs: DAY_MS,
  };
}

export function cronExpressionToIntervalMs(expression: string): number | null {
  const minuteStep = /^\*\/(\d+) \* \* \* \*$/.exec(expression);
  if (minuteStep) {
    return Number(minuteStep[1]) * MINUTE_MS;
  }
  const hourStep = /^0 \*\/(\d+) \* \* \*$/.exec(expression);
  if (hourStep) {
    return Number(hourStep[1]) * HOUR_MS;
  }
  if (expression === DAILY_MORNING_CRON_EXPRESSION) {
    return DAY_MS;
  }
  return null;
}

export function splitLeadingInterval(input: string): {
  intervalMs: number | null;
  prompt: string;
} {
  const [first = '', ...rest] = input.trim().split(/\s+/);
  const duration = parseDuration(first);
  if (!duration) {
    return { intervalMs: null, prompt: input.trim() };
  }
  return { intervalMs: duration.intervalMs, prompt: rest.join(' ').trim() };
}

export function splitTrailingEveryInterval(input: string): {
  intervalMs: number | null;
  prompt: string;
} {
  const match = /\s+every\s+(.+)$/i.exec(input.trim());
  if (!match) {
    return { intervalMs: null, prompt: input.trim() };
  }
  const duration = parseDuration(match[1]);
  if (!duration) {
    return { intervalMs: null, prompt: input.trim() };
  }
  return {
    intervalMs: duration.intervalMs,
    prompt: input.trim().slice(0, match.index).trim(),
  };
}
