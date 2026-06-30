import type { CadenceChip, CronRecipe } from '@/services/crons/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const DAILY_MORNING_CRON_EXPRESSION = '0 9 * * *';

export const DEFAULT_CADENCE_CHIPS: readonly CadenceChip[] = [
  { label: '1m', intervalMs: 1 * MINUTE_MS },
  { label: '5m', intervalMs: 5 * MINUTE_MS },
  { label: '10m', intervalMs: 10 * MINUTE_MS },
  { label: '15m', intervalMs: 15 * MINUTE_MS },
  { label: '30m', intervalMs: 30 * MINUTE_MS },
  { label: '1h', intervalMs: HOUR_MS },
  { label: '2h', intervalMs: 2 * HOUR_MS },
  { label: '6h', intervalMs: 6 * HOUR_MS },
  { label: '12h', intervalMs: 12 * HOUR_MS },
  { label: 'daily', intervalMs: 24 * HOUR_MS },
  { label: 'custom', intervalMs: null },
];

export const SESSION_LOOP_RECIPES: readonly CronRecipe[] = [
  {
    id: 'git-recap-30m',
    label: 'every 30m → summarize git changes',
    intervalMs: 30 * MINUTE_MS,
    prompt: 'Summarize the git changes from the last 30 minutes in 1-3 lines.',
  },
  {
    id: 'ci-watch-15m',
    label: 'every 15m → check CI on current PR',
    intervalMs: 15 * MINUTE_MS,
    prompt:
      'Check CI on the current PR. If anything is failing, list the failing jobs in one line. Otherwise reply "CI green".',
  },
  {
    id: 'todo-pulse-1h',
    label: 'every 1h → list new TODO comments',
    intervalMs: HOUR_MS,
    prompt:
      'List any TODO or FIXME comments added in the last hour, with file path and line number. Reply "none" if there are no new ones.',
  },
  {
    id: 'daily-progress-summary',
    label: 'daily → summarize progress and remaining work',
    intervalMs: 24 * HOUR_MS,
    prompt:
      'Summarize progress made in this repository today and list the most important remaining work.',
  },
];
