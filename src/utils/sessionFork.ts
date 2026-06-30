import { getI18n } from '@/i18n';
import { getSessionService } from '@/services/SessionService';

export function getForkSessionTitle(sourceSessionId: string): string {
  const sessionService = getSessionService();
  const originalTitle = sessionService.getSessionTitle(sourceSessionId);
  const baseTitle =
    originalTitle && originalTitle.trim().length > 0
      ? originalTitle.trim()
      : getI18n().t('common:appMessages.sessionFallback');
  return getI18n()
    .t('common:appMessages.forkPrefix', {
      title: baseTitle,
    })
    .trim();
}
