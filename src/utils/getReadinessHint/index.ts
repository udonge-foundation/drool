import { exec } from 'child_process';
import { promisify } from 'util';

import { READINESS_CRITERIA } from '@industry/common/agentReadiness/constants';
import { ReadinessLevel } from '@industry/common/agentReadiness/enums';
import { fetchPreviousReadinessReportResult } from '@industry/drool-core/api/readiness';
import { logWarn } from '@industry/logging';
import {
  CriterionStatus,
  getCriterionStatus,
  sanitizeGitRemoteUrl,
} from '@industry/utils/agentReadiness';
import { findGitRoot } from '@industry/utils/shell/node';

import { L1_HINT_COPY } from '@/utils/getReadinessHint/constants';
import {
  getCachedHintState,
  markGapHintShown,
  markNoReportHintShown,
  persistPrimeResult,
  wasPrimeResultRefreshedAfter,
  wasNoReportHintShown,
} from '@/utils/getReadinessHint/shownCache';
import type {
  CachedReadinessHintState,
  GapReadinessHint,
  ReadinessHint,
} from '@/utils/getReadinessHint/types';

import type { IndustryAgentReadinessReport } from '@industry/common/agentReadiness/types';

const execAsync = promisify(exec);

const GIT_REMOTE_TIMEOUT_MS = 2000;
const READINESS_HINT_PRIME_TTL_MS = 5 * 60 * 1000;

/** Resolves `origin` via `git remote get-url`; async, only used on the prime path. */
async function getOriginRemoteUrl(gitRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: gitRoot,
      timeout: GIT_REMOTE_TIMEOUT_MS,
    });
    const sanitized = sanitizeGitRemoteUrl(stdout.trim());
    return sanitized || null;
  } catch {
    return null;
  }
}

/** L1 criteria that are Failed and have hardcoded hint copy, in canonical order. */
function getFailingL1CriterionIds(
  reportSignals: IndustryAgentReadinessReport['report']
): string[] {
  return READINESS_CRITERIA.filter((criterion) => {
    if (criterion.level !== ReadinessLevel.Level1) return false;
    if (L1_HINT_COPY[criterion.id as keyof typeof L1_HINT_COPY] === undefined)
      return false;
    const evaluation = reportSignals[criterion.id];
    if (!evaluation) return false;
    return getCriterionStatus(evaluation) === CriterionStatus.Failed;
  }).map((c) => c.id);
}

/** Picks an unseen failing L1 from the disk cache, or `null` when no unseen gaps remain. */
function pickUnseenGapHint(
  gitRoot: string,
  cache: CachedReadinessHintState | null
): GapReadinessHint | null {
  const cached = cache?.lastSeenGaps;
  if (!cached || cached.length === 0) return null;
  const unseen = cached.filter((id) => cache.gapsShown[id] === undefined);
  if (unseen.length === 0) return null;
  const picked = unseen[Math.floor(Math.random() * unseen.length)];
  return { kind: 'gap', gitRoot, criterionId: picked };
}

/**
 * Synchronous readiness-aware hint for Ink's `<Static>` Header, which paints
 * once and discards later updates. Precedence: gap hint → no-report nudge →
 * `null`. Top-level try/catch so failures degrade to "no hint".
 */
export function getReadinessHintSync(): ReadinessHint | null {
  try {
    const gitRoot = findGitRoot(process.cwd());
    if (!gitRoot) return null;
    const cache = getCachedHintState(gitRoot);
    const gapHint = pickUnseenGapHint(gitRoot, cache);
    if (gapHint !== null) return gapHint;
    if (cache?.hasPreviousReport === true) return null;
    if (wasNoReportHintShown(gitRoot)) return null;
    return { kind: 'no-report', gitRoot };
  } catch (error) {
    logWarn('getReadinessHintSync failed; falling back to no hint', { error });
    return null;
  }
}

/**
 * Records that a hint was surfaced (per-criterion for gaps, once for
 * no-report). Persisted to `~/.industry/cli-hints.json`; top-level try/catch
 * so disk failures can't crash Header's mount effect.
 */
export function markReadinessHintAsShown(hint: ReadinessHint): void {
  try {
    if (hint.kind === 'no-report') {
      markNoReportHintShown(hint.gitRoot);
    } else {
      markGapHintShown(hint.gitRoot, hint.criterionId);
    }
  } catch (error) {
    logWarn('markReadinessHintAsShown failed to persist suppression marker', {
      error,
    });
  }
}

/**
 * Async startup prime: fetches the most recent readiness report and persists
 * failing L1 IDs so the NEXT cold-start can surface a gap hint synchronously.
 * Best-effort; never throws, never blocks startup.
 */
export async function primeReadinessHint(): Promise<void> {
  try {
    const gitRoot = findGitRoot(process.cwd());
    if (!gitRoot) return;
    if (
      wasPrimeResultRefreshedAfter(
        gitRoot,
        Date.now() - READINESS_HINT_PRIME_TTL_MS
      )
    ) {
      return;
    }

    const repoUrl = await getOriginRemoteUrl(gitRoot);
    if (!repoUrl) return;

    const result = await fetchPreviousReadinessReportResult(repoUrl);
    if (!result.ok) return;

    const report = result.report;
    const hasPreviousReport = report !== null;
    const failingL1 =
      report === null ? [] : getFailingL1CriterionIds(report.report);
    persistPrimeResult(gitRoot, failingL1, hasPreviousReport);
  } catch (error) {
    logWarn('primeReadinessHint failed', { error });
  }
}
