import {
  ConnectionFailureError,
  ConnectionFailureReason,
} from '@industry/daemon-client/session';
import { EnvironmentVariable } from '@industry/environment';

import { getI18n } from '@/i18n';
import { expiredLoginMessage, invalidApiKeyMessage } from '@/i18n/authMessages';

function appMessage(key: string, fallback: string): string {
  return getI18n().t(`common:appMessages.${key}`) || fallback;
}

export function getSessionCreationErrorMessage(error: unknown): string {
  if (!(error instanceof ConnectionFailureError)) {
    return appMessage(
      'sessionCreationFailedUnknown',
      'Failed to create session. Check the logs for details.'
    );
  }

  switch (error.reason) {
    case ConnectionFailureReason.NoToken:
      return appMessage(
        'noToken',
        'Not authenticated. Please log in using /provider or configure a provider.'
      );
    case ConnectionFailureReason.AuthRejected: {
      const hasApiKey = !!process.env[EnvironmentVariable.INDUSTRY_API_KEY];
      return hasApiKey ? invalidApiKeyMessage() : expiredLoginMessage();
    }
    case ConnectionFailureReason.DaemonUnreachable:
    case ConnectionFailureReason.DaemonTimeout:
      return appMessage(
        'daemonUnavailable',
        'Could not reach the daemon. It may still be starting; try again in a moment.'
      );
    default:
      return appMessage(
        'sessionCreationFailedUnknown',
        'Failed to create session. Check the logs for details.'
      );
  }
}
