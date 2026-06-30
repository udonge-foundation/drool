/**
 * Agent Readiness - Shared Utility Functions
 *
 * This file contains utility functions for agent readiness calculations
 * shared across backend and frontend packages.
 */

import {
  READINESS_CRITERIA,
  READINESS_LEVELS,
} from '@industry/common/agentReadiness/constants';
import {
  MissionReadinessGateState,
  ReadinessLevel,
} from '@industry/common/agentReadiness/enums';
import { logWarn } from '@industry/logging';

import { CriterionStatus } from './enums';

import type { MissionRepoInspection, MissionRepoInspectionDeps } from './types';
import type {
  IndustryAgentReadinessReport,
  LevelBreakdown,
  ReadinessCriterion,
  ReadinessOrganizationLevel,
  SignalEvaluation,
  ReadinessScoreResult,
} from '@industry/common/agentReadiness/types';

// -----------------------------------------------------------------------------
// Readiness Score Calculation (moved from @industry/common)
// -----------------------------------------------------------------------------

/**
 * Returns the pass ratio (numerator / denominator) for an evaluation, or
 * `null` if the evaluation is missing, skipped (numerator === null), or has
 * a non-positive denominator. Centralizes the "does this signal contribute
 * to a pass-rate calculation?" check used by readiness score / category
 * percentage logic.
 */
export function getEvaluationRatio(
  evaluation: SignalEvaluation | undefined
): number | null {
  if (
    !evaluation ||
    evaluation.numerator === null ||
    evaluation.denominator <= 0
  ) {
    return null;
  }
  return evaluation.numerator / evaluation.denominator;
}

function calculateLevelFromPercent(percentComplete: number): ReadinessLevel {
  if (percentComplete >= 80) return ReadinessLevel.Level5;
  if (percentComplete >= 60) return ReadinessLevel.Level4;
  if (percentComplete >= 40) return ReadinessLevel.Level3;
  if (percentComplete >= 20) return ReadinessLevel.Level2;
  return ReadinessLevel.Level1;
}

function getCriteriaForLevel(level: ReadinessLevel): ReadinessCriterion[] {
  return READINESS_CRITERIA.filter((c) => c.level === level);
}

function calculateReadinessScore(
  report: Record<string, SignalEvaluation>
): ReadinessScoreResult {
  const levelBreakdowns: LevelBreakdown[] = [];
  let totalRatioSum = 0;
  let totalSignalCount = 0;

  for (const levelDef of READINESS_LEVELS) {
    const criteria = getCriteriaForLevel(levelDef.level);

    let levelRatioSum = 0;
    let levelSignalCount = 0;

    for (const criterion of criteria) {
      const ratio = getEvaluationRatio(report[criterion.id]);
      if (ratio !== null) {
        levelRatioSum += ratio;
        levelSignalCount++;
      }
    }

    const percentComplete =
      levelSignalCount > 0 ? (levelRatioSum / levelSignalCount) * 100 : 0;

    levelBreakdowns.push({
      level: levelDef.level,
      checksPassed: Math.round(levelRatioSum * 100),
      checksTotal: levelSignalCount * 100,
      percentComplete,
      isUnlocked: true,
    });

    totalRatioSum += levelRatioSum;
    totalSignalCount += levelSignalCount;
  }

  const overallPercent =
    totalSignalCount > 0 ? (totalRatioSum / totalSignalCount) * 100 : 0;

  const achievedLevel = calculateLevelFromPercent(overallPercent);

  let checksNeededForNextLevel: number | null = null;
  const levelThresholds = [20, 40, 60, 80, 100];

  if (achievedLevel < ReadinessLevel.Level5 && totalSignalCount > 0) {
    const nextThreshold = levelThresholds[achievedLevel - 1];
    const currentPercent = (totalRatioSum / totalSignalCount) * 100;
    const percentNeeded = Math.max(0, nextThreshold - currentPercent);
    checksNeededForNextLevel = Math.ceil(
      (percentNeeded / 100) * totalSignalCount
    );
  }

  const criterionResults = READINESS_CRITERIA.map((criterion) => {
    const evaluation = report[criterion.id];

    const isMissing = !evaluation;
    const isSkipped = evaluation?.numerator === null;

    const passed = isMissing ? 0 : (evaluation.numerator ?? 0);
    const total = isMissing ? 1 : evaluation.denominator;

    return {
      criterionId: criterion.id,
      level: criterion.level,
      passed,
      total,
      isComplete: !isMissing && !isSkipped && passed === total,
      isSkipped,
    };
  });

  return {
    achievedLevel,
    overallProgress: {
      checksPassed: Math.round(totalRatioSum * 100),
      checksTotal: totalSignalCount * 100,
      percentComplete: overallPercent,
    },
    levelBreakdowns,
    checksNeededForNextLevel,
    criterionResults,
  };
}

// -----------------------------------------------------------------------------
// Functions for working with real API data (IndustryAgentReadinessReport)
// -----------------------------------------------------------------------------

/**
 * Get the status of a criterion based on its evaluation
 */
export function getCriterionStatus(
  evaluation: SignalEvaluation
): CriterionStatus {
  if (evaluation.numerator === null) return CriterionStatus.Skipped;
  if (
    evaluation.denominator > 0 &&
    evaluation.numerator === evaluation.denominator
  ) {
    return CriterionStatus.Passed;
  }
  return CriterionStatus.Failed;
}

/**
 * Strips credentials (username, password, tokens) from a git remote URL.
 * Only sanitizes HTTP/HTTPS URLs where embedded auth is a credential leak risk.
 * SSH URLs (both git@... and ssh://git@...) are returned as-is since their
 * userinfo is a functional SSH user, not a secret credential.
 */
export function sanitizeGitRemoteUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return trimmed;
    }
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return trimmed;
  } catch (err) {
    logWarn('Failed to parse URL for sanitization', { cause: err });
    return trimmed;
  }
}

/**
 * Normalizes a git repository URL to a canonical format for comparison/grouping.
 * Converts SSH URLs to HTTPS format, removes .git suffix, and lowercases for case-insensitive matching.
 * For file paths (non-URLs), extracts the last two path segments as org/repo.
 *
 * Examples:
 * - git@github.com:owner/repo.git -> https://github.com/owner/repo
 * - https://github.com/owner/repo.git -> https://github.com/owner/repo
 * - ssh://git@github.com/owner/repo.git -> https://github.com/owner/repo
 * - https://github.com/Owner/Repo -> https://github.com/owner/repo
 * - /Users/dev/projects/org/repo -> org/repo
 */
export function normalizeRepoUrl(url: string): string {
  if (!url) return '';

  let normalized = url.trim();

  // Handle SSH format: git@host:owner/repo.git
  const sshMatch = normalized.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    normalized = `https://${host}/${path}`;
  }

  // Handle ssh:// format: ssh://git@host/owner/repo.git
  const sshUrlMatch = normalized.match(
    /^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/i
  );
  if (sshUrlMatch) {
    const [, host, path] = sshUrlMatch;
    normalized = `https://${host}/${path}`;
  }

  // Check if this is a URL (http/https)
  const isUrl = /^https?:\/\//i.test(normalized);

  if (isUrl) {
    // Remove .git suffix from HTTPS URLs (case-insensitive)
    normalized = normalized.replace(/\.git$/i, '');

    // Remove trailing slashes
    normalized = normalized.replace(/\/+$/, '');

    // Lowercase for case-insensitive comparison
    return normalized.toLowerCase();
  }

  // Default: treat as file path, extract the last two segments as org/repo
  const parts = normalized.split('/').filter((p) => p.length > 0);
  if (parts.length >= 2) {
    const org = parts[parts.length - 2];
    let repo = parts[parts.length - 1];

    // Strip .git suffix if present
    if (repo.toLowerCase().endsWith('.git')) {
      repo = repo.slice(0, -4);
    }

    return `${org}/${repo}`.toLowerCase();
  }
  // Single segment - just return it lowercased
  if (parts.length === 1) {
    let repo = parts[0];
    if (repo.toLowerCase().endsWith('.git')) {
      repo = repo.slice(0, -4);
    }
    return repo.toLowerCase();
  }
  return '';
}

/**
 * Extract the owner/repo path from a repository URL for comparison.
 * Handles various formats: HTTPS, SSH, with/without .git suffix.
 * Returns lowercase for case-insensitive comparison.
 *
 * Examples:
 * - https://github.com/owner/repo.git -> owner/repo
 * - git@github.com:owner/repo.git -> owner/repo
 * - https://github.com/Owner/Repo -> owner/repo
 */
export function extractRepoPath(url: string): string {
  if (!url) return '';

  let path = url;

  // Handle SSH format (git@github.com:owner/repo.git)
  if (path.startsWith('git@')) {
    const sshMatch = path.match(/git@[^:]+:(.+)/);
    if (sshMatch) {
      path = sshMatch[1];
    }
  } else {
    // Handle HTTPS format - extract path after the host
    const httpsMatch = path.match(/https?:\/\/[^/]+\/(.+)/);
    if (httpsMatch) {
      path = httpsMatch[1];
    }
  }

  // Remove .git suffix if present (case-insensitive)
  path = path.replace(/\.git$/i, '');

  // Remove trailing slashes
  path = path.replace(/\/+$/, '');

  // Convert to lowercase for case-insensitive comparison
  return path.toLowerCase();
}

/**
 * Helper: Extract repository name from URL in org/repo format
 * Strips .git suffix if present
 */
function extractRepoName(url: string): string {
  if (!url) return '';

  // Strip query parameters and hash fragments
  const cleanUrl = url.split('?')[0].split('#')[0].trim();

  // Try to match GitHub URL pattern to extract org/repo
  const match = cleanUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (match && match[1] && match[2]) {
    const org = match[1];
    let repo = match[2].replace(/\/$/, ''); // Remove trailing slashes

    // Strip .git suffix if present
    if (repo.endsWith('.git')) {
      repo = repo.slice(0, -4);
    }

    return `${org}/${repo}`;
  }

  // If no match, try to get last two path segments
  const parts = cleanUrl.split('/').filter((p) => p.length > 0);
  if (parts.length >= 2) {
    const org = parts[parts.length - 2];
    let repo = parts[parts.length - 1];

    // Strip .git suffix if present
    if (repo.endsWith('.git')) {
      repo = repo.slice(0, -4);
    }

    return `${org}/${repo}`;
  }

  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Helper: Extract just the repository name (without org) from URL
 * Strips .git suffix if present
 */
export function extractRepoNameOnly(url: string): string {
  const fullName = extractRepoName(url);
  const parts = fullName.split('/');
  return parts.length > 1 ? parts[1] : fullName;
}

/**
 * Get the latest report for each repository (deduplicated by normalized URL)
 * Groups reports by normalized repository URL and returns only the most recent report for each repo.
 * This handles SSH vs HTTPS URL variants as the same repository.
 */
export function getLatestReportsByRepo(
  reports: IndustryAgentReadinessReport[]
): IndustryAgentReadinessReport[] {
  const repoMap = new Map<string, IndustryAgentReadinessReport>();

  for (const report of reports) {
    const repoUrl = report.repoUrl || '';
    if (!repoUrl) continue;

    // Use normalized URL as the deduplication key to handle SSH vs HTTPS variants
    const normalizedUrl = normalizeRepoUrl(repoUrl);
    if (!normalizedUrl) continue;

    const existing = repoMap.get(normalizedUrl);
    // Keep the report with the most recent createdAt timestamp
    if (!existing || report.createdAt > existing.createdAt) {
      repoMap.set(normalizedUrl, report);
    }
  }

  return Array.from(repoMap.values());
}

// -----------------------------------------------------------------------------
// Level-Based Scoring Functions
// -----------------------------------------------------------------------------

/**
 * Calculate level-based score for a single repository report
 */
export function calculateRepoLevel(
  report: IndustryAgentReadinessReport
): ReadinessScoreResult {
  return calculateReadinessScore(report.report);
}

/**
 * Calculate the repository's overall score as a percentage (0-100).
 * Score is calculated as the average of all measured signal ratios:
 * (ratio_of_signal_1 + ratio_of_signal_2 + ... + ratio_of_signal_n) / n
 *
 * Missing evaluations and skipped signals (numerator is null) are excluded.
 */
export function calculateRepoScore(
  report: IndustryAgentReadinessReport
): number {
  let totalRatio = 0;
  let countedCriteria = 0;

  for (const criterion of READINESS_CRITERIA) {
    // Only count signals that have evaluations (omit missing signals)
    // Skip if numerator is null (explicitly skipped/N/A)
    const ratio = getEvaluationRatio(report.report[criterion.id]);
    if (ratio !== null) {
      totalRatio += ratio;
      countedCriteria++;
    }
  }

  if (countedCriteria === 0) {
    return 0;
  }

  // Return the average as a percentage (0-100)
  return (totalRatio / countedCriteria) * 100;
}

/**
 * Calculate the repository's level (1-6) based on its score percentage.
 * Level 1 = 0-20%, Level 2 = 20-40%, Level 3 = 40-60%,
 * Level 4 = 60-80%, Level 5 = 80-100%, Level 6 = 100%
 */
export function calculateRepoLevelFromScore(scorePercent: number): number {
  if (scorePercent >= 100) return 6;
  if (scorePercent >= 80) return 5;
  if (scorePercent >= 60) return 4;
  if (scorePercent >= 40) return 3;
  if (scorePercent >= 20) return 2;
  return 1;
}

/**
 * Calculate aggregate level for the organization from the latest reports of each repo
 * Organization level is the average of all repo levels (rounded down)
 */
export function calculateOrgLevel(
  reports: IndustryAgentReadinessReport[]
): ReadinessOrganizationLevel {
  if (reports.length === 0) {
    return {
      achievedLevel: ReadinessLevel.Level1,
      checksPassedTowardNext: null,
      checksNeededForNextLevel: null,
      totalChecksPassed: 0,
      totalChecksTotal: 0,
      percentComplete: 0,
    };
  }

  // Calculate level for each repo
  const repoLevels = reports.map((report) => calculateRepoLevel(report));

  // Calculate average level (rounded down)
  const totalLevel = repoLevels.reduce(
    (sum, level) => sum + level.achievedLevel,
    0
  );
  const avgLevel = Math.floor(totalLevel / repoLevels.length);
  const orgLevel = Math.max(
    ReadinessLevel.Level1,
    Math.min(ReadinessLevel.Level5, avgLevel as ReadinessLevel)
  );

  // Sum up total checks across all repos
  const totalChecksPassed = repoLevels.reduce(
    (sum, r) => sum + r.overallProgress.checksPassed,
    0
  );
  const totalChecksTotal = repoLevels.reduce(
    (sum, r) => sum + r.overallProgress.checksTotal,
    0
  );

  // Calculate progress toward next level
  let checksPassedTowardNext: number | null = null;
  let checksNeededForNextLevel: number | null = null;

  const nextLevel = (orgLevel + 1) as ReadinessLevel;
  if (nextLevel <= ReadinessLevel.Level5) {
    // Count how many repos are at or above the next level
    const reposAtOrAboveNextLevel = repoLevels.filter(
      (r) => r.achievedLevel >= nextLevel
    ).length;

    checksPassedTowardNext = reposAtOrAboveNextLevel;
    checksNeededForNextLevel = repoLevels.length - reposAtOrAboveNextLevel;
  }

  return {
    achievedLevel: orgLevel,
    checksPassedTowardNext,
    checksNeededForNextLevel,
    totalChecksPassed,
    totalChecksTotal,
    percentComplete:
      totalChecksTotal > 0 ? (totalChecksPassed / totalChecksTotal) * 100 : 0,
  };
}

/**
 * Get level label based on level number (1-4)
 * Returns "Basic" for levels 1-2, "Intermediate" for level 3, "Advanced" for level 4+
 * @param level - The level number (1-4)
 * @param uppercase - Whether to return uppercase (default: false)
 */
export function getLevelLabel(level: number, uppercase = false): string {
  let label: string;
  if (level <= 2) {
    label = 'Basic';
  } else if (level === 3) {
    label = 'Intermediate';
  } else {
    label = 'Advanced';
  }
  return uppercase ? label.toUpperCase() : label;
}

/**
 * Format timestamp to relative time string
 */
export function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSeconds < 60) {
    return diffSeconds === 1 ? '1 second ago' : `${diffSeconds} seconds ago`;
  }
  if (diffMinutes < 60) {
    return diffMinutes === 1 ? '1 minute ago' : `${diffMinutes} minutes ago`;
  }
  if (diffHours < 24) {
    return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
  }
  if (diffDays < 7) {
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
  }
  if (diffWeeks < 4) {
    return diffWeeks === 1 ? '1 week ago' : `${diffWeeks} weeks ago`;
  }
  if (diffMonths < 12) {
    return diffMonths === 1 ? '1 month ago' : `${diffMonths} months ago`;
  }
  return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
}

/**
 * Calculate organization-level progress over time from reports
 * Groups reports by day and calculates the mean organization level (as float between 1.0-4.0)
 */
export function calculateProgressOverTime(
  reports: Array<{
    createdAt: number;
    levelResult: {
      achievedLevel: number;
      overallProgress: { percentComplete: number };
    };
  }>
): Array<{
  timestamp: number;
  level: number;
  progress: number;
  dateLabel: string;
}> {
  if (reports.length === 0) {
    return [];
  }

  // Sort reports by timestamp
  const sortedReports = [...reports].sort((a, b) => a.createdAt - b.createdAt);

  // Group reports by day and get the latest report for each repo on that day
  const dataPointsMap = new Map<
    string,
    { timestamp: number; repoLevels: Map<string, number>; progresses: number[] }
  >();

  sortedReports.forEach((report) => {
    const date = new Date(report.createdAt);
    const dayKey = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

    if (!dataPointsMap.has(dayKey)) {
      dataPointsMap.set(dayKey, {
        timestamp: report.createdAt,
        repoLevels: new Map(),
        progresses: [],
      });
    }

    const dataPoint = dataPointsMap.get(dayKey)!;
    // Use report ID or some identifier as key - for now using timestamp as unique key
    const repoKey = `${report.createdAt}`;
    dataPoint.repoLevels.set(repoKey, report.levelResult.achievedLevel);
    dataPoint.progresses.push(
      report.levelResult.overallProgress.percentComplete
    );
  });

  // Calculate mean level (as continuous float) and progress for each day
  const dataPoints = Array.from(dataPointsMap.values()).map((point) => {
    const levels = Array.from(point.repoLevels.values());
    const meanLevel =
      levels.reduce((sum, level) => sum + level, 0) / levels.length;
    const avgProgress = Math.round(
      point.progresses.reduce((sum, progress) => sum + progress, 0) /
        point.progresses.length
    );

    return {
      timestamp: point.timestamp,
      level: meanLevel, // Continuous float value between 1.0 and 4.0
      progress: avgProgress,
      dateLabel: formatTimeAgo(point.timestamp),
    };
  });

  return dataPoints;
}

// -----------------------------------------------------------------------------
// Signal Remediation Prompt
// -----------------------------------------------------------------------------

/**
 * Build the remediation prompt for fixing a failing agent readiness signal.
 * This prompt is used both for cloud workspace sessions and local CLI usage.
 */
export function buildSignalRemediationPrompt(
  repoName: string,
  score: string,
  rationale: string,
  criterionName: string,
  criterionDescription: string,
  criterionInstructions: string
): string {
  return `[Readiness Fix] ${repoName} ${criterionName}

Fix the failing signal: ${criterionName} (${score})

<system-reminder>
You are fixing an Agent Readiness signal. Agent Readiness evaluates how well a repository supports autonomous AI agents working on the codebase.

## Failing Signal

**Signal**: ${criterionName}
**Score**: ${score}
**Description**: ${criterionDescription}
**Why it failed**: ${rationale}

## Original Signal Evaluation Criteria

The agent readiness report evaluated this signal using these instructions:

${criterionInstructions}

## Your Task

1. Explore the repository to understand the current state related to this signal
2. Make **substantive improvements** to the codebase that genuinely address the signal
3. Verify your fix addresses the issue (e.g., run linter if fixing lint_config, run tests if adding tests)
4. Keep changes focused on this signal - don't refactor unrelated code
5. When done with code changes, open a PULL REQUEST with the changes and return the PR URL

## CRITICAL: Quality Standards

Your fix must **genuinely improve the codebase**. Do NOT use workarounds or shortcuts:

- **NO** empty placeholder files (e.g., empty test files, stub configs)
- **NO** minimal implementations that technically pass but provide no real value
- **NO** disabling checks or adding skip markers to pass validation
- **NO** trivial changes that game the metric without improving quality

Examples of BAD fixes:
- Adding an empty \`test.js\` file to satisfy "has tests" criterion
- Creating a \`.eslintrc\` that disables all rules
- Adding \`// @ts-nocheck\` to satisfy TypeScript requirements

Examples of GOOD fixes:
- Writing actual unit tests with meaningful assertions for existing code
- Configuring ESLint with appropriate rules for the project's language/framework
- Adding proper TypeScript types to improve type safety

## Completion

- IMPORTANT: When finishing work and you made code changes, open a PULL REQUEST with the changes and return the PR URL
- Provide a succinct summary of what you changed and why it genuinely improves the codebase
</system-reminder>`;
}

// -----------------------------------------------------------------------------
// Mission Readiness Gate
// -----------------------------------------------------------------------------

/** Minimum agent readiness level required to run a Mission without a warning. */
const MISSION_READINESS_MIN_LEVEL = 4;

/**
 * Decide whether a Mission should be gated behind a readiness warning.
 * `level` is the repository's agent readiness level (1-5) or undefined when no
 * report exists.
 */
export function evaluateMissionReadinessGate(
  inspection: MissionRepoInspection,
  level: ReadinessLevel | undefined
): MissionReadinessGateState {
  // Empty / new directories cannot be evaluated and should never be gated,
  // regardless of git or remote state.
  if (inspection.isEmpty) {
    return MissionReadinessGateState.Ok;
  }

  if (!inspection.isGitRepo) {
    return MissionReadinessGateState.NoGit;
  }

  if (!inspection.hasRemote || !inspection.repoUrl) {
    return MissionReadinessGateState.NoRemote;
  }

  if (level === undefined) {
    return MissionReadinessGateState.NoReport;
  }

  return level >= MISSION_READINESS_MIN_LEVEL
    ? MissionReadinessGateState.Ok
    : MissionReadinessGateState.LowScore;
}

/**
 * Inspect a working directory's git state for the mission readiness gate:
 * whether it is inside a git work tree, its sanitized origin remote URL, and
 * whether it is empty (ignoring the `.git` folder). A failed directory read
 * degrades to "not empty" so detection problems never look like an empty repo.
 */
export async function inspectMissionRepo(
  dir: string,
  deps: MissionRepoInspectionDeps
): Promise<MissionRepoInspection> {
  const insideWorkTree = await deps.runGitCommand(
    ['rev-parse', '--is-inside-work-tree'],
    dir
  );
  const isGitRepo = insideWorkTree === 'true';

  let repoUrl: string | undefined;
  // Emptiness must be measured at the repository root, not the selected cwd, so
  // an empty subdirectory inside a populated repo is not mistaken for empty.
  let emptinessDir = dir;
  if (isGitRepo) {
    const rawRemote = await deps.runGitCommand(
      ['remote', 'get-url', 'origin'],
      dir
    );
    const sanitized = rawRemote ? sanitizeGitRemoteUrl(rawRemote) : '';
    repoUrl = sanitized || undefined;

    const topLevel = await deps.runGitCommand(
      ['rev-parse', '--show-toplevel'],
      dir
    );
    if (topLevel) {
      emptinessDir = topLevel;
    }
  }

  let isEmpty = false;
  try {
    const entries = await deps.readDirectory(emptinessDir);
    isEmpty = entries.filter((entry) => entry !== '.git').length === 0;
  } catch (error) {
    logWarn('[agentReadiness] Failed to read working directory', {
      cause: error,
    });
  }

  return {
    isGitRepo,
    hasRemote: repoUrl !== undefined,
    isEmpty,
    repoUrl,
  };
}

/** Whether the gate state should offer a "Run agent readiness report" action. */
export function missionGateOffersReport(
  state: MissionReadinessGateState
): boolean {
  return state === MissionReadinessGateState.NoReport;
}

/** Whether the gate state should offer a "Fix agent readiness report" action. */
export function missionGateOffersFix(
  state: MissionReadinessGateState
): boolean {
  return state === MissionReadinessGateState.LowScore;
}

/**
 * Build the user-facing warning body for a non-Ok gate state. Returns an empty
 * string for `Ok`. `level` is interpolated for the low-score state.
 */
export function getMissionReadinessWarning(
  state: MissionReadinessGateState,
  level?: ReadinessLevel
): string {
  switch (state) {
    case MissionReadinessGateState.LowScore:
      return `You are about to run a Mission on a repository that is not yet agent-ready enough for this. Your current score is a ${level ?? 0}/5. Missions can only run effectively when there are strong validation capabilities built into the project. By proceeding, you are claiming that these capabilities exist or taking the risk that the Mission will correctly infer how to QA your application.`;
    case MissionReadinessGateState.NoReport:
      return `You are about to run a Mission on a repository that has no agent readiness report yet, so we cannot confirm it is agent-ready enough for this. Missions can only run effectively when there are strong validation capabilities built into the project. By proceeding, you are claiming that these capabilities exist or taking the risk that the Mission will correctly infer how to QA your application.`;
    case MissionReadinessGateState.NoRemote:
      return `You are about to run a Mission on a git repository that has no remote configured, so we cannot evaluate its agent readiness. Missions can only run effectively when there are strong validation capabilities built into the project. By proceeding, you are claiming that these capabilities exist or taking the risk that the Mission will correctly infer how to QA your application.`;
    case MissionReadinessGateState.NoGit:
      return `You are about to run a Mission on a folder that is not a git repository, so we cannot evaluate its agent readiness. Missions can only run effectively when there are strong validation capabilities built into the project. By proceeding, you are claiming that these capabilities exist or taking the risk that the Mission will correctly infer how to QA your application.`;
    case MissionReadinessGateState.Ok:
    default:
      return '';
  }
}

/**
 * Build clone preamble instructions for computer-based sessions.
 * Instructs the agent to check for an existing clone under ~ before
 * cloning into /tmp/industry-readiness/ as a temporary staging area.
 */
export function buildClonePreamble(repoUrl: string, repoName: string): string {
  return [
    `Before starting, ensure the repository is available locally:`,
    `1. Search for an existing clone whose git remote matches ${repoUrl}:`,
    `   a. Check common locations first: ~, /home, /opt, /workspace, /tmp.`,
    `   b. If not found, broaden the search across the filesystem (skip virtual/system dirs like /proc, /sys, /dev, and network mounts).`,
    `   c. Verify matches by running "git -C <dir> remote get-url origin" and comparing to ${repoUrl}.`,
    `2. If a matching clone is found, cd into it and proceed. Do NOT delete it when done.`,
    `3. If no matching clone is found:`,
    `   a. Create a temporary directory: mkdir -p /tmp/industry-readiness`,
    `   b. Clone into it: git clone ${repoUrl} /tmp/industry-readiness/${repoName}`,
    `   c. cd into /tmp/industry-readiness/${repoName} and proceed.`,
    `   d. When done, delete the temporary directory: rm -rf /tmp/industry-readiness`,
  ].join('\n');
}
