import { z } from 'zod';

import { MissionPauseReason } from '@industry/drool-sdk-ext/protocol/drool';

function countSentences(text: string): number {
  const normalized = text
    .replace(/\s+/g, ' ')
    .trim()
    // Remove trailing punctuation so "Hello." and "Hello" count the same.
    .replace(/[.!?]+\s*$/, '');

  if (!normalized) return 0;

  // Naive sentence counting; good enough to enforce short summaries.
  const parts = normalized.split(/[.!?]+\s+/).filter(Boolean);
  return parts.length;
}

function createSalientSummarySchema({
  maxLength,
  maxSentences,
  description,
}: {
  maxLength: number;
  maxSentences: number;
  description: string;
}) {
  return z
    .string()
    .min(20)
    .max(maxLength)
    .refine((s) => !s.includes('\n'), {
      message: 'salientSummary must be 1–4 sentences (no newlines)',
    })
    .refine(
      (s) => {
        const n = countSentences(s);
        return n >= 1 && n <= maxSentences;
      },
      {
        message: 'salientSummary must be 1–4 sentences',
      }
    )
    .describe(description);
}

// ============ Orchestrator Tool Schemas ============

/**
 * Schema for propose_mission tool
 */
export const proposeMissionSchema = z.object({
  title: z.string().describe('Mission title'),
  proposal: z
    .string()
    .describe(
      'Detailed markdown proposal including: plan overview, environment setup, and user-friendly feature list (not the same as features.json)'
    ),
  workingDirectory: z
    .string()
    .optional()
    .describe(
      'Working directory for the mission. Workers will spawn in this directory. Defaults to current cwd if not specified.'
    ),
});

export type ProposeMissionParams = z.infer<typeof proposeMissionSchema>;

/**
 * Result schema for propose_mission
 */
export const proposeMissionResultSchema = z.object({
  accepted: z.boolean().describe('Whether the user accepted the proposal'),
  missionDir: z
    .string()
    .optional()
    .describe('Path to mission directory if accepted'),
  isEdited: z
    .boolean()
    .optional()
    .describe('Whether the user chose to manually edit the mission'),
  llmGuidance: z
    .string()
    .optional()
    .describe('Guidance for the LLM on next steps'),
});

export type ProposeMissionResult = z.infer<typeof proposeMissionResultSchema>;

/**
 * Schema for start_mission_run tool
 */
export const startMissionRunSchema = z.object({
  message: z
    .string()
    .optional()
    .describe('Optional message to log when starting the run'),
  resumeWorkerSessionId: z
    .string()
    .optional()
    .describe(
      'Session ID of a previously interrupted worker to resume. If provided, the runner will continue that worker session instead of spawning a new one. Only use this when explicitly resuming after a pause.'
    ),
  restartFeature: z
    .boolean()
    .optional()
    .describe(
      'When true, the in-progress feature will be restarted from scratch with a new worker instead of resuming the paused worker session.'
    ),
});

export type StartMissionRunParams = z.infer<typeof startMissionRunSchema>;

// Forward declaration for circular reference - actual schema defined below
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workerHandoffSchemaRef: z.ZodType<any>;

const startMissionRunFeaturePreviewSchema = z.object({
  id: z.string(),
  status: z.string(),
  milestone: z.string().optional(),
  description: z.string().optional(),
});

const startMissionRunProgressSnapshotSchema = z.object({
  kind: z.literal('start_mission_run_snapshot'),
  state: z.string(),
  updatedAt: z.string().optional(),
  activeTime: z
    .object({
      elapsedMs: z.number(),
      measuredAtMs: z.number(),
    })
    .optional(),
  counts: z.object({
    total: z.number(),
    completed: z.number(),
    cancelled: z.number(),
    estimatedValidation: z.number(),
  }),
  featureWindow: z.object({
    previous: startMissionRunFeaturePreviewSchema.optional(),
    focus: startMissionRunFeaturePreviewSchema.nullable(),
    next: startMissionRunFeaturePreviewSchema.optional(),
  }),
  currentWorkerId: z.string().nullable(),
});

/**
 * Result schema for start_mission_run
 * Note: workerHandoffs uses z.lazy() because handoffSchema is defined later in this file
 */
export const startMissionRunResultSchema = z.object({
  started: z.boolean().describe('Whether the runner was started'),
  workerHandoffs: z
    .array(z.lazy(() => workerHandoffSchemaRef))
    .optional()
    .describe(
      'All worker handoff summaries since the last run (full handoffs are written to per-worker JSON files)'
    ),
  latestWorkerHandoff: z
    .object({
      featureId: z
        .string()
        .describe('The featureId for the latest newly-returned handoff'),
      resultState: z
        .enum(['pass', 'fail'])
        .describe('Pass/fail summary of the latest worker result'),
      handoffFile: z
        .string()
        .describe(
          'Path to the per-worker JSON handoff file in the mission directory'
        ),
      handoffJson: z
        .string()
        .describe('The full JSON contents of the latest handoff file'),
    })
    .optional()
    .describe(
      'The latest newly-returned worker handoff, shown inline in full for convenience'
    ),
  systemMessage: z
    .string()
    .optional()
    .describe('System message with instructions'),
  /**
   * Structured pause reason. Set when the runner stopped because the
   * mission auto-paused for a known reason (e.g. unrecoverable 402).
   * Drives error-style rendering in the StartMissionRun tool card so the
   * user sees "Usage limit reached" instead of a neutral "Finished" state.
   */
  pauseReason: z
    .nativeEnum(MissionPauseReason)
    .optional()
    .describe(
      'Structured pause reason for UI rendering. Absent for user/regular pauses.'
    ),
  // Display-only fields (not for LLM, just for UI rendering)
  completedFeatures: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().optional(),
      })
    )
    .optional()
    .describe('List of completed features for display'),
  totalFeatures: z.number().optional().describe('Total feature count'),
  workerCount: z.number().optional().describe('Number of workers used'),
  startedAt: z.string().optional().describe('Mission start timestamp'),
  progressSnapshot: startMissionRunProgressSnapshotSchema
    .optional()
    .describe('Frozen mission progress snapshot for UI rendering'),
});

export type StartMissionRunResult = z.infer<typeof startMissionRunResultSchema>;

// ============ Worker Tool Schemas ============

/**
 * Schema for select_feature tool
 */
const _selectFeatureSchema = z.object({
  featureId: z.string().describe('The ID of the feature to select'),
});

export type SelectFeatureParams = z.infer<typeof _selectFeatureSchema>;

/**
 * Result schema for select_feature
 */
const _selectFeatureResultSchema = z.object({
  selected: z.boolean().describe('Whether the feature was selected'),
  feature: z
    .object({
      id: z.string(),
      description: z.string(),
      skillName: z.string(),
      preconditions: z.array(z.string()),
      expectedBehavior: z.array(z.string()),
    })
    .optional()
    .describe('The selected feature details'),
  nextStep: z
    .string()
    .optional()
    .describe('REQUIRED next action - must invoke the skill specified'),
  error: z.string().optional().describe('Error message if selection failed'),
});

export type SelectFeatureResult = z.infer<typeof _selectFeatureResultSchema>;

/**
 * Schema for verification commands run during feature implementation
 */
const verificationCommandSchema = z.object({
  command: z.string().describe('The command that was run'),
  exitCode: z.number().describe('Exit code of the command'),
  observation: z
    .string()
    .describe(
      'What you observed in the output - be specific about what you saw, not just "passed"'
    ),
});

/**
 * Schema for interactive checks (UI/browser verification) during feature implementation
 */
const interactiveCheckSchema = z.object({
  action: z.string().describe('What you did (clicked, navigated, typed)'),
  observed: z.string().describe('What you saw as a result'),
});

/**
 * Schema for verification performed during feature implementation
 */
const verificationSchema = z.object({
  commandsRun: z
    .array(verificationCommandSchema)
    .describe(
      'Shell commands run (tests, curl, etc.) with exit codes and observations'
    ),
  interactiveChecks: z
    .array(interactiveCheckSchema)
    .optional()
    .describe(
      'UI/browser verification - clicking, navigating, visual inspection'
    ),
});

/**
 * Schema for a test case added during feature implementation
 */
const testCaseSchema = z.object({
  name: z.string().describe('Test case name'),
  verifies: z.string().describe('What behavior this test verifies'),
});

/**
 * Schema for a test file added during feature implementation
 */
const testFileSchema = z.object({
  file: z.string().describe('Test file path'),
  cases: z.array(testCaseSchema).describe('Test cases in this file'),
});

/**
 * Schema for tests added/updated during feature implementation
 */
const testsSchema = z.object({
  added: z
    .array(testFileSchema)
    .describe('Test files added with their test cases'),
  updated: z
    .array(z.string())
    .optional()
    .describe('Existing test files that were modified'),
  coverage: z.string().describe('Summary of what the tests cover'),
});

/**
 * Schema for discovered issues during feature implementation
 */
const discoveredIssueSchema = z.object({
  severity: z
    .enum(['blocking', 'non_blocking', 'suggestion'])
    .describe('Severity of the issue'),
  description: z.string().describe('Description of the issue'),
  suggestedFix: z.string().optional().describe('Suggested fix for the issue'),
});

/**
 * Schema for skill procedure deviation
 */
const skillDeviationSchema = z.object({
  step: z.string().describe('Which skill step you deviated from'),
  whatIDidInstead: z.string().describe('What you actually did'),
  why: z
    .string()
    .describe(
      'Why you deviated (blocked, better approach, unclear instruction, etc.)'
    ),
});

/**
 * Schema for skill feedback in handoff
 */
const skillFeedbackSchema = z.object({
  followedProcedure: z
    .boolean()
    .describe('Did you follow the skill procedure as written?'),
  deviations: z
    .array(skillDeviationSchema)
    .describe(
      'Where and why you deviated from the skill procedure. Empty if followedProcedure is true.'
    ),
  suggestedChanges: z
    .array(z.string())
    .optional()
    .describe('Suggestions for improving the skill (optional)'),
});

/**
 * Schema for the structured handoff in end_feature_run
 */
const handoffSchema = z.object({
  salientSummary: createSalientSummarySchema({
    maxLength: 750,
    maxSentences: 6,
    description:
      '1–4 sentence salient summary of what happened in this session',
  }),
  whatWasImplemented: z
    .string()
    .min(50)
    .describe('Concrete description of what was built (min 50 characters)'),
  whatWasLeftUndone: z
    .string()
    .describe(
      'Anything incomplete or deferred. Must leave empty if everything is truly complete.'
    ),
  verification: verificationSchema.describe(
    'Verification performed: commands with results + any manual checks'
  ),
  tests: testsSchema.describe('Tests written or updated'),
  discoveredIssues: z
    .array(discoveredIssueSchema)
    .describe('Issues found during implementation. Empty array if none.'),
  skillFeedback: skillFeedbackSchema
    .optional()
    .describe(
      'Feedback on the skill procedure. Fill this out to help improve future workers.'
    ),
});

// Tighter bounds shown to the model via llmInputSchema so it aims for 500 chars / 4 sentences,
// while handoffSchema (used for runtime validation) silently accepts up to 750 chars / 6 sentences.
const handoffLlmSchema = z.object({
  ...handoffSchema.shape,
  salientSummary: createSalientSummarySchema({
    maxLength: 500,
    maxSentences: 4,
    description: '1-4 sentences, aim for under 500 characters',
  }),
});

export type Handoff = z.infer<typeof handoffSchema>;

/**
 * Worker handoff summary for orchestrator review
 */
const workerHandoffSchema = z.object({
  featureId: z.string().describe('The feature that was worked on'),
  resultState: z
    .enum(['pass', 'fail'])
    .describe('Pass/fail summary of the worker result'),
  discoveredIssuesCount: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of discovered issues reported by the worker'),
  unfinishedWorkCount: z
    .number()
    .int()
    .nonnegative()
    .describe('0 if no unfinished work; 1 if any unfinished work was reported'),
  whatWasImplemented: z
    .string()
    .describe(
      'Concrete description of what was built (from the worker handoff)'
    ),
  handoffFile: z
    .string()
    .describe(
      'Path to the per-worker JSON handoff file in the mission directory'
    ),
});

export type WorkerHandoff = z.infer<typeof workerHandoffSchema>;

// Assign to the forward reference now that the schema is defined
workerHandoffSchemaRef = workerHandoffSchema;

/**
 * Schema for end_feature_run tool
 */
const endFeatureRunBaseShape = {
  successState: z
    .enum(['success', 'partial', 'failure'])
    .describe('Whether the feature implementation succeeded'),
  returnToOrchestrator: z
    .boolean()
    .describe(
      'Whether to return control to orchestrator (true = needs attention)'
    ),
  featureId: z
    .string()
    .optional()
    .describe('Feature ID (uses currentFeatureId if not provided)'),
  commitId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Git commit ID for repo changes. Optional for successful handoffs that only changed mission artifacts.'
    ),
  repoPath: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Absolute path to the git repository containing commitId. Provide when commitId is provided, especially for multi-repo missions.'
    ),
  validatorsPassed: z
    .boolean()
    .optional()
    .describe('Whether all validators passed (required true if success)'),
};

export const endFeatureRunSchema = z.object({
  ...endFeatureRunBaseShape,
  handoff: handoffSchema.describe(
    'Structured handoff information for the team'
  ),
});

export const endFeatureRunLlmSchema = z.object({
  ...endFeatureRunBaseShape,
  handoff: handoffLlmSchema.describe(
    'Structured handoff information for the team'
  ),
});

export type EndFeatureRunParams = z.infer<typeof endFeatureRunSchema>;

/**
 * Result schema for end_feature_run
 */
export const endFeatureRunResultSchema = z.object({
  recorded: z.boolean().describe('Whether the result was recorded'),
  nextAction: z
    .enum(['continue', 'orchestrator', 'completed'])
    .describe('What happens next'),
  message: z.string().optional().describe('Status message'),
});

export type EndFeatureRunResult = z.infer<typeof endFeatureRunResultSchema>;

// ============ Orchestrator Dismiss Handoff Items Schemas ============

/**
 * Schema for a single dismissal item
 */
const dismissalItemSchema = z.object({
  type: z
    .enum(['discovered_issue', 'critical_context', 'incomplete_work'])
    .describe('Type of handoff item being dismissed'),
  sourceFeatureId: z.string().describe('Feature ID this item came from'),
  summary: z.string().describe('Brief summary of what is being dismissed'),
  justification: z
    .string()
    .min(20)
    .describe(
      'Justification for dismissal (min 20 characters). For tech debt (discovered_issue, incomplete_work): cite existing feature ID that tracks this, OR explain why it will NEVER need fixing (e.g., dead code being removed). "Low priority" or "non-blocking" is NOT valid. For critical_context: explain why not useful or cite existing documentation.'
    ),
});

export type DismissalItem = z.infer<typeof dismissalItemSchema>;

/**
 * Schema for dismiss_handoff_items tool
 */
export const dismissHandoffItemsSchema = z.object({
  dismissals: z
    .array(dismissalItemSchema)
    .min(1)
    .describe('Array of items to dismiss with justifications'),
});

export type DismissHandoffItemsParams = z.infer<
  typeof dismissHandoffItemsSchema
>;

/**
 * Result schema for dismiss_handoff_items
 */
export const dismissHandoffItemsResultSchema = z.object({
  dismissed: z.boolean().describe('Whether the dismissals were recorded'),
  count: z.number().describe('Number of items dismissed'),
  message: z.string().optional().describe('Status message'),
});

export type DismissHandoffItemsResult = z.infer<
  typeof dismissHandoffItemsResultSchema
>;
