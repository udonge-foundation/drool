import { getMostActiveDay } from './aggregates';
import { generateBadges } from './badges';
import { detectFrameworks, detectLanguages } from './parser';
import { toLocalDayMs, toLocalHourMs } from './toLocalDateKey';

import type {
  AdditionalData,
  DateRange,
  ProjectStats,
  SessionData,
  StatsData,
} from './types';

function getTotalTokens(session: SessionData): number {
  const tokens = session.settings.tokenUsage;
  if (!tokens) return 0;
  const cacheEquivalent = Math.round(
    (tokens.cacheCreationTokens || 0) + (tokens.cacheReadTokens || 0)
  );
  return (
    (tokens.inputTokens || 0) +
    (tokens.outputTokens || 0) +
    (tokens.thinkingTokens || 0) +
    cacheEquivalent
  );
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function calculateStreaks(sessionsPerDay: Map<number, number>): {
  current: number;
  longest: number;
} {
  const days = Array.from(sessionsPerDay.keys()).sort((a, b) => a - b);
  if (days.length === 0) return { current: 0, longest: 0 };

  let maxStreak = 1;
  let currentStreak = 1;
  let activeStreak = 1;

  const todayMs = toLocalDayMs(new Date());
  const yesterdayMs = toLocalDayMs(new Date(Date.now() - 86400000));
  const lastDay = days[days.length - 1];
  const isActive = lastDay === todayMs || lastDay === yesterdayMs;

  for (let i = 1; i < days.length; i++) {
    const diffDays = Math.round((days[i] - days[i - 1]) / MS_PER_DAY);

    if (diffDays === 1) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }

  activeStreak = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const diffDays = Math.round((days[i] - days[i - 1]) / MS_PER_DAY);

    if (diffDays === 1) {
      activeStreak++;
    } else {
      break;
    }
  }

  return {
    current: isActive ? activeStreak : 0,
    longest: maxStreak,
  };
}

export async function calculateStats(
  sessions: SessionData[],
  additionalData: AdditionalData,
  dateRange?: DateRange
): Promise<StatsData> {
  const filtered = dateRange
    ? sessions.filter(
        (s) =>
          s.firstTimestamp &&
          s.firstTimestamp >= dateRange.start &&
          s.firstTimestamp <= dateRange.end
      )
    : sessions;

  const stats: StatsData = {
    totalSessions: filtered.length,
    totalMessages: 0,
    totalUserMessages: 0,
    totalTimeMs: 0,
    firstSessionDate: null,
    lastSessionDate: null,
    sessionsPerDay: new Map(),
    sessionsPerHourKey: new Map(),
    sessionsByDayOfWeek: new Array(7).fill(0) as number[],
    sessionsByHour: new Array(24).fill(0) as number[],
    projectStats: [],
    modelUsage: new Map(),
    languageUsage: new Map(),
    frameworkUsage: new Map(),
    longestSession: null,
    biggestTokenSession: null,
    currentStreak: 0,
    longestStreak: 0,
    avgSessionLength: 0,
    mostSessionsInDay: null,
    skills: additionalData.skills,
    drools: additionalData.drools,
    skillUsage: new Map(),
    droolUsage: new Map(),
    userSettings: additionalData.userSettings,
    userConfig: additionalData.userConfig,
    badges: [],
  };

  const projectMap = new Map<string, ProjectStats & { path: string | null }>();

  for (const session of filtered) {
    stats.totalMessages += session.messageCount;
    stats.totalUserMessages += session.userMessageCount;

    if (session.settings.tokenUsage) {
      const sessionTokens = getTotalTokens(session);
      if (
        sessionTokens > 0 &&
        (!stats.biggestTokenSession ||
          sessionTokens > getTotalTokens(stats.biggestTokenSession))
      ) {
        stats.biggestTokenSession = session;
      }
    }

    const timeMs = session.settings.assistantActiveTimeMs || 0;
    stats.totalTimeMs += timeMs;

    if (
      !stats.longestSession ||
      timeMs > (stats.longestSession.settings.assistantActiveTimeMs || 0)
    ) {
      stats.longestSession = session;
    }

    if (session.firstTimestamp) {
      if (
        !stats.firstSessionDate ||
        session.firstTimestamp < stats.firstSessionDate
      ) {
        stats.firstSessionDate = session.firstTimestamp;
      }
      if (
        !stats.lastSessionDate ||
        session.firstTimestamp > stats.lastSessionDate
      ) {
        stats.lastSessionDate = session.firstTimestamp;
      }

      const dayMs = toLocalDayMs(session.firstTimestamp);
      stats.sessionsPerDay.set(
        dayMs,
        (stats.sessionsPerDay.get(dayMs) || 0) + 1
      );

      stats.sessionsByDayOfWeek[session.firstTimestamp.getDay()]++;
      stats.sessionsByHour[session.firstTimestamp.getHours()]++;

      const hourMs = toLocalHourMs(session.firstTimestamp);
      stats.sessionsPerHourKey.set(
        hourMs,
        (stats.sessionsPerHourKey.get(hourMs) || 0) + 1
      );
    }

    const projectName = session.project || 'General';
    if (!projectMap.has(projectName)) {
      projectMap.set(projectName, {
        name: projectName,
        path: session.projectPath,
        sessions: 0,
        timeMs: 0,
        languages: [],
        frameworks: [],
      });
    }
    const proj = projectMap.get(projectName)!;
    proj.sessions++;
    proj.timeMs += timeMs;

    if (session.messageCount > 0) {
      const model =
        session.settings.model ||
        session.actualModel ||
        session.settings.providerLock ||
        'unknown';
      stats.modelUsage.set(model, (stats.modelUsage.get(model) || 0) + 1);
    }

    for (const skill of session.skillsUsed) {
      stats.skillUsage.set(skill, (stats.skillUsage.get(skill) || 0) + 1);
    }

    for (const drool of session.droolsUsed) {
      stats.droolUsage.set(drool, (stats.droolUsage.get(drool) || 0) + 1);
    }
  }

  const projectList = Array.from(projectMap.values()).sort(
    (a, b) => b.sessions - a.sessions
  );
  const topProjects = projectList.slice(0, 50);

  for (const proj of topProjects) {
    if (proj.path) {
      const languages = await detectLanguages(proj.path);
      proj.languages = languages;
      for (const lang of languages) {
        stats.languageUsage.set(
          lang,
          (stats.languageUsage.get(lang) || 0) + proj.sessions
        );
      }

      const frameworks = await detectFrameworks(proj.path);
      proj.frameworks = frameworks;
      for (const fw of frameworks) {
        stats.frameworkUsage.set(
          fw,
          (stats.frameworkUsage.get(fw) || 0) + proj.sessions
        );
      }
    }
  }

  stats.projectStats = projectList;

  if (stats.totalSessions > 0) {
    stats.avgSessionLength = stats.totalMessages / stats.totalSessions;
  }

  const { current, longest } = calculateStreaks(stats.sessionsPerDay);
  stats.currentStreak = current;
  stats.longestStreak = longest;

  stats.mostSessionsInDay = getMostActiveDay(stats.sessionsPerDay);

  stats.badges = generateBadges(stats);

  return stats;
}
