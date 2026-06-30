import {
  READINESS_CATEGORIES,
  READINESS_CRITERIA,
} from '@industry/common/agentReadiness/constants';
import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  CriterionStatus,
  calculateRepoLevel,
  calculateRepoScore,
  getCriterionStatus,
} from '@industry/utils/agentReadiness';

import { buildAgentReadinessPrompt } from './agent-readiness';

import type {
  IndustryAgentReadinessReport,
  SignalEvaluation,
  ReadinessCriterion,
} from '@industry/common/agentReadiness/types';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface FailingSignal {
  criterion: ReadinessCriterion;
  evaluation: SignalEvaluation;
}

interface BuildReadinessFixPromptParams {
  repoUrl: string;
  appBaseUrl: string;
  report: IndustryAgentReadinessReport | null;
  userArgs: string;
}

// -----------------------------------------------------------------------------
// Shared Section Builders
// -----------------------------------------------------------------------------

function buildReportSummarySection(
  report: IndustryAgentReadinessReport,
  repoUrl: string
): string {
  const levelResult = calculateRepoLevel(report);
  const score = calculateRepoScore(report);

  return `## Report Summary
**Repository:** ${repoUrl}
**Level:** ${levelResult.achievedLevel}
**Score:** ${score.toFixed(1)}%`;
}

function buildFailingSignalsSection(failingSignals: FailingSignal[]): string {
  if (failingSignals.length === 0) return '';

  const lines = failingSignals.map(({ criterion, evaluation }) => {
    const score =
      evaluation.numerator === null
        ? '[N/A]'
        : `[${evaluation.numerator}/${evaluation.denominator}]`;
    return (
      `- **${criterion.name}** (\`${criterion.id}\`): ${score} - ${evaluation.rationale}\n` +
      `  Description: ${criterion.description}\n` +
      `  Evaluation instructions: ${criterion.instructions}`
    );
  });

  return `## Failing Signals (${failingSignals.length} total)\n\n${lines.join('\n\n')}`;
}

function buildFixInstructionsAndQualitySection(): string {
  return `## Fix Instructions

For each signal you are fixing:
1. Explore the repository to understand the current state related to the signal
2. Make **substantive improvements** to the codebase that genuinely address the signal
3. Verify your fix addresses the issue (e.g., run linter if fixing lint_config, run tests if adding tests)
4. Keep changes focused on the signal - don't refactor unrelated code

## Completion

- Provide a succinct summary of what you changed and why it genuinely improves the codebase

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
- Adding proper TypeScript types to improve type safety`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getFailingSignals(
  report: IndustryAgentReadinessReport
): FailingSignal[] {
  const failing: FailingSignal[] = [];

  for (const criterion of READINESS_CRITERIA) {
    const evaluation = report.report[criterion.id];
    if (!evaluation) continue;

    const status = getCriterionStatus(evaluation);
    if (status === CriterionStatus.Failed) {
      failing.push({ criterion, evaluation });
    }
  }

  return failing;
}

// -----------------------------------------------------------------------------
// Main Prompt Builder
// -----------------------------------------------------------------------------

export async function buildReadinessFixPrompt({
  repoUrl,
  appBaseUrl,
  report,
  userArgs,
}: BuildReadinessFixPromptParams): Promise<string> {
  const userArgsText = userArgs.trim();
  const hasArgs = userArgsText.length > 0;
  const hasReport = report !== null;

  // Mode A: Report exists + args provided
  if (hasReport && hasArgs) {
    const failingSignals = getFailingSignals(report);

    if (failingSignals.length === 0) {
      return `${SYSTEM_REMINDER_START}
All readiness signals are passing for this repository. No fixes needed.
${SYSTEM_REMINDER_END}`;
    }

    return `${SYSTEM_REMINDER_START}
You are fixing failing Agent Readiness signals. Agent Readiness evaluates how well a repository supports autonomous AI agents working on the codebase.

${buildReportSummarySection(report, repoUrl)}

${buildFailingSignalsSection(failingSignals)}

## User Requested Signals
The user asked to fix: "${userArgsText}"

## Your Task

1. Semantically match the user's requested signals ("${userArgsText}") to the failing signals listed above.
   - Match by criterion ID (e.g., "lint_config"), criterion name (e.g., "Linter Configuration"), or semantic meaning (e.g., "the cyclomatic complexity criteria" matches \`cyclomatic_complexity\`).
   - If a requested signal already passes, note that it passes and skip it.
   - If a requested signal doesn't match any known criterion, note that and skip it.
2. For each matched failing signal, fix it in sequence.

${buildFixInstructionsAndQualitySection()}
${SYSTEM_REMINDER_END}`;
  }

  // Mode B: Report exists + no args
  if (hasReport && !hasArgs) {
    const failingSignals = getFailingSignals(report);

    if (failingSignals.length === 0) {
      return `${SYSTEM_REMINDER_START}
All readiness signals are passing for this repository. No fixes needed.
${SYSTEM_REMINDER_END}`;
    }

    return `${SYSTEM_REMINDER_START}
You are fixing failing Agent Readiness signals. Agent Readiness evaluates how well a repository supports autonomous AI agents working on the codebase.

${buildReportSummarySection(report, repoUrl)}

${buildFailingSignalsSection(failingSignals)}

## Your Task

**Step 1:** Group the failing signals above by their category. Ask the user which category they want to fix using the AskUser tool. Only show categories that have at least one failing signal.

**Step 2:** Based on the chosen category, present each failing signal in that category as an option in a single AskUser call. Each option is exactly one signal (with its name and current score). The user picks one signal to fix. Do NOT say "select all that apply" or "select one or more".

After the user selects a signal, fix it.

${buildFixInstructionsAndQualitySection()}
${SYSTEM_REMINDER_END}`;
  }

  // Mode C & D: No report (with or without args)
  const reportGenerationPrompt = await buildAgentReadinessPrompt({
    repoUrl,
    appBaseUrl,
  });

  // Strip outer system-reminder tags to avoid nesting
  const strippedReportPrompt = reportGenerationPrompt
    .replace(SYSTEM_REMINDER_START, '')
    .replace(new RegExp(`${SYSTEM_REMINDER_END}$`), '');

  const argsContext = hasArgs
    ? `\nThe user originally requested to fix: "${userArgsText}"\n`
    : '';

  const afterReportInstructions = hasArgs
    ? `Then semantically match the user's requested signals ("${userArgsText}") to the failing signals and fix each matched failing signal.`
    : 'Then present the failing signals to the user via the AskUser tool for selection, and fix the selected ones.';

  const categoryOptions = READINESS_CATEGORIES.map((c) => `- "${c.name}"`).join(
    '\n'
  );

  let skipInstructions: string;
  if (hasArgs) {
    skipInstructions = `Explore the repository, identify gaps related to: "${userArgsText}", and fix them directly.`;
  } else {
    // Build signal catalog inline
    const categoryMap = new Map<string, string[]>();
    for (const criterion of READINESS_CRITERIA) {
      const category = READINESS_CATEGORIES.find(
        (c) => c.id === criterion.category
      );
      const categoryName = category?.name ?? criterion.category;
      if (!categoryMap.has(categoryName)) {
        categoryMap.set(categoryName, []);
      }
      categoryMap
        .get(categoryName)!
        .push(
          `- ${criterion.name} (\`${criterion.id}\`): ${criterion.description}`
        );
    }
    const catalogSections = Array.from(categoryMap.entries()).map(
      ([name, signals]) => `**${name}**\n${signals.join('\n')}`
    );
    const signalCatalog = `## All Readiness Signals\n\n${catalogSections.join('\n\n')}`;

    skipInstructions = `**Step 2:** Ask the user which category to fix using the AskUser tool:
"Which category of signals would you like to fix?"
Options:
${categoryOptions}

**Step 3:** Present the signals from the chosen category in a single AskUser call with one question. Each option is exactly one signal. The user picks one signal to fix. Do NOT say "select all that apply" or "select one or more" -- the user picks a single signal. IMPORTANT: The AskUser tool has a hard limit of 10 options per question. If the category has more than 10 signals, only include the most impactful/common ones (up to 10). Use the catalog below as reference:

${signalCatalog}

After the user selects a signal, explore the repository and fix it.`;
  }

  return `${SYSTEM_REMINDER_START}
You are fixing failing Agent Readiness signals. Agent Readiness evaluates how well a repository supports autonomous AI agents working on the codebase.

**Repository:** ${repoUrl}

## Context

No previous readiness report was found for this repository.
${argsContext}
## Your Task

**Step 1:** Ask the user using the AskUser tool:
"No readiness report found for this repository. How would you like to proceed?"
Options:
- "Generate a full report first, then fix failing signals"
- "Skip the report and fix signals directly"

**If the user chooses to generate a report first:**
Follow the readiness report generation instructions below to evaluate the repository and store the report. ${afterReportInstructions}

**If the user chooses to skip the report:**
${skipInstructions}

${buildFixInstructionsAndQualitySection()}

---

## Readiness Report Generation Instructions

If the user chose to generate a report first, follow these instructions to evaluate the repository:

${strippedReportPrompt}
${SYSTEM_REMINDER_END}`;
}
