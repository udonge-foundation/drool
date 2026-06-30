import { getI18n } from '@/i18n';

/**
 * Format a Date (or ISO timestamp string) as a relative time string
 * using i18n translation keys (e.g., "3m ago", "2h ago", "5d ago").
 *
 * For dates older than 7 days, returns a formatted short date.
 * If `date` is null, returns the translation for "no date".
 */
export function formatRelativeTime(date: Date | string | null): string {
  const t = getI18n().t.bind(getI18n());

  if (!date) return t('common:missions.noDate');

  const dateObj = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('common:time.justNow');
  if (diffMins < 60) return t('common:time.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('common:time.hoursAgo', { count: diffHours });
  if (diffDays > 7) {
    const locale = getI18n().language;
    return dateObj.toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
    });
  }
  return t('common:time.daysAgo', { count: diffDays });
}
