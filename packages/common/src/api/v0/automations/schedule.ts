import { CRON_DAY_OF_WEEK_ALIASES, CRON_MONTH_ALIASES } from './constants';

import type { CronParts } from './types';

const DEFAULT_NATURAL_SCHEDULE_HOUR = 9;
const DEFAULT_NATURAL_SCHEDULE_MINUTE = 0;

const DAY_OF_WEEK_ALIASES = new Map<string, number>([
  ['sun', 0],
  ['sunday', 0],
  ['sundays', 0],
  ['mon', 1],
  ['monday', 1],
  ['mondays', 1],
  ['tue', 2],
  ['tues', 2],
  ['tuesday', 2],
  ['tuesdays', 2],
  ['wed', 3],
  ['weds', 3],
  ['wednesday', 3],
  ['wednesdays', 3],
  ['thu', 4],
  ['thur', 4],
  ['thurs', 4],
  ['thursday', 4],
  ['thursdays', 4],
  ['fri', 5],
  ['friday', 5],
  ['fridays', 5],
  ['sat', 6],
  ['saturday', 6],
  ['saturdays', 6],
]);

const TIME_ZONE_OFFSETS_MINUTES = new Map<string, number>([
  ['utc', 0],
  ['gmt', 0],
  ['pst', -8 * 60],
  ['pacific standard time', -8 * 60],
  ['pdt', -7 * 60],
  ['pacific daylight time', -7 * 60],
  ['mst', -7 * 60],
  ['mountain standard time', -7 * 60],
  ['mdt', -6 * 60],
  ['mountain daylight time', -6 * 60],
  ['cst', -6 * 60],
  ['central standard time', -6 * 60],
  ['cdt', -5 * 60],
  ['central daylight time', -5 * 60],
  ['est', -5 * 60],
  ['eastern standard time', -5 * 60],
  ['edt', -4 * 60],
  ['eastern daylight time', -4 * 60],
]);

// Generic US timezone abbreviations (e.g. "PT") follow daylight saving, so we
// resolve their offset against the matching IANA zone at parse time rather than
// hard-coding a single standard/daylight offset.
const GENERIC_TIME_ZONE_IANA = new Map<string, string>([
  ['pt', 'America/Los_Angeles'],
  ['pacific time', 'America/Los_Angeles'],
  ['mt', 'America/Denver'],
  ['mountain time', 'America/Denver'],
  ['ct', 'America/Chicago'],
  ['central time', 'America/Chicago'],
  ['et', 'America/New_York'],
  ['eastern time', 'America/New_York'],
]);

function getIanaTimeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const zonedDate = new Date(date.toLocaleString('en-US', { timeZone }));
  return Math.round((zonedDate.getTime() - utcDate.getTime()) / 60000);
}

function resolveTimeZoneOffsetMinutes(name: string): number | null {
  const staticOffset = TIME_ZONE_OFFSETS_MINUTES.get(name);
  if (staticOffset !== undefined) {
    return staticOffset;
  }

  const ianaZone = GENERIC_TIME_ZONE_IANA.get(name);
  if (ianaZone !== undefined) {
    return getIanaTimeZoneOffsetMinutes(ianaZone, new Date());
  }

  return null;
}

const TIME_ZONE_NAMES_BY_LENGTH_DESC = [
  ...TIME_ZONE_OFFSETS_MINUTES.keys(),
  ...GENERIC_TIME_ZONE_IANA.keys(),
].sort((a, b) => b.length - a.length);

// eslint-disable-next-line no-restricted-syntax -- co-located with cron schema validation in @industry/common
export function parseCronParts(expression: string): CronParts | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
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

function normalizeNaturalScheduleText(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\s+/g, ' ');
}

function formatCronTime(hour: number, minute: number): string {
  return `${minute} ${hour}`;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function parseTimeZone(input: string): {
  offsetMinutes: number;
  text: string;
} {
  for (const name of TIME_ZONE_NAMES_BY_LENGTH_DESC) {
    const regex = new RegExp(`\\b${name}\\b`, 'g');
    if (!regex.test(input)) {
      continue;
    }

    const offsetMinutes = resolveTimeZoneOffsetMinutes(name);
    if (offsetMinutes === null) {
      continue;
    }

    return {
      offsetMinutes,
      text: input.replace(regex, ' ').replace(/\s+/g, ' ').trim(),
    };
  }

  return { offsetMinutes: 0, text: input };
}

function toUtcTime(
  time: { hour: number; minute: number },
  offsetMinutes: number
): { hour: number; minute: number; dayShift: number } {
  const utcMinutes = time.hour * 60 + time.minute - offsetMinutes;
  const normalizedMinutes = positiveModulo(utcMinutes, 24 * 60);
  return {
    hour: Math.floor(normalizedMinutes / 60),
    minute: normalizedMinutes % 60,
    dayShift: Math.floor(utcMinutes / (24 * 60)),
  };
}

function formatDayOfWeekList(days: number[]): string {
  const normalizedDays = Array.from(
    new Set(days.map((day) => positiveModulo(day, 7)))
  ).sort((a, b) => a - b);

  if (normalizedDays.length === 7) return '*';
  if (normalizedDays.join(',') === '1,2,3,4,5') return '1-5';
  return normalizedDays.join(',');
}

function shiftDayOfWeekList(days: number[], dayShift: number): string {
  return formatDayOfWeekList(days.map((day) => day + dayShift));
}

function parseScheduleTime(
  input: string
): { hour: number; minute: number } | null {
  if (/\bnoon\b/.test(input)) {
    return { hour: 12, minute: 0 };
  }

  if (/\bmidnight\b/.test(input)) {
    return { hour: 0, minute: 0 };
  }

  const match =
    /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(input) ??
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(input);

  if (!match) {
    return null;
  }

  const hourPart = match[1];
  const minutePart = match[2] ?? '0';
  const meridiem = match[3];
  let hour = Number(hourPart);
  const minute = Number(minutePart);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    if (meridiem === 'am') {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute };
}

function hasExplicitScheduleTime(input: string): boolean {
  return (
    /\bat\s+\d{1,2}(?::\d{1,2})?\s*(?:am|pm)?\b/.test(input) ||
    /\b\d{1,2}(?::\d{1,2})?\s*(?:am|pm)\b/.test(input) ||
    /\b(?:noon|midnight)\b/.test(input)
  );
}

function parseDayOfWeekList(input: string): number[] {
  const days = new Set<number>();
  for (const token of input.split(/\s+/)) {
    const day = DAY_OF_WEEK_ALIASES.get(token);
    if (day !== undefined) {
      days.add(day);
    }
  }
  return Array.from(days).sort((a, b) => a - b);
}

function stripTimePhrase(input: string): string {
  return input
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/g, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/g, ' ')
    .replace(/\b(?:noon|midnight)\b/g, ' ')
    .replace(/\s+/g, ' ');
}

function parseMonthDay(input: string): number | null {
  const withoutTime = stripTimePhrase(input);
  const match =
    /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/.exec(withoutTime) ??
    /\b(?:on\s+)?(?:the\s+)?day\s+(\d{1,2})\b/.exec(withoutTime);
  if (!match) {
    return 1;
  }

  const day = Number(match[1]);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

function parseNaturalLanguageSchedule(input: string): string | null {
  const normalized = normalizeNaturalScheduleText(input);
  if (!normalized) {
    return null;
  }
  const { offsetMinutes, text: scheduleText } = parseTimeZone(normalized);

  if (/^every minute$/.test(scheduleText)) {
    return '* * * * *';
  }

  const everyMinutes = /^every\s+(\d+)\s+(?:minutes?|mins?)$/.exec(
    scheduleText
  );
  if (everyMinutes) {
    const minutes = Number(everyMinutes[1]);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 59
      ? `*/${minutes} * * * *`
      : null;
  }

  if (/^(?:hourly|every hour)$/.test(scheduleText)) {
    return '0 * * * *';
  }

  const everyHours = /^every\s+(\d+)\s+hours?$/.exec(scheduleText);
  if (everyHours) {
    const hours = Number(everyHours[1]);
    return Number.isInteger(hours) && hours >= 1 && hours <= 23
      ? `0 */${hours} * * *`
      : null;
  }

  const parsedTime = parseScheduleTime(scheduleText);
  if (!parsedTime && hasExplicitScheduleTime(scheduleText)) {
    return null;
  }

  const { hour, minute, dayShift } = toUtcTime(
    parsedTime ?? {
      hour: DEFAULT_NATURAL_SCHEDULE_HOUR,
      minute: DEFAULT_NATURAL_SCHEDULE_MINUTE,
    },
    offsetMinutes
  );
  const cronTime = formatCronTime(hour, minute);

  if (/\b(?:monthly|every month|each month)\b/.test(scheduleText)) {
    const monthDay = parseMonthDay(scheduleText);
    if (!monthDay) {
      return null;
    }
    const shiftedMonthDay = monthDay + dayShift;
    return shiftedMonthDay >= 1 && shiftedMonthDay <= 31
      ? `${cronTime} ${shiftedMonthDay} * *`
      : null;
  }

  if (/\b(?:weekdays?|business days?)\b/.test(scheduleText)) {
    return `${cronTime} * * ${shiftDayOfWeekList([1, 2, 3, 4, 5], dayShift)}`;
  }

  if (/\bweekends?\b/.test(scheduleText)) {
    return `${cronTime} * * ${shiftDayOfWeekList([0, 6], dayShift)}`;
  }

  const daysOfWeek = parseDayOfWeekList(scheduleText);
  if (daysOfWeek.length > 0) {
    return `${cronTime} * * ${shiftDayOfWeekList(daysOfWeek, dayShift)}`;
  }

  if (/\b(?:weekly|every week|each week)\b/.test(scheduleText)) {
    return `${cronTime} * * ${shiftDayOfWeekList([1], dayShift)}`;
  }

  if (
    /\b(?:daily|every day|each day)\b/.test(scheduleText) ||
    parseScheduleTime(scheduleText)
  ) {
    return `${cronTime} * * *`;
  }

  return null;
}

function resolveCronToken(
  token: string,
  aliases?: Record<string, number>
): number {
  const direct = parseInt(token, 10);
  if (!Number.isNaN(direct)) {
    return direct;
  }
  if (aliases) {
    const alias = aliases[token.toUpperCase()];
    if (alias !== undefined) {
      return alias;
    }
  }
  return Number.NaN;
}

function isValidCronFieldToken(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>
): boolean {
  if (field === '*') {
    return true;
  }

  if (field.includes('/')) {
    const [range, step] = field.split('/');
    const stepNum = parseInt(step, 10);
    if (Number.isNaN(stepNum) || stepNum <= 0) {
      return false;
    }
    return isValidCronFieldToken(range, min, max, aliases);
  }

  if (field.includes('-')) {
    const [start, end] = field.split('-');
    const startNum = resolveCronToken(start, aliases);
    const endNum = resolveCronToken(end, aliases);
    if (Number.isNaN(startNum) || Number.isNaN(endNum)) {
      return false;
    }
    return (
      startNum >= min &&
      startNum <= max &&
      endNum >= min &&
      endNum <= max &&
      startNum <= endNum
    );
  }

  if (field.includes(',')) {
    return field
      .split(',')
      .every((part) => isValidCronFieldToken(part, min, max, aliases));
  }

  const num = resolveCronToken(field, aliases);
  if (!Number.isNaN(num)) {
    return num >= min && num <= max;
  }

  return false;
}

// eslint-disable-next-line no-restricted-syntax -- co-located with cron schema validation in @industry/common
export function parseField(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>
): number[] {
  if (field === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  }

  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      const stepNum = parseInt(step, 10);
      if (Number.isNaN(stepNum) || stepNum <= 0) {
        continue;
      }

      const rangeStart =
        range === '*' ? min : resolveCronToken(range.split('-')[0], aliases);
      const rangeEnd =
        range === '*'
          ? max
          : resolveCronToken(range.split('-')[1] ?? String(max), aliases);
      if (Number.isNaN(rangeStart) || Number.isNaN(rangeEnd)) {
        continue;
      }

      for (let i = rangeStart; i <= rangeEnd; i += stepNum) {
        if (i >= min && i <= max) values.add(i);
      }
    } else if (part.includes('-')) {
      const [start, end] = part.split('-');
      const startNum = resolveCronToken(start, aliases);
      const endNum = resolveCronToken(end, aliases);
      if (Number.isNaN(startNum) || Number.isNaN(endNum)) {
        continue;
      }
      for (let i = startNum; i <= endNum; i++) {
        if (i >= min && i <= max) values.add(i);
      }
    } else {
      const num = resolveCronToken(part, aliases);
      if (!Number.isNaN(num) && num >= min && num <= max) {
        values.add(num);
      }
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

function isValidCronField(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>
): boolean {
  return isValidCronFieldToken(field, min, max, aliases);
}

function fieldHasCronAliases(
  field: string,
  aliases: Record<string, number>
): boolean {
  const tokens = field.toUpperCase().split(/[,\-/]/);
  return tokens.some((token) => aliases[token] !== undefined);
}

function normalizeCronDayOfWeekField(field: string): string {
  if (
    field === '*' ||
    (!field.includes('7') &&
      !fieldHasCronAliases(field, CRON_DAY_OF_WEEK_ALIASES))
  ) {
    return field;
  }

  const days = parseField(field, 0, 7, CRON_DAY_OF_WEEK_ALIASES);
  if (days.length === 0) {
    return field;
  }

  const normalizedDays = Array.from(
    new Set(days.map((day) => (day === 7 ? 0 : day)))
  ).sort((a, b) => a - b);

  return normalizedDays.length === 7 ? '*' : normalizedDays.join(',');
}

function normalizeCronMonthField(field: string): string {
  if (field === '*' || !fieldHasCronAliases(field, CRON_MONTH_ALIASES)) {
    return field;
  }

  const months = parseField(field, 1, 12, CRON_MONTH_ALIASES);
  if (months.length === 0) {
    return field;
  }

  return months.length === 12 ? '*' : months.join(',');
}

function normalizeCronExpression(expression: string): string {
  const parts = parseCronParts(expression);
  if (!parts) {
    return expression;
  }

  return [
    parts.minute,
    parts.hour,
    parts.dayOfMonth,
    normalizeCronMonthField(parts.month),
    normalizeCronDayOfWeekField(parts.dayOfWeek),
  ].join(' ');
}

// eslint-disable-next-line no-restricted-syntax -- co-located with cron schema validation in @industry/common
export function isValidCronExpression(expression: string): boolean {
  const parts = parseCronParts(expression);
  if (!parts) {
    return false;
  }

  return (
    isValidCronField(parts.minute, 0, 59) &&
    isValidCronField(parts.hour, 0, 23) &&
    isValidCronField(parts.dayOfMonth, 1, 31) &&
    isValidCronField(parts.month, 1, 12, CRON_MONTH_ALIASES) &&
    isValidCronField(parts.dayOfWeek, 0, 7, CRON_DAY_OF_WEEK_ALIASES)
  );
}

function normalizeAutomationScheduleInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (isValidCronExpression(trimmed)) {
    return normalizeCronExpression(trimmed);
  }
  return parseNaturalLanguageSchedule(trimmed);
}

function isValidAutomationScheduleInput(input: string): boolean {
  return normalizeAutomationScheduleInput(input) !== null;
}

export { isValidAutomationScheduleInput, normalizeAutomationScheduleInput };
