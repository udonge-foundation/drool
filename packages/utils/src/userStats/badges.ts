import { logWarn } from '@industry/logging';

import type { Badge, StatsData } from './types';

interface BadgeDefinition {
  name: string;
  description: string | ((stats: StatsData) => string);
  quip?: string;
  group?: string;
  tier?: number;
  check: (stats: StatsData) => boolean;
}

const BADGE_DEFINITIONS: BadgeDefinition[] = [
  {
    name: 'Super User',
    description: '1000+ sessions',
    quip: 'At this point, Drool should be paying rent in your terminal.',
    group: 'sessions',
    tier: 3,
    check: (s) => s.totalSessions >= 1000,
  },
  {
    name: 'Power User',
    description: '500+ sessions',
    quip: 'Your git log is basically a conversation history at this point.',
    group: 'sessions',
    tier: 2,
    check: (s) => s.totalSessions >= 500,
  },
  {
    name: 'Getting Started',
    description: '100+ sessions',
    quip: 'First 100 down, infinite context windows to go.',
    group: 'sessions',
    tier: 1,
    check: (s) => s.totalSessions >= 100,
  },

  {
    name: 'Streak Legend',
    description: '30+ day streak',
    quip: 'A month straight. Even Duolingo owl is impressed.',
    group: 'streak',
    tier: 3,
    check: (s) => s.longestStreak >= 30,
  },
  {
    name: 'Streak Master',
    description: '14+ day streak',
    quip: 'Two weeks of daily cooking. Your commit graph is thriving.',
    group: 'streak',
    tier: 2,
    check: (s) => s.longestStreak >= 14,
  },
  {
    name: 'Streak Starter',
    description: '7+ day streak',
    quip: 'A full week. The habit is forming.',
    group: 'streak',
    tier: 1,
    check: (s) => s.longestStreak >= 7,
  },

  {
    name: 'Centurion',
    description: '100+ hours total',
    quip: "That's 4+ days of pure Drool time. Touch grass?",
    group: 'total_time',
    tier: 5,
    check: (s) => s.totalTimeMs >= 100 * 60 * 60 * 1000,
  },
  {
    name: 'Drool Veteran',
    description: '50+ hours total',
    quip: "Longer than most Netflix binges. At least you're shipping.",
    group: 'total_time',
    tier: 4,
    check: (s) => s.totalTimeMs >= 50 * 60 * 60 * 1000,
  },
  {
    name: 'Drool Regular',
    description: '25+ hours total',
    quip: "A full day with Drool. Time flies when you're shipping features.",
    group: 'total_time',
    tier: 3,
    check: (s) => s.totalTimeMs >= 25 * 60 * 60 * 1000,
  },
  {
    name: 'Drool Familiar',
    description: '5+ hours total',
    quip: 'More than most movies. Better plot too.',
    group: 'total_time',
    tier: 2,
    check: (s) => s.totalTimeMs >= 5 * 60 * 60 * 1000,
  },
  {
    name: 'First Hour',
    description: '1+ hour total',
    quip: 'The first hour of many.',
    group: 'total_time',
    tier: 1,
    check: (s) => s.totalTimeMs >= 1 * 60 * 60 * 1000,
  },

  {
    name: 'Code is Life',
    description: '16+ hour session',
    quip: 'Drool would like to speak with HR about work-life balance.',
    group: 'marathon',
    tier: 5,
    check: (s) => {
      if (!s.longestSession) return false;
      const timeMs = s.longestSession.settings.assistantActiveTimeMs || 0;
      return timeMs >= 16 * 60 * 60 * 1000;
    },
  },
  {
    name: 'Ultra Marathon',
    description: '8+ hour session',
    quip: 'Longer than a typical Lex Fridman Podcast.',
    group: 'marathon',
    tier: 4,
    check: (s) => {
      if (!s.longestSession) return false;
      const timeMs = s.longestSession.settings.assistantActiveTimeMs || 0;
      return timeMs >= 8 * 60 * 60 * 1000;
    },
  },
  {
    name: 'Marathon Coder',
    description: '4+ hour session',
    quip: 'All that just for another useEffect?',
    group: 'marathon',
    tier: 3,
    check: (s) => {
      if (!s.longestSession) return false;
      const timeMs = s.longestSession.settings.assistantActiveTimeMs || 0;
      return timeMs >= 4 * 60 * 60 * 1000;
    },
  },
  {
    name: 'Focused Session',
    description: '2+ hour session',
    quip: "Could've watched Oppenheimer, chose to ship instead.",
    group: 'marathon',
    tier: 2,
    check: (s) => {
      if (!s.longestSession) return false;
      const timeMs = s.longestSession.settings.assistantActiveTimeMs || 0;
      return timeMs >= 2 * 60 * 60 * 1000;
    },
  },
  {
    name: 'Hour Block',
    description: '1+ hour session',
    quip: 'More productive than your last 3 standups.',
    group: 'marathon',
    tier: 1,
    check: (s) => {
      if (!s.longestSession) return false;
      const timeMs = s.longestSession.settings.assistantActiveTimeMs || 0;
      return timeMs >= 1 * 60 * 60 * 1000;
    },
  },

  {
    name: 'Night Owl',
    description: '35%+ sessions after 10pm',
    quip: 'The best code is written when everyone else is asleep.',
    check: (s) => {
      const nightHours =
        s.sessionsByHour.slice(22, 24).reduce((a, b) => a + b, 0) +
        s.sessionsByHour.slice(0, 4).reduce((a, b) => a + b, 0);
      const total = s.sessionsByHour.reduce((a, b) => a + b, 0);
      return total > 0 && nightHours / total >= 0.35;
    },
  },
  {
    name: 'Early Bird',
    description: '35%+ sessions before 9am',
    quip: 'Ship before standup, flex during standup.',
    check: (s) => {
      const earlyHours = s.sessionsByHour
        .slice(5, 9)
        .reduce((a, b) => a + b, 0);
      const total = s.sessionsByHour.reduce((a, b) => a + b, 0);
      return total > 0 && earlyHours / total >= 0.35;
    },
  },
  {
    name: 'Weekend Warrior',
    description: '30%+ sessions on weekends',
    quip: 'Side projects or just really behind on work?',
    check: (s) => {
      const weekend = s.sessionsByDayOfWeek[0] + s.sessionsByDayOfWeek[6];
      const total = s.sessionsByDayOfWeek.reduce((a, b) => a + b, 0);
      return total > 0 && weekend / total >= 0.3;
    },
  },

  {
    name: 'The DJ',
    description: 'Sounds enabled',
    quip: 'Completion sounds hit different at 2am.',
    check: (s) =>
      s.userSettings.soundsEnabled && !!s.userSettings.completionSound,
  },
  {
    name: 'Skill Collector',
    description: '10+ skills installed',
    quip: 'A skill for every occasion.',
    check: (s) => s.skills.length >= 10,
  },
  {
    name: 'Drool Builder',
    description: '3+ custom drools',
    quip: 'Why use defaults when you can customize everything?',
    check: (s) => s.drools.length >= 3,
  },
  {
    name: 'Hook Master',
    description: '2+ hooks enabled',
    quip: 'Automated the automation.',
    check: (s) => s.userSettings.hooksEnabled && s.userSettings.hookCount >= 2,
  },
  {
    name: 'BYOK Pioneer',
    description: 'Custom models configured',
    quip: 'Bringing your own keys to the party.',
    check: (s) => s.userConfig.customModels.length >= 1,
  },

  {
    name: 'The Polyglot',
    description: '4+ languages used',
    quip: 'Jack of all trades, master of... probably TypeScript.',
    check: (s) => s.languageUsage.size >= 4,
  },
  {
    name: 'Rustacean',
    description: '3+ Rust sessions',
    quip: 'Memory safety is not a phase, mom.',
    check: (s) => (s.languageUsage.get('Rust') || 0) >= 3,
  },
  {
    name: 'Gopher',
    description: '3+ Go sessions',
    quip: 'if err != nil { return err }',
    check: (s) => (s.languageUsage.get('Go') || 0) >= 3,
  },

  {
    name: 'Model Explorer',
    description: '4+ models used',
    quip: 'Testing all the models to find the one that agrees with you.',
    check: (s) => s.modelUsage.size >= 4,
  },

  {
    name: 'Early Adopter',
    description: 'Joined before October 2025',
    quip: 'You were here before it was cool.',
    check: (s) => {
      if (!s.firstSessionDate) return false;
      return s.firstSessionDate < new Date(2025, 9, 1);
    },
  },
];

export function generateBadges(stats: StatsData): Badge[] {
  const earned: Badge[] = [];
  const groupHighest = new Map<string, { tier: number; badge: Badge }>();

  for (const def of BADGE_DEFINITIONS) {
    try {
      if (!def.check(stats)) continue;

      const description =
        typeof def.description === 'function'
          ? def.description(stats)
          : def.description;
      const badge: Badge = { name: def.name, description, quip: def.quip };

      if (def.group && def.tier !== undefined) {
        const existing = groupHighest.get(def.group);
        if (!existing || def.tier > existing.tier) {
          groupHighest.set(def.group, { tier: def.tier, badge });
        }
      } else {
        earned.push(badge);
      }
    } catch (error) {
      logWarn('[userStats] badge evaluation failed', {
        name: def.name,
        cause: error,
      });
    }
  }

  for (const { badge } of groupHighest.values()) {
    earned.push(badge);
  }

  const tieredBadges = earned.filter(
    (b) => BADGE_DEFINITIONS.find((d) => d.name === b.name)?.tier !== undefined
  );
  const otherBadges = earned.filter(
    (b) => BADGE_DEFINITIONS.find((d) => d.name === b.name)?.tier === undefined
  );

  return [...tieredBadges, ...otherBadges].slice(0, 6);
}
