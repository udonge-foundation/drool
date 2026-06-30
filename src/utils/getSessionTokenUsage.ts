import { logWarn } from '@industry/logging';

import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';

import type { TokenUsage } from '@industry/common/session/settings';

const EMPTY_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  thinkingTokens: 0,
  industryCredits: 0,
};

function normalizeTokenUsage(usage?: Partial<TokenUsage> | null): TokenUsage {
  return {
    ...EMPTY_TOKEN_USAGE,
    ...(usage ?? {}),
    industryCredits: usage?.industryCredits ?? 0,
  };
}

/**
 * Read token usage from the SSM SessionStore for the current session.
 */
export function getSessionTokenUsage(): TokenUsage {
  const sessionService = getSessionService();
  const sessionId = sessionService.getCurrentSessionId();
  if (!sessionId) return normalizeTokenUsage(sessionService.getTokenUsage());

  try {
    const adapter = getTuiDaemonAdapter();
    const ssm = adapter.getSessionStateManager();
    const mgr = ssm.getSessionManager(sessionId);
    if (mgr) {
      const tokenUsage = mgr.getStore().getTokenUsage();
      if (tokenUsage) return normalizeTokenUsage(tokenUsage);
    }
  } catch (error) {
    logWarn(
      '[getSessionTokenUsage] Failed to get token usage from session store:',
      { error }
    );
  }

  return normalizeTokenUsage(sessionService.getTokenUsage());
}
