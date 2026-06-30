import { Chronotype } from './enums';

export function getMostActiveDay(
  sessionsPerDay: Map<number, number>
): { date: Date; count: number } | null {
  let maxDayMs: number | null = null;
  let maxCount = 0;

  for (const [dayMs, count] of sessionsPerDay) {
    if (count > maxCount) {
      maxCount = count;
      maxDayMs = dayMs;
    }
  }

  return maxDayMs !== null
    ? { date: new Date(maxDayMs), count: maxCount }
    : null;
}

export function getAvgSessionsPerDay(
  sessionsPerDay: Map<number, number>
): number {
  if (sessionsPerDay.size === 0) return 0;
  const total = Array.from(sessionsPerDay.values()).reduce((a, b) => a + b, 0);
  return total / sessionsPerDay.size;
}

export function getMostActiveTimeOfDay(sessionsByHour: number[]): Chronotype {
  const morning = sessionsByHour.slice(6, 12).reduce((a, b) => a + b, 0);
  const afternoon = sessionsByHour.slice(12, 18).reduce((a, b) => a + b, 0);
  const evening = sessionsByHour.slice(18, 24).reduce((a, b) => a + b, 0);
  const night = sessionsByHour.slice(0, 6).reduce((a, b) => a + b, 0);

  const max = Math.max(morning, afternoon, evening, night);
  if (max === evening) return Chronotype.NightOwl;
  if (max === morning) return Chronotype.EarlyBird;
  if (max === afternoon) return Chronotype.AfternoonCoder;
  return Chronotype.NightHacker;
}

export function getWeekendVsWeekday(sessionsByDayOfWeek: number[]): {
  weekend: number;
  weekday: number;
} {
  const weekend = sessionsByDayOfWeek[0] + sessionsByDayOfWeek[6];
  const weekday = sessionsByDayOfWeek.slice(1, 6).reduce((a, b) => a + b, 0);
  return { weekend, weekday };
}
