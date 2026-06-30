import fs from 'fs/promises';
import path from 'path';

import { sanitizePathToDirectoryName } from '@industry/utils/sessionPaths';

import { getUserIndustryDir } from '@/utils/industryPaths';

import type { TokenUsage } from '@industry/common/session/settings';

const EMPTY_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  thinkingTokens: 0,
  industryCredits: 0,
};

function getSessionsDir(cwd?: string): string {
  const base = path.join(getUserIndustryDir(), 'sessions');
  if (!cwd) {
    return base;
  }

  return path.join(base, sanitizePathToDirectoryName(cwd));
}

async function readSettingsTokenUsage(
  settingsPath: string
): Promise<TokenUsage | null> {
  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(content) as {
      inclusiveTokenUsage?: TokenUsage;
      tokenUsage?: TokenUsage;
    };
    const usage = parsed.inclusiveTokenUsage ?? parsed.tokenUsage;
    if (!usage) {
      return null;
    }
    return {
      ...EMPTY_TOKEN_USAGE,
      ...usage,
    };
  } catch {
    return null;
  }
}

async function readSessionTokenUsage(
  sessionId: string,
  cwdCandidates: Array<string | undefined>
): Promise<TokenUsage> {
  const fileName = `${sessionId}.settings.json`;

  for (const cwd of cwdCandidates) {
    const settingsPath = path.join(getSessionsDir(cwd), fileName);
    const usage = await readSettingsTokenUsage(settingsPath);
    if (usage) {
      return usage;
    }
  }

  return { ...EMPTY_TOKEN_USAGE };
}

export async function getMissionTokenUsageBySession(params: {
  sessionIds: string[];
  cwd?: string;
  /** Additional cwd candidates to try when looking up session settings files. */
  fallbackCwds?: Array<string | undefined>;
}): Promise<Record<string, TokenUsage>> {
  const uniqueIds = Array.from(
    new Set(params.sessionIds.filter((id) => id.trim().length > 0))
  );
  if (uniqueIds.length === 0) {
    return {};
  }

  // Build a deduplicated list of cwd candidates to search through.
  const cwdCandidates: Array<string | undefined> = [params.cwd];
  if (params.fallbackCwds) {
    for (const c of params.fallbackCwds) {
      if (!cwdCandidates.includes(c)) {
        cwdCandidates.push(c);
      }
    }
  }

  const usages = await Promise.all(
    uniqueIds.map((sessionId) =>
      readSessionTokenUsage(sessionId, cwdCandidates)
    )
  );

  return uniqueIds.reduce<Record<string, TokenUsage>>((acc, sessionId, idx) => {
    acc[sessionId] = usages[idx];
    return acc;
  }, {});
}
