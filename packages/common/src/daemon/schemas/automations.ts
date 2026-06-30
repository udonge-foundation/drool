import z from 'zod';

import { JsonRpcBaseRequestSchema } from '@industry/drool-sdk-ext/protocol/shared';

import { DaemonDroolMethod } from './enums';
import {
  AutomationPrivacyLevel,
  AutomationRunType,
  AutomationTemplateId,
} from '../../automations/enums';

// LIST_AUTOMATIONS - discover automations from the filesystem
const DaemonListAutomationsRequestParamsSchema = z.object({
  basePath: z.string().optional(),
});

export const DaemonListAutomationsRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.LIST_AUTOMATIONS),
    params: DaemonListAutomationsRequestParamsSchema,
  });

export const AutomationEntrySchema = z.object({
  /** Directory name slug (e.g. "health-check"). Kept as `id` because protocol rules forbid renaming required fields. */
  id: z.string(),
  /** Stable UUID from HEARTBEAT.md frontmatter, used for backend/Firestore sync. */
  uuid: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  status: z.string(),
  schedule: z.string().optional(),
  model: z.string().optional(),
  tags: z.array(z.string()).optional(),
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  isValid: z.boolean(),
  path: z.string(),
  /** Template this automation was created from (e.g. `triage`), parsed from HEARTBEAT.md frontmatter. Drives Software Industry SDLC-stage categorization. */
  templateId: z.nativeEnum(AutomationTemplateId).optional(),
  privacyLevel: z.string().optional(),
  createdBy: z
    .object({
      name: z.string(),
      email: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .optional(),
  forkedFrom: z.string().optional(),
  /** Present when the automation targets a remote computer. */
  computerId: z.string().optional(),
  /**
   * Owning machine of the automation: `LOCAL_MACHINE_ID` for the local
   * daemon's own automations, or the computer's id for a computer daemon.
   * The source of truth for whether an automation is local vs. remote
   * (`computerId` cannot distinguish them because BYOM-registered local
   * machines stamp a `computerId` on local automations too).
   */
  machineId: z.string().optional(),
});

export const DaemonListAutomationsResultSchema = z.object({
  automations: z.array(AutomationEntrySchema),
});

// RUN_AUTOMATION - resolve automation metadata so frontend can create a session.
// For local automations: reads HEARTBEAT.md from filesystem.
// For computer automations: fetches from backend API when computerId is present.
const DaemonRunAutomationRequestParamsSchema = z.object({
  automationId: z.string(),
  /** Directory name of the automation (e.g. "health-check"). Preferred over automationId. */
  automationDirName: z.string().optional(),
  basePath: z.string().optional(),
  /** When set, fetches the automation from the backend API instead of local filesystem. */
  computerId: z.string().optional(),
});

export const DaemonRunAutomationRequestSchema = JsonRpcBaseRequestSchema.extend(
  {
    method: z.literal(DaemonDroolMethod.RUN_AUTOMATION),
    params: DaemonRunAutomationRequestParamsSchema,
  }
);

export const DaemonRunAutomationResultSchema = z.object({
  prompt: z.string(),
  automationName: z.string(),
  /** UUID from HEARTBEAT.md frontmatter (falls back to directory name if no UUID) */
  automationId: z.string(),
  /** Template this automation was created from, when known. */
  templateId: z.nativeEnum(AutomationTemplateId).optional(),
  cwd: z.string(),
  model: z.string().optional(),
  /** Present when the automation targets a remote computer. */
  computerId: z.string().optional(),
  /**
   * System-reminder block mapping scaffold-relative paths (VISUAL.html,
   * memory/, reports/) to the automation directory. Present only when the
   * automation's configured `workingDirectory` makes `cwd` differ from the
   * automation directory. Already embedded at the start of `prompt`; exposed
   * separately for consumers that build their own run prompt instead of
   * using `prompt` (e.g. the backend computer-run workflow).
   */
  scaffoldReminder: z.string().optional(),
});

// PAUSE_AUTOMATION
const DaemonPauseAutomationRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  basePath: z.string().optional(),
});

export const DaemonPauseAutomationRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.PAUSE_AUTOMATION),
    params: DaemonPauseAutomationRequestParamsSchema,
  });

export const DaemonPauseAutomationResultSchema = z.object({
  success: z.boolean(),
  automationId: z.string(),
  status: z.string(),
  error: z.string().optional(),
});

// RESUME_AUTOMATION
const DaemonResumeAutomationRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  basePath: z.string().optional(),
});

export const DaemonResumeAutomationRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.RESUME_AUTOMATION),
    params: DaemonResumeAutomationRequestParamsSchema,
  });

export const DaemonResumeAutomationResultSchema = z.object({
  success: z.boolean(),
  automationId: z.string(),
  status: z.string(),
  error: z.string().optional(),
});

// GET_AUTOMATION_HISTORY
const DaemonGetAutomationHistoryRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  basePath: z.string().optional(),
});

export const DaemonGetAutomationHistoryRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.GET_AUTOMATION_HISTORY),
    params: DaemonGetAutomationHistoryRequestParamsSchema,
  });

const AutomationRunRecordSchema = z.object({
  runId: z.string(),
  automationId: z.string(),
  type: z.nativeEnum(AutomationRunType).optional(),
  status: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  errorMessage: z.string().optional(),
  isRetry: z.boolean().optional(),
  originalRunId: z.string().optional(),
  /** Drool session that executed this run, when dispatched as a real session. */
  sessionId: z.string().optional(),
});

export const DaemonGetAutomationHistoryResultSchema = z.object({
  automationId: z.string(),
  runs: z.array(AutomationRunRecordSchema),
  totalCount: z.number(),
});

// GET_AUTOMATION_VISUAL
const DaemonGetAutomationVisualRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  basePath: z.string().optional(),
  sessionId: z.string().optional(),
});

export const DaemonGetAutomationVisualRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.GET_AUTOMATION_VISUAL),
    params: DaemonGetAutomationVisualRequestParamsSchema,
  });

export const DaemonGetAutomationVisualResultSchema = z.object({
  automationId: z.string(),
  exists: z.boolean(),
  content: z.string().optional(),
  isStale: z.boolean().optional(),
  s3Url: z.string().optional(),
});

// CREATE_AUTOMATION
const DaemonCreateAutomationRequestParamsSchema = z.object({
  id: z.string(),
  /** Stable backend UUID to persist into memory/state.json (remote scaffolds). */
  uuid: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  /** Instructions for the agent to follow on every run. */
  instructions: z.string().optional(),
  schedule: z.string(),
  /** Optional model ID to use when running this automation. */
  model: z.string().optional(),
  basePath: z.string().optional(),
  /** Guidance for what the VISUAL.html dashboard should display. */
  visualDescription: z.string().optional(),
  /** Guidance for what the automation should remember across runs. */
  memoryStrategy: z.string().optional(),
  /**
   * Scaffold only: skip the local first-heartbeat run. Used for remote
   * (computer) scaffolds where the run is dispatched by the backend workflow.
   */
  skipFirstRun: z.boolean().optional(),
});

export const DaemonCreateAutomationRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.CREATE_AUTOMATION),
    params: DaemonCreateAutomationRequestParamsSchema,
  });

export const DaemonCreateAutomationResultSchema = z.object({
  success: z.boolean(),
  automationId: z.string().optional(),
  error: z.string().optional(),
});

// UPDATE_AUTOMATION_MODEL - update the model field in HEARTBEAT.md frontmatter
const DaemonUpdateAutomationModelRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  model: z.string().nullable(),
  basePath: z.string().optional(),
});

export const DaemonUpdateAutomationModelRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.UPDATE_AUTOMATION_MODEL),
    params: DaemonUpdateAutomationModelRequestParamsSchema,
  });

export const DaemonUpdateAutomationModelResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// UPDATE_AUTOMATION_PRIVACY - update the privacyLevel field in HEARTBEAT.md frontmatter
const DaemonUpdateAutomationPrivacyRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  privacyLevel: z.nativeEnum(AutomationPrivacyLevel),
  createdBy: z
    .object({
      name: z.string(),
      email: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .optional(),
  basePath: z.string().optional(),
});

export const DaemonUpdateAutomationPrivacyRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.UPDATE_AUTOMATION_PRIVACY),
    params: DaemonUpdateAutomationPrivacyRequestParamsSchema,
  });

export const DaemonUpdateAutomationPrivacyResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// UPDATE_AUTOMATION_PROMPT - update the prompt body in HEARTBEAT.md
const DaemonUpdateAutomationPromptRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  prompt: z.string(),
  basePath: z.string().optional(),
});

export const DaemonUpdateAutomationPromptRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.UPDATE_AUTOMATION_PROMPT),
    params: DaemonUpdateAutomationPromptRequestParamsSchema,
  });

export const DaemonUpdateAutomationPromptResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// UPDATE_AUTOMATION_SCHEDULE - update the schedule field in HEARTBEAT.md
// frontmatter. The schedule is normalized into a 5-part UTC cron expression
// server-side via normalizeAutomationScheduleInput.
const DaemonUpdateAutomationScheduleRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  schedule: z.string(),
  basePath: z.string().optional(),
});

export const DaemonUpdateAutomationScheduleRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.UPDATE_AUTOMATION_SCHEDULE),
    params: DaemonUpdateAutomationScheduleRequestParamsSchema,
  });

export const DaemonUpdateAutomationScheduleResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// RENAME_AUTOMATION - update the name field in HEARTBEAT.md frontmatter
const DaemonRenameAutomationRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  newName: z.string(),
  basePath: z.string().optional(),
});

export const DaemonRenameAutomationRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.RENAME_AUTOMATION),
    params: DaemonRenameAutomationRequestParamsSchema,
  });

export const DaemonRenameAutomationResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// DELETE_AUTOMATION - remove an automation directory
const DaemonDeleteAutomationRequestParamsSchema = z.object({
  automationId: z.string(),
  automationDirName: z.string().optional(),
  basePath: z.string().optional(),
});

export const DaemonDeleteAutomationRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.DELETE_AUTOMATION),
    params: DaemonDeleteAutomationRequestParamsSchema,
  });

export const DaemonDeleteAutomationResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// FORK_AUTOMATION - fork a shared automation into the local filesystem
const DaemonForkAutomationRequestParamsSchema = z.object({
  automationId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  schedule: z.string(),
  tags: z.array(z.string()).optional(),
  model: z.string().optional(),
  prompt: z.string(),
  forkedFrom: z.string(),
  localDirName: z.string(),
});

export const DaemonForkAutomationRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.FORK_AUTOMATION),
    params: DaemonForkAutomationRequestParamsSchema,
  });

export const DaemonForkAutomationResultSchema = z.object({
  success: z.boolean(),
  automationId: z.string().optional(),
  error: z.string().optional(),
});

// APPLY_AUTOMATION_CONFIG - rewrite an existing automation's HEARTBEAT.md so it
// matches the backend (Firestore) record. The backend calls this to push a UI
// edit synchronously to the computer that hosts the automation, so the on-disk
// file (the per-run source of truth) reflects the edit immediately instead of
// waiting for the next run's reconcile. Carries the full editable config so all
// fields (incl. description/tags, which have no per-field RPC) reach the file.
const DaemonApplyAutomationConfigRequestParamsSchema = z.object({
  /** Stable UUID of the automation (matches HEARTBEAT.md frontmatter `id`). */
  automationId: z.string(),
  basePath: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  schedule: z.string(),
  model: z.string().optional(),
  prompt: z.string(),
  tags: z.array(z.string()).optional(),
  privacyLevel: z.nativeEnum(AutomationPrivacyLevel).optional(),
  paused: z.boolean().optional(),
});

export const DaemonApplyAutomationConfigRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.APPLY_AUTOMATION_CONFIG),
    params: DaemonApplyAutomationConfigRequestParamsSchema,
  });

export const DaemonApplyAutomationConfigResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
