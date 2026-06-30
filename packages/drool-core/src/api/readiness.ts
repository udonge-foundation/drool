import { logWarn } from '@industry/logging';
import { normalizeRepoUrl } from '@industry/utils/agentReadiness';

import { getIndustryApiConfig } from './config';
import { fetch } from './fetch';

import type { FetchPreviousReadinessReportResult } from './types';
import type { IndustryAgentReadinessReport } from '@industry/common/agentReadiness/types';

/**
 * Strip userinfo (e.g. tokens, scrubbed credentials) from URLs before normalizing.
 */
function stripUserInfo(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/, '$1');
}

/** Number of reports to fetch per API request when paginating */
const PREVIOUS_REPORT_FETCH_PAGE_SIZE = 100;
/** Maximum number of reports to search through when looking for a matching repo */
const PREVIOUS_REPORT_MAX_SEARCH_DEPTH = 1000;

/**
 * Result-typed variant that distinguishes transient failure (network,
 * auth, 5xx) from "search completed and no matching report exists". Used
 * by the readiness-hint subsystem so it can cache the latter without
 * silencing the no-report nudge after a flaky network round-trip.
 */
export async function fetchPreviousReadinessReportResult(
  repoUrl: string
): Promise<FetchPreviousReadinessReportResult> {
  try {
    const globalConfig = getIndustryApiConfig();
    const normalizedRepoUrl = normalizeRepoUrl(stripUserInfo(repoUrl));

    // Skip fetching if no auth is configured (e.g., in test scripts)
    if (!globalConfig?.getHeaders || !normalizedRepoUrl) {
      return { ok: false };
    }

    let startAfter: string | undefined;
    let totalChecked = 0;

    // Sequential pagination is intentional - we stop as soon as we find a match
    while (totalChecked < PREVIOUS_REPORT_MAX_SEARCH_DEPTH) {
      const params = new URLSearchParams({
        limit: String(PREVIOUS_REPORT_FETCH_PAGE_SIZE),
        repoUrl: normalizedRepoUrl,
      });
      if (startAfter) {
        params.set('startAfter', startAfter);
      }
      const url = `/api/organization/agent-readiness-reports?${params.toString()}`;

      const response = await fetch(
        url,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        globalConfig
      );

      const { reports, nextStartAfter } = (await response.json()) as {
        reports: IndustryAgentReadinessReport[];
        nextStartAfter?: string;
      };

      if (reports.length === 0 && !nextStartAfter) break;

      // Find matching report for this repo (reports are ordered by createdAt desc)
      const matchingReport = reports.find(
        (r) =>
          normalizeRepoUrl(stripUserInfo(r.repoUrl || '')) === normalizedRepoUrl
      );

      if (matchingReport) return { ok: true, report: matchingReport };

      totalChecked += nextStartAfter
        ? PREVIOUS_REPORT_FETCH_PAGE_SIZE
        : reports.length;
      startAfter = nextStartAfter;

      if (!startAfter) break;
    }

    return { ok: true, report: null };
  } catch (error) {
    logWarn('Failed to fetch previous readiness report', {
      error,
      repoUrl: stripUserInfo(repoUrl),
    });
    return { ok: false, error };
  }
}

/**
 * Legacy variant that collapses transient failures and "no report found"
 * to `null`. Prefer `fetchPreviousReadinessReportResult` in new code.
 */
export async function fetchPreviousReadinessReport(
  repoUrl: string
): Promise<IndustryAgentReadinessReport | null> {
  const result = await fetchPreviousReadinessReportResult(repoUrl);
  if (result.ok) return result.report;
  return null;
}
