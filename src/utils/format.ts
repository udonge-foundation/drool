import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';

import { getI18n } from '@/i18n/index';

// Helper function to format the autonomy level display name
export function formatAutonomyLevelName(level: AutonomyMode): string {
  const t = getI18n().t.bind(getI18n());

  switch (level) {
    case AutonomyMode.AutoLow:
      return t('commands:format.autonomyLow');
    case AutonomyMode.AutoMedium:
      return t('commands:format.autonomyMedium');
    case AutonomyMode.AutoHigh:
      return t('commands:format.autonomyHigh');
    default:
      return t('commands:format.autonomyLowFallback'); // fallback
  }
}

export function formatDurationCompact(durationMs: number): string {
  const t = getI18n().t.bind(getI18n());

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return t('commands:format.durationZero');
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0
      ? t('commands:format.durationHoursMinutes', { hours, minutes })
      : t('commands:format.durationHours', { hours });
  }

  if (minutes > 0) {
    return seconds > 0
      ? t('commands:format.durationMinutesSeconds', { minutes, seconds })
      : t('commands:format.durationMinutes', { minutes });
  }

  return t('commands:format.durationSeconds', { seconds });
}
