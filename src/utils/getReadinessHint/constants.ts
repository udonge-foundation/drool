import { ReadinessCriterionId } from '@industry/common/agentReadiness/enums';

/** L1 readiness hints shown once per repo; copy stays short enough for 80 columns. */
export const L1_HINT_COPY: Readonly<
  Partial<Record<ReadinessCriterionId, string>>
> = {
  [ReadinessCriterionId.LintConfig]:
    'No linter detected. Run /readiness-fix to set one up.',
  [ReadinessCriterionId.TypeCheck]:
    'No type checker detected. Run /readiness-fix to set one up.',
  [ReadinessCriterionId.Formatter]:
    'No formatter detected. Run /readiness-fix to set one up.',
  [ReadinessCriterionId.UnitTestsExist]:
    'No unit tests detected. Run /readiness-fix to scaffold the first.',
  [ReadinessCriterionId.Readme]:
    'No README at the repo root. Run /readiness-fix to draft one.',
  [ReadinessCriterionId.EnvTemplate]:
    'No .env.example detected. Run /readiness-fix to generate one.',
};

/** Copy for the no-report nudge; one-shot per (user, git root). */
export const NO_REPORT_HINT_COPY =
  'Run /readiness-report to evaluate this repo for agent readiness.';
