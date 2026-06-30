import { CIWorkflowModeId } from './enums';

import type { CIWorkflowMode } from './types';

export const AUTOMATION_DESCRIPTION_MAX_LENGTH = 1024;

export const CRON_DAY_OF_WEEK_ALIASES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

export const CRON_MONTH_ALIASES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

export const CI_EDIT_ACTIONS = ['edit', 'delete', 'create'] as const;
export const CI_EDIT_STATUSES = [
  'pending',
  'ready',
  'failed',
  'closed',
] as const;

/**
 * Registry of "known" CI workflow modes that get a custom, structured edit
 * experience. To add a new mode:
 *   - append an entry here with a unique id (from `CIWorkflowModeId`) and the
 *     workflow filenames it owns,
 *   - add a payload interface to `types.ts` + extend `CIModeChanges`,
 *   - register a frontend body component in `packages/frontend/.../ci-modes/`,
 *   - register a backend prompt-section builder in
 *     `apps/backend/.../ci-mode-prompts/`.
 *
 * Anything not matching a registered mode falls back to the generic CI
 * editor (raw YAML + prompt + schedule).
 */
export const CI_WORKFLOW_MODES: ReadonlyArray<CIWorkflowMode> = [
  {
    id: CIWorkflowModeId.CodeReview,
    displayName: 'Code Review',
    filenames: [
      'industry-review.yml',
      'industry-review.yaml',
      'code-review.yml',
      'code-review.yaml',
      'drool-review.yml',
      'drool-review.yaml',
      'security-review.yml',
      'security-review.yaml',
      'review.yml',
      'review.yaml',
      'drool.yml',
      'drool.yaml',
    ],
  },
  {
    id: CIWorkflowModeId.Wiki,
    displayName: 'Wiki',
    /** Filename installed by the install-wiki built-in skill. */
    filenames: ['drool-wiki-refresh.yml', 'drool-wiki-refresh.yaml'],
  },
  {
    id: CIWorkflowModeId.Qa,
    displayName: 'QA',
    /** Filename installed by the install-qa built-in skill. */
    filenames: ['qa.yml', 'qa.yaml'],
  },
  {
    id: CIWorkflowModeId.SecurityAudit,
    displayName: 'Security Audit',
    /**
     * Canonical filename for the scheduled full-codebase security audit
     * (docs: security-review "Periodic scan in CI").
     */
    filenames: ['deep-security-review.yml', 'deep-security-review.yaml'],
  },
];
