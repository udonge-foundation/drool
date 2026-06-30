import { detectVisualBrandIssues } from './detectVisualBrandIssues';
import { VisualPolicyBranch } from './enums';

import type { DetectedVisualBrandIssue, VisualPolicyDecision } from './types';

const SCAFFOLD_MARKER = 'data-industry-visual-scaffold="true"';

/**
 * Decide what the next automation run should do with the on-disk
 * VISUAL.html. This is the single source of truth for the three
 * branches; every call site (scheduled dispatch, manual dispatch,
 * sync-service upload gate, backend POST gate) consumes the same
 * decision so they cannot disagree.
 *
 *   create   — no file on disk OR an empty file OR the starter scaffold
 *              OR a first-run state where the file shouldn't be trusted.
 *              The agent should generate a fresh dashboard.
 *   preserve — a brand-compliant non-scaffold visual exists. The agent
 *              should Edit it in place, changing only the data.
 *   rebuild  — a non-scaffold visual exists but fails brand checks. The
 *              agent should regenerate it from scratch; the upload gate
 *              should refuse to publish the current bytes.
 */
export function decideVisualPolicy(input: {
  readonly existingHtml: string | null;
  readonly isFirstRun: boolean;
}): VisualPolicyDecision {
  const html = input.existingHtml?.trim() ?? '';

  if (!html) {
    return {
      branch: VisualPolicyBranch.Create,
      reason: 'No existing VISUAL.html on disk.',
      issues: [],
    };
  }

  if (html.includes(SCAFFOLD_MARKER) || input.isFirstRun) {
    return {
      branch: VisualPolicyBranch.Create,
      reason: input.isFirstRun
        ? 'First run: replace the starter scaffold with a useful dashboard.'
        : 'Existing VISUAL.html is the starter scaffold; replace it with a useful dashboard.',
      issues: [],
    };
  }

  const issues: DetectedVisualBrandIssue[] = detectVisualBrandIssues(html);
  if (issues.length === 0) {
    return {
      branch: VisualPolicyBranch.Preserve,
      reason:
        'Existing VISUAL.html passed brand-guide checks; edit it in place.',
      issues: [],
    };
  }

  return {
    branch: VisualPolicyBranch.Rebuild,
    reason: `Existing VISUAL.html failed ${issues.length} brand-guide check${issues.length === 1 ? '' : 's'}: ${issues
      .map((i) => i.id)
      .join(', ')}.`,
    issues,
  };
}
