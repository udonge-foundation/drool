/**
 * Schedule parsing and next-run computation utilities.
 *
 * Supports named cadences (daily, weekly, monthly) and cron expressions.
 * For named cadences, schedules run at 9:00 AM local time.
 */

import {
  AutomationScheduleCadence,
  isValidCronExpression,
  type AutomationSchedule,
} from '@industry/common/automations';

import type { CronParts, ScheduleValidationResult } from './types';

const NAMED_CADENCES = new Set<string>(
  Object.values(AutomationScheduleCadence)
);

// =============================================================================
// Constants
// =============================================================================

/** Default hour for named cadences (9 AM) */
const DEFAULT_SCHEDULE_HOUR = 9;

/** Default minute for named cadences */
const DEFAULT_SCHEDULE_MINUTE = 0;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Check if a string is a named cadence.
 */
function isNamedCadence(
  schedule: string
): schedule is AutomationScheduleCadence {
  return NAMED_CADENCES.has(schedule);
}

/**
 * Parse a cron expression into its component parts.
 * Returns null if the expression is not a valid 5-part cron.
 */
function parseCronExpression(expression: string): CronParts | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) {
    return null;
  }

  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
  };
}

/**
 * Validate a schedule value.
 */
export function validateSchedule(schedule: string): ScheduleValidationResult {
  if (!schedule || schedule.trim() === '') {
    return {
      isValid: false,
      error: 'Schedule cannot be empty',
    };
  }

  const trimmed = schedule.trim();

  // Check named cadences first
  if (isNamedCadence(trimmed)) {
    return { isValid: true };
  }

  // Check cron expression
  if (isValidCronExpression(trimmed)) {
    return { isValid: true };
  }

  return {
    isValid: false,
    error: `Invalid schedule: "${schedule}". Expected one of: daily, weekly, monthly, or a valid cron expression.`,
  };
}

// =============================================================================
// Next Run Computation
// =============================================================================

/**
 * Parse day of week from cron field.
 * Returns array of day numbers (0-6, where 0 is Sunday).
 */
function parseDaysOfWeek(field: string): number[] {
  if (field === '*') {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  const dayNames: Record<string, number> = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
  };

  const days = new Set<number>();

  // Handle list (e.g., 1,2,3 or MON,WED,FRI)
  const parts = field.split(',');
  for (const part of parts) {
    // Handle range (e.g., 1-5 or MON-FRI)
    if (part.includes('-')) {
      const [start, end] = part.split('-');
      let startNum = dayNames[start.toUpperCase()] ?? parseInt(start, 10);
      let endNum = dayNames[end.toUpperCase()] ?? parseInt(end, 10);

      // Normalize 7 to 0 (both represent Sunday)
      if (startNum === 7) startNum = 0;
      if (endNum === 7) endNum = 0;

      if (!Number.isNaN(startNum) && !Number.isNaN(endNum)) {
        for (let i = startNum; i <= endNum; i++) {
          days.add(i);
        }
      }
    } else {
      // Single value
      let num = dayNames[part.toUpperCase()] ?? parseInt(part, 10);
      if (num === 7) num = 0;
      if (!Number.isNaN(num) && num >= 0 && num <= 6) {
        days.add(num);
      }
    }
  }

  return Array.from(days).sort((a, b) => a - b);
}

/**
 * Parse hour values from cron field.
 * Returns array of hours (0-23).
 */
function parseHours(field: string): number[] {
  if (field === '*') {
    return Array.from({ length: 24 }, (_, i) => i);
  }

  const hours = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    if (part.includes('/')) {
      // Step values (e.g., */2, 0-23/2)
      const [range, step] = part.split('/');
      const stepNum = parseInt(step, 10);
      const start = range === '*' ? 0 : parseInt(range.split('-')[0], 10);
      const end =
        range === '*' ? 23 : parseInt(range.split('-')[1] ?? '23', 10);
      for (let i = start; i <= end; i += stepNum) {
        hours.add(i);
      }
    } else if (part.includes('-')) {
      // Range (e.g., 9-17)
      const [start, end] = part.split('-');
      for (let i = parseInt(start, 10); i <= parseInt(end, 10); i++) {
        hours.add(i);
      }
    } else {
      // Single value
      const num = parseInt(part, 10);
      if (!Number.isNaN(num) && num >= 0 && num <= 23) {
        hours.add(num);
      }
    }
  }

  return Array.from(hours).sort((a, b) => a - b);
}

/**
 * Parse minute values from cron field.
 * Returns array of minutes (0-59).
 */
function parseMinutes(field: string): number[] {
  if (field === '*') {
    return Array.from({ length: 60 }, (_, i) => i);
  }

  const minutes = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    if (part.includes('/')) {
      // Step values
      const [range, step] = part.split('/');
      const stepNum = parseInt(step, 10);
      const start = range === '*' ? 0 : parseInt(range.split('-')[0], 10);
      const end =
        range === '*' ? 59 : parseInt(range.split('-')[1] ?? '59', 10);
      for (let i = start; i <= end; i += stepNum) {
        minutes.add(i);
      }
    } else if (part.includes('-')) {
      // Range
      const [start, end] = part.split('-');
      for (let i = parseInt(start, 10); i <= parseInt(end, 10); i++) {
        minutes.add(i);
      }
    } else {
      // Single value
      const num = parseInt(part, 10);
      if (!Number.isNaN(num) && num >= 0 && num <= 59) {
        minutes.add(num);
      }
    }
  }

  return Array.from(minutes).sort((a, b) => a - b);
}

/**
 * Parse day of month values from cron field.
 * Returns array of days (1-31), or null if wildcard (*).
 */
function parseDaysOfMonth(field: string): number[] | null {
  if (field === '*') {
    return null; // Wildcard means any day
  }

  const days = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    if (part.includes('/')) {
      // Step values (e.g., */5, 1-15/2)
      const [range, step] = part.split('/');
      const stepNum = parseInt(step, 10);
      const start = range === '*' ? 1 : parseInt(range.split('-')[0], 10);
      const end =
        range === '*' ? 31 : parseInt(range.split('-')[1] ?? '31', 10);
      for (let i = start; i <= end; i += stepNum) {
        days.add(i);
      }
    } else if (part.includes('-')) {
      // Range (e.g., 1-15)
      const [start, end] = part.split('-');
      for (let i = parseInt(start, 10); i <= parseInt(end, 10); i++) {
        days.add(i);
      }
    } else {
      // Single value
      const num = parseInt(part, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= 31) {
        days.add(num);
      }
    }
  }

  return Array.from(days).sort((a, b) => a - b);
}

/**
 * Parse month values from cron field.
 * Returns array of months (1-12), or null if wildcard (*).
 */
function parseMonths(field: string): number[] | null {
  if (field === '*') {
    return null; // Wildcard means any month
  }

  const monthNames: Record<string, number> = {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
  };

  const months = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    if (part.includes('/')) {
      // Step values (e.g., */3)
      const [range, step] = part.split('/');
      const stepNum = parseInt(step, 10);
      const start = range === '*' ? 1 : parseInt(range.split('-')[0], 10);
      const end =
        range === '*' ? 12 : parseInt(range.split('-')[1] ?? '12', 10);
      for (let i = start; i <= end; i += stepNum) {
        months.add(i);
      }
    } else if (part.includes('-')) {
      // Range (e.g., 1-6 or JAN-JUN)
      const [start, end] = part.split('-');
      const startNum = monthNames[start.toUpperCase()] ?? parseInt(start, 10);
      const endNum = monthNames[end.toUpperCase()] ?? parseInt(end, 10);
      if (!Number.isNaN(startNum) && !Number.isNaN(endNum)) {
        for (let i = startNum; i <= endNum; i++) {
          months.add(i);
        }
      }
    } else {
      // Single value
      const num = monthNames[part.toUpperCase()] ?? parseInt(part, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= 12) {
        months.add(num);
      }
    }
  }

  return Array.from(months).sort((a, b) => a - b);
}

/**
 * Get the number of days in a given month/year.
 */
function getDaysInMonth(year: number, month: number): number {
  // month is 0-indexed for Date constructor
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Get the next valid minute >= currentMinute from the parsed minutes array.
 * Returns null if no valid minute found (need to advance hour).
 */
function getNextMinute(
  minutes: number[],
  currentMinute: number
): number | null {
  for (const m of minutes) {
    if (m >= currentMinute) {
      return m;
    }
  }
  return null;
}

/**
 * Compute next run time for a named cadence.
 */
function computeNextRunForCadence(
  cadence: AutomationScheduleCadence,
  fromDate: Date
): Date {
  const next = new Date(fromDate);

  // Set to default schedule time (UTC)
  next.setUTCHours(DEFAULT_SCHEDULE_HOUR, DEFAULT_SCHEDULE_MINUTE, 0, 0);

  // If the schedule time has already passed today, start from tomorrow
  if (next <= fromDate) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  switch (cadence) {
    case AutomationScheduleCadence.Daily:
      // Already set to tomorrow if needed
      break;

    case AutomationScheduleCadence.Weekly: {
      // Find next Monday (day 1)
      const dayOfWeek = next.getUTCDay();
      const daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
      if (dayOfWeek !== 1) {
        next.setUTCDate(next.getUTCDate() + daysUntilMonday);
      }
      break;
    }

    case AutomationScheduleCadence.Monthly:
      // Find 1st of next month
      next.setUTCDate(1);
      if (fromDate.getUTCDate() !== 1 || next <= fromDate) {
        next.setUTCMonth(next.getUTCMonth() + 1);
      }
      break;

    default:
      // Should never reach here - all cadences handled
      break;
  }

  return next;
}

/**
 * Check if a day matches the day-of-month and day-of-week constraints.
 *
 * Standard cron semantics: If both DOM and DOW are specified (non-wildcard),
 * a match on EITHER field is sufficient. If only one is specified, that one
 * must match.
 */
function dayMatchesCron(
  date: Date,
  daysOfMonth: number[] | null,
  months: number[] | null,
  daysOfWeek: number[]
): boolean {
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // Convert to 1-indexed
  const dayOfWeek = date.getUTCDay();

  // Check month constraint first (must always match if specified)
  if (months !== null && !months.includes(month)) {
    return false;
  }

  // Check if day is valid for the month (e.g., Feb 30 doesn't exist)
  const daysInMonth = getDaysInMonth(date.getUTCFullYear(), date.getUTCMonth());
  if (dayOfMonth > daysInMonth) {
    return false;
  }

  // If day-of-month is specified (non-wildcard), check it
  const domMatches = daysOfMonth === null || daysOfMonth.includes(dayOfMonth);

  // Check day-of-week (always parsed, * returns all 7 days)
  const dowMatches = daysOfWeek.includes(dayOfWeek);

  // Standard cron: if both DOM and DOW are wildcards (unrestricted), match
  // If both are specified, match if EITHER matches (OR logic)
  // If only one is specified, that one must match
  if (daysOfMonth === null) {
    // DOM is wildcard, so DOW determines the match
    return dowMatches;
  }
  // DOM is specified
  // In standard cron, when both DOM and DOW are non-wildcard,
  // the day matches if EITHER constraint is satisfied.
  // But since DOW wildcards return all days, we need to check if DOW was '*'
  const dowIsWildcard = daysOfWeek.length === 7; // '*' returns all 7 days

  if (dowIsWildcard) {
    // DOW is wildcard, so DOM determines the match
    return domMatches;
  }
  // Both are specified (non-wildcard), match if EITHER is satisfied
  return domMatches || dowMatches;
}

/**
 * Compute next run time for a cron expression.
 * Uses a simplified algorithm that iterates forward to find the next match.
 * Properly evaluates all 5 cron fields: minute, hour, day-of-month, month, day-of-week.
 *
 * @param expression - Cron expression (5 parts: min hour dom month dow)
 * @param fromDate - Date to compute from
 * @param maxIterations - Maximum days to search forward (default: 366)
 */
function computeNextRunForCron(
  expression: string,
  fromDate: Date,
  maxIterations: number = 366
): Date | null {
  const parts = parseCronExpression(expression);
  if (!parts) {
    return null;
  }

  const minutes = parseMinutes(parts.minute);
  const hours = parseHours(parts.hour);
  const daysOfMonth = parseDaysOfMonth(parts.dayOfMonth);
  const months = parseMonths(parts.month);
  const daysOfWeek = parseDaysOfWeek(parts.dayOfWeek);

  // Start from one minute after fromDate to ensure we get the "next" run
  const current = new Date(fromDate);
  current.setUTCSeconds(0, 0);
  current.setUTCMinutes(current.getUTCMinutes() + 1);

  // Iterate through days to find a match
  for (let i = 0; i < maxIterations; i++) {
    // Check if this day matches all date constraints (DOM, month, DOW)
    if (dayMatchesCron(current, daysOfMonth, months, daysOfWeek)) {
      // Find the next valid hour/minute on this day
      const startHour = i === 0 ? current.getUTCHours() : 0;

      for (const hour of hours) {
        if (hour >= startHour) {
          const startMinute =
            i === 0 && hour === startHour ? current.getUTCMinutes() : 0;
          const minute = getNextMinute(minutes, startMinute);

          if (minute !== null) {
            const result = new Date(current);
            result.setUTCHours(hour, minute, 0, 0);
            return result;
          }
        }
      }
    }

    // Move to next day at midnight UTC
    current.setUTCDate(current.getUTCDate() + 1);
    current.setUTCHours(0, 0, 0, 0);
  }

  // No match found within iteration limit
  return null;
}

/**
 * Check if a cron expression matches the given time (at minute granularity).
 *
 * This is used by the poller to determine if an automation should fire NOW,
 * rather than computing a future nextRunAt and comparing.
 */
function cronMatchesTime(expression: string, date: Date): boolean {
  const parts = parseCronExpression(expression);
  if (!parts) return false;

  const minutes = parseMinutes(parts.minute);
  const hours = parseHours(parts.hour);
  const daysOfMonth = parseDaysOfMonth(parts.dayOfMonth);
  const months = parseMonths(parts.month);
  const daysOfWeek = parseDaysOfWeek(parts.dayOfWeek);

  if (!minutes.includes(date.getUTCMinutes())) return false;
  if (!hours.includes(date.getUTCHours())) return false;
  if (!dayMatchesCron(date, daysOfMonth, months, daysOfWeek)) return false;

  return true;
}

/**
 * Check if a schedule matches the current time (at minute granularity).
 *
 * Used by the poller to determine if an automation should fire now.
 * Named cadences (daily/weekly/monthly) are checked against their
 * default schedule time (9:00 AM).
 *
 * @param schedule - Schedule configuration
 * @param now - Current time to check against (default: new Date())
 * @returns true if the schedule matches the current minute
 */
export function scheduleMatchesNow(
  schedule: AutomationSchedule,
  now: Date = new Date()
): boolean {
  const cadence = schedule.cadence;

  if (isNamedCadence(cadence)) {
    // Named cadences run at 9:00 AM UTC
    if (
      now.getUTCHours() !== DEFAULT_SCHEDULE_HOUR ||
      now.getUTCMinutes() !== DEFAULT_SCHEDULE_MINUTE
    ) {
      return false;
    }

    switch (cadence) {
      case AutomationScheduleCadence.Daily:
        return true;
      case AutomationScheduleCadence.Weekly:
        return now.getUTCDay() === 1; // Monday
      case AutomationScheduleCadence.Monthly:
        return now.getUTCDate() === 1; // 1st of month
      default:
        return false;
    }
  }

  const validation = validateSchedule(cadence);
  if (!validation.isValid) return false;

  return cronMatchesTime(cadence, now);
}

/**
 * Compute the next run time for a schedule.
 *
 * @param schedule - Schedule configuration
 * @param fromDate - Date to compute from (default: now)
 * @param maxIterations - Maximum days to search forward for cron expressions (default: 366)
 * @returns Next run date, or null if schedule is invalid or cannot be computed
 */
export function computeNextRun(
  schedule: AutomationSchedule,
  fromDate: Date = new Date(),
  maxIterations: number = 366
): Date | null {
  const cadence = schedule.cadence;

  // Check named cadences first
  if (isNamedCadence(cadence)) {
    return computeNextRunForCadence(cadence, fromDate);
  }

  // Try cron expression
  const validation = validateSchedule(cadence);
  if (!validation.isValid) {
    return null;
  }

  return computeNextRunForCron(cadence, fromDate, maxIterations);
}
