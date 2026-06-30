import { z } from 'zod';

import { AUTOMATION_DESCRIPTION_MAX_LENGTH } from './constants';
import {
  AutomationStatus,
  AutomationTriggerType,
  CISetupStatus,
  SlackAutomationSessionPrivacy,
} from './enums';
import {
  isValidAutomationScheduleInput,
  normalizeAutomationScheduleInput,
} from './schedule';
import {
  AutomationPrivacyLevel,
  AutomationRunType,
  AutomationTemplateId,
} from '../../../automations/enums';
import { AutomationCreatedBySchema } from '../../../automations/schema';
import { SlackMessageSource } from '../../../integrations';
import { DroolExecutionStatus } from '../../../session/enums';
import { PaginationMetaSchema } from '../pagination/schemas';

const INVALID_SCHEDULE_ERROR =
  'Schedule must be a valid natural-language schedule or 5-part cron expression.';

const AutomationScheduleInputSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  return normalizeAutomationScheduleInput(value) ?? value.trim();
}, z.string());

const SlackChannelConfigSchema = z.object({
  channelId: z.string(),
  channelName: z.string(),
  isPrivate: z.boolean().optional(),
});

export const AutomationTriggerConfigSchema = z
  .object({
    // CI fields
    repo: z.string().optional(),
    events: z.array(z.string()).optional(),
    workflowParams: z.string().optional(),
    workflowFilePath: z.string().optional(),
    workflowFileSha: z.string().optional(),
    automaticReview: z.boolean().optional(),
    automaticSecurityReview: z.boolean().optional(),
    securityModel: z.string().optional(),
    // Slack fields
    channels: z.array(SlackChannelConfigSchema).optional(),
    autoRun: z.boolean().optional(),
    customPrompt: z.string().optional(),
    sessionPrivacy: z.nativeEnum(SlackAutomationSessionPrivacy).optional(),
    model: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    messageSource: z.nativeEnum(SlackMessageSource).optional(),
    serviceAccountId: z.string().optional(),
  })
  .optional();

export const AutomationIdSchema = z
  .object({
    automationId: z.string().describe('Automation ID'),
  })
  .strict();

// Coerces null to undefined before validating as an optional string. Legacy
// Firestore docs synced before the FieldValue.delete() fix can store `null`
// for fields the daemon used to write as `value ?? null` (description, model,
// forkedFrom). Accepting null on input keeps /api/v0/automations/[id] and the
// daemon's AutomationSchema.parse() from rejecting those docs, while leaving
// the inferred consumer type as `string | undefined`.
const NullableOptionalString = z.preprocess(
  (val) => (val === null ? undefined : val),
  z.string().optional()
);

// Trigger-agnostic template the automation was created from. Coerces null to
// undefined (legacy docs) and drops unknown values so a future/renamed
// template id can never make an otherwise-valid automation doc unparseable.
const NullableOptionalTemplateId = z.preprocess(
  (val) =>
    typeof val === 'string' &&
    Object.values<string>(AutomationTemplateId).includes(val)
      ? val
      : undefined,
  z.nativeEnum(AutomationTemplateId).optional()
);

export const AutomationSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  description: NullableOptionalString,
  prompt: z.string(),
  triggerType: z
    .nativeEnum(AutomationTriggerType)
    .default(AutomationTriggerType.Schedule),
  schedule: z.string(),
  triggerConfig: AutomationTriggerConfigSchema,
  /** Denormalized channel IDs from `triggerConfig.channels[]`, indexed so the Slack router resolves channel -> automations via `array-contains`. */
  triggerChannelIds: z.array(z.string()).optional(),
  model: NullableOptionalString,
  templateId: NullableOptionalTemplateId,
  tags: z.array(z.string()),
  status: z.nativeEnum(AutomationStatus),
  computerId: z.string().optional(),
  /**
   * Display name of the computer this automation runs on, denormalized at
   * read time from the computer doc. Resolved server-side (incl. org-mates'
   * computers) so shared automations can show a name the viewer cannot look
   * up via their own computers list. Absent when the computer is unknown.
   */
  computerName: z.string().optional(),
  /**
   * Set when a UI edit to a computer automation has not yet been written to
   * the machine's on-disk HEARTBEAT.md. The daemon reads this on each run to
   * decide whether to reconcile Firestore->file before reading the file.
   */
  fileSyncPending: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  privacyLevel: z.nativeEnum(AutomationPrivacyLevel).optional(),
  createdBy: AutomationCreatedBySchema.optional(),
  forkedFrom: NullableOptionalString,
  machineId: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastRunStatus: z.string().optional(),
  runCount: z.number().optional(),
  ciSetupStatus: z.nativeEnum(CISetupStatus).optional(),
  ciPrUrl: z.string().optional(),
  ciPrNumber: z.number().optional(),
  ciWorkflowFilePath: z.string().optional(),
});

export const AutomationListResponseSchema = z.object({
  automations: z.array(AutomationSchema),
});

export const CreateAutomationRequestSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(128),
    description: z
      .string()
      .max(AUTOMATION_DESCRIPTION_MAX_LENGTH)
      .optional()
      .default(''),
    prompt: z.string().min(1),
    triggerType: z
      .nativeEnum(AutomationTriggerType)
      .default(AutomationTriggerType.Schedule),
    schedule: AutomationScheduleInputSchema.optional().default(''),
    triggerConfig: AutomationTriggerConfigSchema,
    model: z.string(),
    templateId: z.nativeEnum(AutomationTemplateId).optional(),
    privacyLevel: z.nativeEnum(AutomationPrivacyLevel).optional(),
    tags: z.array(z.string()).optional().default([]),
    computerId: z.string(),
    // When a UI setup session will scaffold the automation files itself (the
    // create flow's interactive agent), the backend must NOT also push a
    // create-time scaffold to the computer. Pre-scaffolding makes the files
    // appear on disk immediately, which the web client reads as "setup
    // complete" and dismisses the creation screen before the session has had a
    // chance to run or block on input. Defaults to false for API/CLI creates,
    // which have no setup session and rely on the backend scaffold.
    deferScaffold: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.triggerType === AutomationTriggerType.Schedule) {
      if (!data.schedule || !isValidAutomationScheduleInput(data.schedule)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: INVALID_SCHEDULE_ERROR,
          path: ['schedule'],
        });
      }
    }
    if (data.triggerType === AutomationTriggerType.CI) {
      if (!data.triggerConfig?.repo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Repository is required for CI automations.',
          path: ['triggerConfig', 'repo'],
        });
      }
    }
    if (data.triggerType === AutomationTriggerType.Slack) {
      if (
        !data.triggerConfig?.channels ||
        data.triggerConfig.channels.length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one channel is required for Slack automations.',
          path: ['triggerConfig', 'channels'],
        });
      }
    }
  });

export const UpdateAutomationRequestSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(AUTOMATION_DESCRIPTION_MAX_LENGTH).optional(),
  prompt: z.string().min(1).optional(),
  triggerType: z.nativeEnum(AutomationTriggerType).optional(),
  schedule: AutomationScheduleInputSchema.refine(
    isValidAutomationScheduleInput,
    INVALID_SCHEDULE_ERROR
  ).optional(),
  triggerConfig: AutomationTriggerConfigSchema,
  model: z.string().optional(),
  templateId: z.nativeEnum(AutomationTemplateId).optional(),
  tags: z.array(z.string()).optional(),
  status: z.nativeEnum(AutomationStatus).optional(),
  computerId: z.string().optional(),
});

export const AutomationRunSchema = z.object({
  sessionId: z.string(),
  type: z.nativeEnum(AutomationRunType).optional(),
  status: z.nativeEnum(DroolExecutionStatus),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  title: z.string().optional(),
});

export const AutomationRunListResponseSchema = z.object({
  runs: z.array(AutomationRunSchema),
  pagination: PaginationMetaSchema,
});

export const AutomationRunStatsBucketSchema = z.object({
  date: z.string(),
  total: z.number(),
  completed: z.number(),
});

export const AutomationRunStatsResponseSchema = z.object({
  windowDays: z.number(),
  totalRuns: z.number(),
  completedRuns: z.number(),
  daily: z.array(AutomationRunStatsBucketSchema),
});
