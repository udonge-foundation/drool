import chalk from 'chalk';

import {
  daysSince,
  formatCompactNumber,
  formatCompactTime,
  formatModelName,
  getTopUserFacingModel,
} from '@industry/utils/userStats';

import { getFullDisplayOutput } from '@/commands/stats/getFullDisplayOutput';
import { getThemedColors } from '@/components/chat/themedColors';
import { MC_COLORS } from '@/components/mission-control/constants';
import { getI18n } from '@/i18n';

import type { DateRange, StatsData } from '@industry/utils/userStats';

function getStatsChalk() {
  const mc = MC_COLORS;
  const colors = getThemedColors();
  return {
    mica3: chalk.hex(mc.active),
    mica4: chalk.hex(colors.primary),
    mica5: chalk.hex(colors.text.muted),
    mica6: chalk.hex(colors.text.muted),
    text: (s: string) => s,
    muted: chalk.dim,
  };
}

const MAX_WIDTH = 70;

function wrapText(
  str: string,
  style?: (s: string) => string,
  maxWidth: number = MAX_WIDTH,
  indent = 2
): string {
  const words = str.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxWidth - indent) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines
    .map((line) => ' '.repeat(indent) + (style ? style(line) : line))
    .join('\n');
}

// Literature comparisons by word count
function getActivityCell(intensity: number): string {
  const { mica3, mica4, mica5, mica6, muted } = getStatsChalk();
  const block = '\u2588';
  switch (intensity) {
    case 0:
      return muted('\u00B7');
    case 1:
      return mica6(block);
    case 2:
      return mica5(block);
    case 3:
      return mica4(block);
    case 4:
      return mica3(block);
    default:
      return muted('\u00B7');
  }
}

interface ActivityRow {
  label: string;
  cells: number[];
  total: number;
}

function getLocalizedMonthNames(): string[] {
  const locale = getI18n().language;
  const formatter = new Intl.DateTimeFormat(locale, { month: 'short' });
  return Array.from({ length: 12 }, (_, i) =>
    formatter.format(new Date(2025, i, 1))
  );
}

function getLocalizedDayNames(): string[] {
  const locale = getI18n().language;
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  // Sunday = 0 (Jan 5, 2025 is a Sunday)
  return Array.from({ length: 7 }, (_, i) =>
    formatter.format(new Date(2025, 0, 5 + i))
  );
}

function getRangeSpanDays(stats: StatsData, dateRange?: DateRange): number {
  if (dateRange) {
    return Math.ceil(
      (dateRange.end.getTime() - dateRange.start.getTime()) /
        (1000 * 60 * 60 * 24)
    );
  }
  if (stats.firstSessionDate && stats.lastSessionDate) {
    return Math.ceil(
      (stats.lastSessionDate.getTime() - stats.firstSessionDate.getTime()) /
        (1000 * 60 * 60 * 24)
    );
  }
  return 0;
}

function getHourlyActivity(
  stats: StatsData,
  dateRange?: DateRange
): ActivityRow[] {
  const startDate = dateRange?.start || stats.firstSessionDate || new Date();
  const endDate = dateRange?.end || stats.lastSessionDate || new Date();
  const rows: ActivityRow[] = [];

  const current = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate()
  );
  const end = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate()
  );

  const dayNames = getLocalizedDayNames();
  const monthNames = getLocalizedMonthNames();

  while (current <= end) {
    const label = `${dayNames[current.getDay()]} ${monthNames[current.getMonth()]} ${current.getDate()}`;
    const cells: number[] = [];
    let total = 0;

    for (let hour = 0; hour < 24; hour++) {
      const hourMs = new Date(
        current.getFullYear(),
        current.getMonth(),
        current.getDate(),
        hour
      ).getTime();
      const count = stats.sessionsPerHourKey.get(hourMs) || 0;
      cells.push(count);
      total += count;
    }

    rows.push({ label, cells, total });
    current.setDate(current.getDate() + 1);
  }

  return rows;
}

function getMonthlyActivity(
  stats: StatsData,
  dateRange?: DateRange
): ActivityRow[] {
  const startDate = dateRange?.start || stats.firstSessionDate || new Date();
  const endDate = dateRange?.end || stats.lastSessionDate || new Date();
  const rows: ActivityRow[] = [];

  const monthNames = getLocalizedMonthNames();
  const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const endMonth = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0);

  while (current <= endMonth) {
    const year = current.getFullYear();
    const month = current.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: number[] = [];
    let total = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const dayMs = new Date(year, month, day).getTime();
      const count = stats.sessionsPerDay.get(dayMs) || 0;
      cells.push(count);
      total += count;
    }

    rows.push({ label: monthNames[month], cells, total });
    current.setMonth(current.getMonth() + 1);
  }

  return rows;
}

function getActivityRows(
  stats: StatsData,
  dateRange?: DateRange
): { rows: ActivityRow[]; maxCells: number } {
  const spanDays = getRangeSpanDays(stats, dateRange);

  if (spanDays <= 21) {
    return { rows: getHourlyActivity(stats, dateRange), maxCells: 24 };
  }
  return { rows: getMonthlyActivity(stats, dateRange), maxCells: 31 };
}

function centerText(str: string, width: number): string {
  if (str.length >= width) return str;
  const left = Math.floor((width - str.length) / 2);
  const right = width - str.length - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

function displaySummaryActivityGraph(
  stats: StatsData,
  lines: string[],
  dateRange?: DateRange
): void {
  const { rows, maxCells } = getActivityRows(stats, dateRange);

  while (rows.length > 0 && rows[0].total === 0) {
    rows.shift();
  }

  if (rows.length === 0) return;

  let maxSessions = 1;
  for (const row of rows) {
    for (const count of row.cells) {
      if (count > maxSessions) maxSessions = count;
    }
  }

  const maxLabelLen = Math.max(...rows.map((r) => r.label.length));

  for (const row of rows) {
    const label = row.label.padStart(maxLabelLen);
    let bar = '';
    let visibleLength = 0;

    for (const count of row.cells) {
      const intensity = count === 0 ? 0 : Math.ceil((count / maxSessions) * 4);
      bar += getActivityCell(intensity);
      visibleLength++;
    }

    const padding = ' '.repeat(Math.max(0, maxCells - visibleLength));

    const { muted } = getStatsChalk();
    const t = getI18n().t;
    lines.push(
      `  ${muted(label)} ${bar}${padding} ${muted(t('common:stats.sessionsCount', { count: row.total }))}`
    );
  }

  const { muted } = getStatsChalk();
  const t = getI18n().t;
  lines.push('');
  const legendPad = ' '.repeat(maxLabelLen + 1);
  lines.push(
    `  ${legendPad}${muted(t('common:stats.less'))} ${getActivityCell(0)}${getActivityCell(1)}${getActivityCell(2)}${getActivityCell(3)}${getActivityCell(4)} ${muted(t('common:stats.more'))}`
  );
}

function getShortSummaryOutput(
  stats: StatsData,
  dateRange?: DateRange,
  quip?: string | null
): string {
  const { mica3, muted, text } = getStatsChalk();
  const t = getI18n().t;
  const lines: string[] = [];
  const separator = mica3('─'.repeat(70));

  lines.push(`  ${chalk.bold(centerText(t('common:stats.wrappedTitle'), 70))}`);
  lines.push(`  ${separator}`);
  lines.push('');

  const daysSinceJoined = daysSince(stats.firstSessionDate);
  const longestSessionMs =
    stats.longestSession?.settings.assistantActiveTimeMs || 0;
  const locale = getI18n().language;

  const sessionsVal = formatCompactNumber(stats.totalSessions, locale);
  const timeVal = formatCompactTime(stats.totalTimeMs);
  const streakVal = `${stats.longestStreak}d`;
  const longestVal = formatCompactTime(longestSessionMs);
  const memberVal = `${daysSinceJoined}d`;

  const colWidth = 14;
  const valuesRow = [sessionsVal, timeVal, streakVal, longestVal, memberVal]
    .map((v) => centerText(v, colWidth))
    .join('');
  const labelsRow = [
    t('common:stats.sessions'),
    t('common:stats.time'),
    t('common:stats.streak'),
    t('common:stats.longest'),
    t('common:stats.member'),
  ]
    .map((l) => centerText(l, colWidth))
    .join('');

  lines.push(`  ${chalk.bold(valuesRow)}`);
  lines.push(`  ${muted(labelsRow)}`);
  lines.push('');

  displaySummaryActivityGraph(stats, lines, dateRange);
  lines.push('');

  const topModel = getTopUserFacingModel(stats.modelUsage);

  if (topModel) {
    lines.push(
      `  ${muted(t('common:stats.topModel'))} ${chalk.bold(formatModelName(topModel))}`
    );
  }
  lines.push('');

  if (stats.badges.length > 0) {
    lines.push(`  ${chalk.bold(t('common:stats.badges'))}`);
    for (const badge of stats.badges) {
      lines.push(
        `  ${mica3('\u2605')} ${text(badge.name)} ${muted(`- ${badge.description}`)}`
      );
    }
    lines.push('');
  }

  if (quip) {
    lines.push(wrapText(quip));
    lines.push('');
  }

  lines.push(`  ${separator}`);

  return lines.join('\n');
}

export function getStatsOutput(
  stats: StatsData,
  dateRange?: DateRange
): string {
  const fullDisplay = getFullDisplayOutput(stats, dateRange);

  const badgesWithQuips = stats.badges.filter((b) => b.quip);
  const selectedBadge =
    badgesWithQuips.length > 0
      ? badgesWithQuips[Math.floor(Math.random() * badgesWithQuips.length)]
      : null;

  const quipLine = selectedBadge
    ? `${selectedBadge.description}? ${selectedBadge.quip}`
    : null;

  const t = getI18n().t;
  const thankYouLines = [
    t('common:stats.thankYouFriend'),
    t('common:stats.industryTeam'),
  ];
  const { muted: mutedStyle } = getStatsChalk();
  const thankYou = `\n${thankYouLines.map((line) => wrapText(line, mutedStyle)).join('\n')}\n`;

  return `${fullDisplay}\n\n${getShortSummaryOutput(stats, dateRange, quipLine)}${thankYou}`;
}
