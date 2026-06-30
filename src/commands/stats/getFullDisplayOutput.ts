import chalk from 'chalk';

import {
  formatModelName,
  getAvgSessionsPerDay,
  getMostActiveTimeOfDay,
  getWeekendVsWeekday,
} from '@industry/utils/userStats';

import { MC_COLORS } from '@/components/mission-control/constants';
import { getI18n } from '@/i18n';

import type {
  Chronotype,
  DateRange,
  StatsData,
} from '@industry/utils/userStats';

function chronotypeLabel(chronotype: Chronotype): string {
  const t = getI18n().t;
  return t(`common:stats.chronotypes.${chronotype}`);
}

const mica3 = (s: string) => chalk.hex(MC_COLORS.active)(s);
const tungsten9 = (s: string) => chalk.hex(MC_COLORS.secondary)(s);
const text = (s: string) => s;
const muted = chalk.dim;

const LABEL_WIDTH = 24;
const NAME_WIDTH = 26;
const BAR_WIDTH = 30;

function formatNumber(n: number): string {
  const locale = getI18n().language;
  return n.toLocaleString(locale);
}

function formatTime(ms: number): string {
  const t = getI18n().t;
  const hours = ms / (1000 * 60 * 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = Math.round(hours % 24);
    return t('common:stats.daysHoursFormat', { days, hours: remainingHours });
  }
  if (hours >= 1) {
    return t('common:stats.hoursFormat', { value: hours.toFixed(1) });
  }
  const minutes = ms / (1000 * 60);
  return t('common:stats.minFormat', { value: Math.round(minutes) });
}

function formatDate(date: Date, includeTime = false): string {
  const locale = getI18n().language;
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  };
  if (includeTime) {
    options.hour = 'numeric';
    options.minute = '2-digit';
  }
  return date.toLocaleString(locale, options);
}

function displayOverview(stats: StatsData, lines: string[]): void {
  const t = getI18n().t;
  lines.push(`  ${mica3('*')} ${chalk.bold(t('common:stats.theNumbers'))}`);

  lines.push(muted(`  ${'─'.repeat(70)}`));

  const daysSinceJoined = stats.firstSessionDate
    ? Math.floor(
        (Date.now() - stats.firstSessionDate.getTime()) / (1000 * 60 * 60 * 24)
      )
    : 0;

  const longestSessionMs =
    stats.longestSession?.settings.assistantActiveTimeMs || 0;

  const rows = [
    [t('common:stats.rowSessions'), formatNumber(stats.totalSessions)],
    [t('common:stats.rowMessagesSent'), formatNumber(stats.totalUserMessages)],
    [t('common:stats.rowTimeWithDrool'), formatTime(stats.totalTimeMs)],
    [t('common:stats.rowLongestSession'), formatTime(longestSessionMs)],
    [
      t('common:stats.rowDaysSinceJoining'),
      t('common:stats.daysCount', { count: daysSinceJoined }),
    ],
    [
      t('common:stats.rowLongestStreak'),
      t('common:stats.daysCount', { count: stats.longestStreak }),
    ],
  ];

  for (const [label, value] of rows) {
    lines.push(`  ${text(label.padEnd(LABEL_WIDTH))} ${text(value)}`);
  }

  lines.push('');
}

function displayProjects(stats: StatsData, lines: string[]): void {
  if (stats.projectStats.length === 0) return;

  const t = getI18n().t;
  lines.push(`  ${mica3('*')} ${chalk.bold(t('common:stats.topProjects'))}`);
  lines.push(muted(`  ${'─'.repeat(70)}`));

  const topProjects = stats.projectStats.slice(0, 5);
  const maxSessions = topProjects[0]?.sessions || 1;

  for (let i = 0; i < topProjects.length; i++) {
    const proj = topProjects[i];
    const rank = `${i + 1}.`.padEnd(4);
    const nameWithRank = `${rank}${proj.name}`.padEnd(NAME_WIDTH);
    const barLength = Math.round((proj.sessions / maxSessions) * BAR_WIDTH);
    const bar =
      mica3('\u2588'.repeat(barLength)) +
      tungsten9('\u2591'.repeat(BAR_WIDTH - barLength));

    lines.push(
      `  ${text(nameWithRank)} ${bar} ${muted(t('common:stats.sessionsCount', { count: proj.sessions }))}`
    );
  }

  lines.push('');
}

function displayLanguages(stats: StatsData, lines: string[]): void {
  if (stats.languageUsage.size === 0 && stats.frameworkUsage.size === 0) return;

  const t = getI18n().t;
  lines.push(
    `  ${mica3('*')} ${chalk.bold(t('common:stats.languagesFrameworks'))}`
  );
  lines.push(muted(`  ${'─'.repeat(70)}`));

  if (stats.languageUsage.size > 0) {
    const sorted = Array.from(stats.languageUsage.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    const total = sorted.reduce((sum, [, count]) => sum + count, 0);

    for (const [lang, count] of sorted) {
      const rawPct = total > 0 ? (count / total) * 100 : 0;
      const pct = Math.round(rawPct);
      const pctLabel = (pct === 0 && count > 0 ? '<1%' : `${pct}%`).padStart(4);
      const barLength =
        count > 0 ? Math.max(1, Math.round((rawPct / 100) * BAR_WIDTH)) : 0;
      const bar =
        mica3('\u2588'.repeat(barLength)) +
        tungsten9('\u2591'.repeat(BAR_WIDTH - barLength));
      lines.push(
        `  ${text(lang.padEnd(NAME_WIDTH))} ${bar} ${muted(pctLabel)}`
      );
    }
  }

  if (stats.frameworkUsage.size > 0) {
    const sorted = Array.from(stats.frameworkUsage.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    const total = sorted.reduce((sum, [, count]) => sum + count, 0);

    lines.push('');
    lines.push(muted(`  ${t('common:stats.frameworks')}`));

    for (const [fw, count] of sorted) {
      const rawPct = total > 0 ? (count / total) * 100 : 0;
      const pct = Math.round(rawPct);
      const pctLabel = (pct === 0 && count > 0 ? '<1%' : `${pct}%`).padStart(4);
      const barLength =
        count > 0 ? Math.max(1, Math.round((rawPct / 100) * BAR_WIDTH)) : 0;
      const bar =
        mica3('\u2588'.repeat(barLength)) +
        tungsten9('\u2591'.repeat(BAR_WIDTH - barLength));
      lines.push(`  ${text(fw.padEnd(NAME_WIDTH))} ${bar} ${muted(pctLabel)}`);
    }
  }

  lines.push('');
}

function displayModels(stats: StatsData, lines: string[]): void {
  if (stats.modelUsage.size === 0) return;

  const t = getI18n().t;
  lines.push(`  ${mica3('*')} ${chalk.bold(t('common:stats.models'))}`);
  lines.push(muted(`  ${'─'.repeat(70)}`));

  const aggregated = new Map<string, { displayName: string; count: number }>();
  for (const [rawModel, count] of stats.modelUsage.entries()) {
    const displayName = formatModelName(rawModel);
    const key = displayName.endsWith('...') ? rawModel : displayName;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += count;
    } else {
      aggregated.set(key, { displayName, count });
    }
  }

  const sortedModels = Array.from(aggregated.values())
    .sort((a, b) => b.count - a.count)
    .filter(
      (item) =>
        item.displayName !== 'OpenAI' &&
        item.displayName !== 'Anthropic' &&
        item.displayName !== 'Google'
    );

  const shown =
    sortedModels.length > 0
      ? sortedModels.slice(0, 5)
      : Array.from(aggregated.values())
          .sort((a, b) => b.count - a.count)
          .slice(0, 5);

  const total = shown.reduce((acc, item) => acc + item.count, 0);

  for (const item of shown) {
    const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
    const pctLabel = `${pct}%`.padStart(4);
    const barLength = Math.round((pct / 100) * BAR_WIDTH);
    const bar =
      mica3('\u2588'.repeat(barLength)) +
      tungsten9('\u2591'.repeat(BAR_WIDTH - barLength));
    const displayName =
      item.displayName.length > NAME_WIDTH
        ? `${item.displayName.slice(0, NAME_WIDTH - 1)}\u2026`
        : item.displayName.padEnd(NAME_WIDTH);
    lines.push(`  ${text(displayName)} ${bar} ${muted(pctLabel)}`);
  }

  lines.push('');
}

function getDayOfWeekNameI18n(index: number): string {
  const t = getI18n().t;
  const dayKeys = [
    'common:stats.dayOfWeek.sunday',
    'common:stats.dayOfWeek.monday',
    'common:stats.dayOfWeek.tuesday',
    'common:stats.dayOfWeek.wednesday',
    'common:stats.dayOfWeek.thursday',
    'common:stats.dayOfWeek.friday',
    'common:stats.dayOfWeek.saturday',
  ];
  return t(dayKeys[index]);
}

function displayYourStyle(stats: StatsData, lines: string[]): void {
  const t = getI18n().t;
  lines.push(`  ${mica3('*')} ${chalk.bold(t('common:stats.yourStyle'))}`);

  lines.push(muted(`  ${'─'.repeat(70)}`));

  const mostActiveDay = stats.mostSessionsInDay;
  const avgPerDay = getAvgSessionsPerDay(stats.sessionsPerDay);
  const maxDayIndex = stats.sessionsByDayOfWeek.indexOf(
    Math.max(...stats.sessionsByDayOfWeek)
  );
  const timePreference = chronotypeLabel(
    getMostActiveTimeOfDay(stats.sessionsByHour)
  );
  const { weekend, weekday } = getWeekendVsWeekday(stats.sessionsByDayOfWeek);
  const weekdayPct =
    weekend + weekday > 0
      ? Math.round((weekday / (weekend + weekday)) * 100)
      : 0;

  lines.push(
    `  ${text(t('common:stats.chronotype').padEnd(LABEL_WIDTH))} ${text(timePreference)}`
  );
  lines.push(
    `  ${text(t('common:stats.favoriteDay').padEnd(LABEL_WIDTH))} ${text(t('common:stats.favoriteDayValue', { day: getDayOfWeekNameI18n(maxDayIndex) }))}`
  );
  lines.push(
    `  ${text(t('common:stats.avgSessionsPerDay').padEnd(LABEL_WIDTH))} ${text(avgPerDay.toFixed(1))}`
  );
  lines.push(
    `  ${text(t('common:stats.workStyle').padEnd(LABEL_WIDTH))} ${text(t('common:stats.weekdayPercent', { pct: weekdayPct }))} ${weekdayPct < 70 ? muted(t('common:stats.weekendWarrior')) : ''}`
  );

  if (mostActiveDay) {
    lines.push(
      `  ${text(t('common:stats.peakDay').padEnd(LABEL_WIDTH))} ${text(formatDate(mostActiveDay.date))} ${muted(t('common:stats.sessionsCount', { count: mostActiveDay.count }))}`
    );
  }

  if (stats.biggestTokenSession) {
    const session = stats.biggestTokenSession;
    const time = formatTime(session.settings.assistantActiveTimeMs || 0);
    lines.push(
      `  ${text(t('common:stats.biggestSession').padEnd(LABEL_WIDTH))} ${text(`${time}`)}`
    );
  }

  lines.push('');
}

function displayConfiguration(stats: StatsData, lines: string[]): void {
  const hasConfig =
    stats.skills.length > 0 ||
    stats.drools.length > 0 ||
    stats.userSettings.hooksEnabled ||
    stats.userConfig.customModels.length > 0 ||
    stats.skillUsage.size > 0 ||
    stats.droolUsage.size > 0;

  if (!hasConfig) return;

  const t = getI18n().t;
  lines.push(`  ${mica3('*')} ${chalk.bold(t('common:stats.yourSetup'))}`);
  lines.push(muted(`  ${'─'.repeat(70)}`));

  const items: string[] = [];

  if (stats.skills.length > 0) {
    items.push(t('common:stats.skillsCount', { count: stats.skills.length }));
  }
  if (stats.drools.length > 0) {
    items.push(
      t('common:stats.customDroolsCount', { count: stats.drools.length })
    );
  }
  if (stats.userSettings.hooksEnabled && stats.userSettings.hookCount > 0) {
    items.push(
      t('common:stats.hooksCount', { count: stats.userSettings.hookCount })
    );
  }
  if (stats.userConfig.customModels.length > 0) {
    items.push(
      t('common:stats.byokModelsCount', {
        count: stats.userConfig.customModels.length,
      })
    );
  }

  if (items.length > 0) {
    lines.push(`  ${text(items.join('  |  '))}`);
  }

  if (stats.skillUsage.size > 0) {
    const topSkills = Array.from(stats.skillUsage.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    lines.push(`  ${text(t('common:stats.topSkills'))}`);
    for (const [name, count] of topSkills) {
      lines.push(
        `    ${text(name)} ${muted(t('common:stats.usageCount', { count }))}`
      );
    }
  }

  if (stats.droolUsage.size > 0) {
    const topDrools = Array.from(stats.droolUsage.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    lines.push(`  ${text(t('common:stats.topDrools'))}`);
    for (const [name, count] of topDrools) {
      lines.push(
        `    ${text(name)} ${muted(t('common:stats.usageCount', { count }))}`
      );
    }
  }

  const extras: string[] = [];
  if (stats.userSettings.model) {
    extras.push(
      t('common:stats.defaultLabel', {
        model: formatModelName(stats.userSettings.model),
      })
    );
  }
  if (stats.userSettings.autonomyMode) {
    extras.push(
      t('common:stats.modeLabel', { mode: stats.userSettings.autonomyMode })
    );
  }
  if (stats.userSettings.soundsEnabled) {
    extras.push(t('common:stats.soundsOn'));
  }

  if (extras.length > 0) {
    lines.push(`  ${muted(extras.join('  |  '))}`);
  }

  lines.push('');
}

function displayBadges(stats: StatsData, lines: string[]): void {
  if (stats.badges.length === 0) return;

  const t = getI18n().t;
  lines.push(`  ${mica3('*')} ${chalk.bold(t('common:stats.badgesEarned'))}`);
  lines.push(muted(`  ${'─'.repeat(70)}`));

  for (const badge of stats.badges) {
    lines.push(`  * ${text(badge.name)} ${muted(`- ${badge.description}`)}`);
  }

  lines.push('');
}

function displayDateRange(
  stats: StatsData,
  lines: string[],
  dateRange?: DateRange
): void {
  const startDate = dateRange?.start || stats.firstSessionDate;
  const endDate = dateRange?.end || stats.lastSessionDate;
  if (startDate && endDate) {
    const t = getI18n().t;
    lines.push(
      muted(
        `  ${t('common:stats.dataFrom', { start: formatDate(startDate, true), end: formatDate(endDate, true) })}`
      )
    );
    lines.push('');
  }
}

export function getFullDisplayOutput(
  stats: StatsData,
  dateRange?: DateRange
): string {
  const lines: string[] = [];

  displayProjects(stats, lines);
  displayLanguages(stats, lines);
  displayModels(stats, lines);
  displayYourStyle(stats, lines);
  displayConfiguration(stats, lines);
  displayBadges(stats, lines);
  displayOverview(stats, lines);
  displayDateRange(stats, lines, dateRange);

  return lines.join('\n');
}
