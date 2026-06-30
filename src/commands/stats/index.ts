import { existsSync } from 'fs';
import { join } from 'path';

import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import {
  calculateStats,
  parseAllSessions,
  parseDrools,
  parseSkills,
  parseUserConfig,
  parseUserSettings,
} from '@industry/utils/userStats/node';

import { getStatsOutput } from '@/commands/stats/display';
import type {
  CommandContext,
  CommandResult,
  SlashCommand,
} from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';

import type { DateRange } from '@industry/utils/userStats';

function getPeriodHelp(): string {
  const t = getI18n().t;
  return [
    t('commands:stats.periodHelp.usage'),
    '',
    t('commands:stats.periodHelp.relative'),
    t('commands:stats.periodHelp.year'),
    t('commands:stats.periodHelp.month'),
    t('commands:stats.periodHelp.range'),
    '',
    t('commands:stats.periodHelp.default'),
  ].join('\n');
}

function endOfDay(d: Date): Date {
  d.setHours(23, 59, 59, 999);
  return d;
}

export function parseDate(str: string, mode: 'start' | 'end'): Date | null {
  // YYYY
  if (/^\d{4}$/.test(str)) {
    const y = parseInt(str, 10);
    if (y < 2000 || y > 2100) return null;
    return mode === 'start' ? new Date(y, 0, 1) : endOfDay(new Date(y, 11, 31));
  }

  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(str)) {
    const [y, m] = str.split('-').map(Number);
    if (y < 2000 || y > 2100 || m < 1 || m > 12) return null;
    return mode === 'start'
      ? new Date(y, m - 1, 1)
      : endOfDay(new Date(y, m, 0));
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(y, m - 1, d);
    if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return mode === 'start' ? date : endOfDay(date);
  }

  return null;
}

function getLocalizedMonthNames(style: 'long' | 'short'): string[] {
  const locale = getI18n().language;
  const formatter = new Intl.DateTimeFormat(locale, { month: style });
  return Array.from({ length: 12 }, (_, i) =>
    formatter.format(new Date(2025, i, 1))
  );
}

export function formatRangeLabel(start: Date, end: Date): string {
  const fullMonths = getLocalizedMonthNames('long');
  const shortMonths = getLocalizedMonthNames('short');
  const sY = start.getFullYear();
  const eY = end.getFullYear();
  const sM = start.getMonth();
  const eM = end.getMonth();
  const sD = start.getDate();
  const eD = end.getDate();
  const lastDayOfEndMonth = new Date(eY, eM + 1, 0).getDate();

  // Single year: Jan 1 - Dec 31
  if (sY === eY && sM === 0 && sD === 1 && eM === 11 && eD === 31) {
    return `${sY}`;
  }

  // Single month: 1st - last day of same month
  if (sY === eY && sM === eM && sD === 1 && eD === lastDayOfEndMonth) {
    return `${fullMonths[sM]} ${sY}`;
  }

  // Same year
  if (sY === eY) {
    return `${shortMonths[sM]} ${sD} - ${shortMonths[eM]} ${eD}, ${sY}`;
  }

  // Different years
  return `${shortMonths[sM]} ${sD}, ${sY} - ${shortMonths[eM]} ${eD}, ${eY}`;
}

export function parsePeriodArg(arg: string): DateRange | null {
  // Relative: last-{N}{d|m|y}
  const relMatch = arg.match(/^last-(\d+)(d|m|y)$/);
  if (relMatch) {
    const num = parseInt(relMatch[1], 10);
    if (num <= 0) return null;
    const unit = relMatch[2];
    const now = new Date();
    const start = new Date(now.getTime());
    if (unit === 'd') {
      start.setDate(start.getDate() - num);
    } else if (unit === 'm') {
      const targetMonth = (start.getMonth() - (num % 12) + 12) % 12;
      start.setMonth(start.getMonth() - num);
      if (start.getMonth() !== targetMonth) {
        start.setDate(0);
      }
    } else {
      const targetMonth = start.getMonth();
      start.setFullYear(start.getFullYear() - num);
      if (start.getMonth() !== targetMonth) {
        start.setDate(0);
      }
    }
    return { start, end: now, label: formatRangeLabel(start, now) };
  }

  // Explicit range: start:end
  if (arg.includes(':')) {
    const parts = arg.split(':');
    if (parts.length !== 2) return null;
    const start = parseDate(parts[0], 'start');
    const end = parseDate(parts[1], 'end');
    if (!start || !end || start > end) return null;
    return { start, end, label: formatRangeLabel(start, end) };
  }

  // Year shorthand: 2025
  if (/^\d{4}$/.test(arg)) {
    const y = parseInt(arg, 10);
    if (y < 2000 || y > 2100) return null;
    const start = new Date(y, 0, 1);
    const end = endOfDay(new Date(y, 11, 31));
    return { start, end, label: formatRangeLabel(start, end) };
  }

  // Month shorthand: 2025-10
  if (/^\d{4}-\d{2}$/.test(arg)) {
    const [y, m] = arg.split('-').map(Number);
    if (y < 2000 || y > 2100 || m < 1 || m > 12) return null;
    const start = new Date(y, m - 1, 1);
    const end = endOfDay(new Date(y, m, 0));
    return { start, end, label: formatRangeLabel(start, end) };
  }

  return null;
}

// eslint-disable-next-line industry/constants-file-organization
export const statsCommand: SlashCommand = {
  name: 'stats',
  description: 'Show your Drool usage statistics (use -h for options)', // fallback; localized via commandDescriptions.ts

  execute: async (
    args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const { addEphemeralSystemMessage: addMessage } = context;

    if (args.length > 0 && (args[0] === '-h' || args[0] === '--help')) {
      addMessage(getPeriodHelp(), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true, shouldRunAgent: false };
    }

    let dateRange: DateRange | undefined;
    if (args.length > 0) {
      const parsed = parsePeriodArg(args[0]);
      if (!parsed) {
        addMessage(getPeriodHelp(), {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        });
        return { handled: true, shouldRunAgent: false };
      }
      dateRange = parsed;
      const now = new Date();
      if (dateRange.end > now) {
        dateRange = {
          ...dateRange,
          end: now,
          label: formatRangeLabel(dateRange.start, now),
        };
      }
    }

    const industryDir = join(getIndustryHome(), getIndustryDirName());

    const t = getI18n().t;

    if (!existsSync(industryDir)) {
      addMessage(t('common:stats.noIndustryDir'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true, shouldRunAgent: false };
    }

    addMessage(
      t('commands:stats.analyzing', {
        dateRange: dateRange ? ` (${dateRange.label})` : '',
      }),
      {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      }
    );

    try {
      const allSessions = await parseAllSessions();
      const sessions = allSessions.filter(
        (s) => s.messageCount > 0 && s.firstTimestamp !== null
      );

      if (sessions.length === 0) {
        addMessage(t('common:stats.noSessions'), {
          messageType: MessageType.SystemNotification,
          visibility: MessageVisibility.UserOnly,
        });
        return { handled: true, shouldRunAgent: false };
      }

      const [skills, drools, userSettings, userConfig] = await Promise.all([
        parseSkills(),
        parseDrools(),
        parseUserSettings(),
        parseUserConfig(),
      ]);

      const stats = await calculateStats(
        sessions,
        { skills, drools, userSettings, userConfig },
        dateRange
      );

      const output = getStatsOutput(stats, dateRange);

      addMessage(output, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      return { handled: true, shouldRunAgent: false };
    } catch (error) {
      logException(error, 'Error calculating stats');
      addMessage(t('common:stats.error'), {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });
      return { handled: true, shouldRunAgent: false };
    }
  },
};
