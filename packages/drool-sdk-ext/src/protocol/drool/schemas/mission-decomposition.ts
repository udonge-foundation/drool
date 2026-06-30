import z from 'zod';

import {
  DismissalType,
  FeatureStatus,
  FeatureSuccessState,
  IssueSeverity,
  MissionPauseReason,
  ProgressLogEntryType,
  WorkerFailureReason,
} from '../enums';

export const FeatureSuccessStateSchema = z.nativeEnum(FeatureSuccessState);

const OptionalNonBlankStringSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().optional()
);

// -------------------------
// Feature schema
// -------------------------

/**
 * Mission feature schema.
 *
 * NOTE: This is intentionally tolerant (passthrough + optional fields)
 * because the CLI/orchestrator owns the canonical on-disk feature shape and
 * may evolve it over time.
 */
export const MissionFeatureSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.nativeEnum(FeatureStatus),
  skillName: z.string(),
  preconditions: z.array(z.string()),
  expectedBehavior: z.array(z.string()),
  fulfills: z.array(z.string()).optional(),

  // Optional orchestrator-authored fields
  milestone: z.string().optional(),

  // System-managed fields (present in CLI features.json)
  workerSessionIds: z.array(z.string()).optional(),
  // Deprecated compatibility fields kept for protocol stability.
  currentWorkerSessionId: z.string().nullable().optional(),
  completedWorkerSessionId: z.string().nullable().optional(),
});

// -------------------------
// Progress log schemas
// -------------------------

// -------------------------
// Handoff-related schemas
// -------------------------

const IssueSeveritySchema = z.nativeEnum(IssueSeverity);

const DismissalTypeSchema = z.nativeEnum(DismissalType);

export const DiscoveredIssueSchema = z.object({
  severity: IssueSeveritySchema,
  description: z.string(),
  suggestedFix: z.string().optional(),
});

export const VerificationCommandSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  observation: z.string(),
});

export const InteractiveCheckSchema = z.object({
  action: z.string(),
  observed: z.string(),
});

export const VerificationSchema = z.object({
  commandsRun: z.array(VerificationCommandSchema),
  interactiveChecks: z.array(InteractiveCheckSchema).optional(),
});

export const TestCaseSchema = z.object({
  name: z.string(),
  verifies: z.string(),
});

export const TestFileSchema = z.object({
  file: z.string(),
  cases: z.array(TestCaseSchema),
});

export const TestsSchema = z.object({
  added: z.array(TestFileSchema),
  updated: z.array(z.string()).optional(),
  coverage: z.string(),
});

export const SkillDeviationSchema = z.object({
  step: z.string(),
  whatIDidInstead: z.string(),
  why: z.string(),
});

export const SkillFeedbackSchema = z.object({
  followedProcedure: z.boolean(),
  deviations: z.array(SkillDeviationSchema),
  suggestedChanges: z.array(z.string()).optional(),
});

export const HandoffSchema = z.object({
  // Optional for backward compatibility with historical on-disk handoffs.
  salientSummary: z.string().optional(),
  whatWasImplemented: z.string(),
  whatWasLeftUndone: z.string(),
  verification: VerificationSchema,
  tests: TestsSchema,
  discoveredIssues: z.array(DiscoveredIssueSchema),
  skillFeedback: SkillFeedbackSchema.optional(),
});

export const DismissalRecordSchema = z.object({
  type: DismissalTypeSchema,
  sourceFeatureId: z.string(),
  summary: z.string(),
  justification: z.string(),
});

// -------------------------
// Progress log entry schemas
// -------------------------

const BaseProgressLogEntrySchema = z.object({
  timestamp: z.string(),
});

export const MissionAcceptedEntrySchema = BaseProgressLogEntrySchema.extend({
  type: z.literal(ProgressLogEntryType.MissionAccepted),
  title: z.string(),
});

export const MissionPausedEntrySchema = BaseProgressLogEntrySchema.extend({
  type: z.literal(ProgressLogEntryType.MissionPaused),
  /**
   * Structured cause when the pause is automatic (e.g. unrecoverable 402).
   * Absent for user- or runner-initiated pauses.
   */
  pauseReason: z.nativeEnum(MissionPauseReason).optional(),
});

export const MissionResumedEntrySchema = BaseProgressLogEntrySchema.extend({
  type: z.literal(ProgressLogEntryType.MissionResumed),
  resumeWorkerSessionId: z.string().optional(),
});

export const MissionRunStartedEntrySchema = BaseProgressLogEntrySchema.extend({
  type: z.literal(ProgressLogEntryType.MissionRunStarted),
  message: z.string().optional(),
});

export const WorkerStartedEntrySchema = BaseProgressLogEntrySchema.extend({
  type: z.literal(ProgressLogEntryType.WorkerStarted),
  workerSessionId: z.string(),
  spawnId: z.string(),
  featureId: z.string().optional(),
});

export const WorkerSelectedFeatureEntrySchema =
  BaseProgressLogEntrySchema.extend({
    type: z.literal(ProgressLogEntryType.WorkerSelectedFeature),
    workerSessionId: z.string(),
    featureId: z.string(),
  });

export const WorkerCompletedEntrySchema = BaseProgressLogEntrySchema.extend({
  type: z.literal(ProgressLogEntryType.WorkerCompleted),
  workerSessionId: z.string(),
  featureId: z.string(),
  successState: FeatureSuccessStateSchema,
  returnToOrchestrator: z.boolean(),
  commitId: OptionalNonBlankStringSchema,
  repoPath: OptionalNonBlankStringSchema,
  exitCode: z.number(),
  validatorsPassed: z.boolean().optional(),
  handoff: HandoffSchema.optional(),
});

export const WorkerFailedEntrySchema = BaseProgressLogEntrySchema.extend({
  type: z.literal(ProgressLogEntryType.WorkerFailed),
  workerSessionId: z.string().optional(),
  spawnId: z.string(),
  exitCode: z.number().optional(),
  reason: z.string(),
  /**
   * Structured cause that lets the MissionRunner branch on specific failure
   * modes (e.g. unrecoverable 402 → auto-pause). Absent means a generic
   * failure: requeue + return to orchestrator.
   */
  failureReason: z.nativeEnum(WorkerFailureReason).optional(),
});

export const WorkerPausedEntrySchema = BaseProgressLogEntrySchema.extend({
  type: z.literal(ProgressLogEntryType.WorkerPaused),
  workerSessionId: z.string(),
  featureId: z.string().optional(),
});

export const HandoffItemsDismissedEntrySchema =
  BaseProgressLogEntrySchema.extend({
    type: z.literal(ProgressLogEntryType.HandoffItemsDismissed),
    dismissals: z.array(DismissalRecordSchema).optional(),
  });

export const MilestoneValidationTriggeredEntrySchema =
  BaseProgressLogEntrySchema.extend({
    type: z.literal(ProgressLogEntryType.MilestoneValidationTriggered),
    milestone: z.string(),
    featureId: z.string(),
  });

export const ProgressLogEntrySchema = z.discriminatedUnion('type', [
  MissionAcceptedEntrySchema,
  MissionPausedEntrySchema,
  MissionResumedEntrySchema,
  MissionRunStartedEntrySchema,
  WorkerStartedEntrySchema,
  WorkerSelectedFeatureEntrySchema,
  WorkerCompletedEntrySchema,
  WorkerFailedEntrySchema,
  WorkerPausedEntrySchema,
  HandoffItemsDismissedEntrySchema,
  MilestoneValidationTriggeredEntrySchema,
]);
