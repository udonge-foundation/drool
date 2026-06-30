import z from 'zod';

import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  JsonRpcBaseNotificationSchema,
  JsonRpcBaseRequestSchema,
} from '@industry/drool-sdk-ext/protocol/shared';

import { DaemonDroolMethod, DaemonCronEvent } from './enums';

export const CronStatusSchema = z.enum([
  'active',
  'held',
  'paused',
  'running',
  'error',
  'expired',
  'cancelled',
]);

export const CronKindSchema = z.enum(['session_prompt', 'root_prompt']);

const CronSourceSchema = z.enum([
  'loop_command',
  'cron_tool',
  'automation',
  'migration',
]);

const UserUpdatableCronStatusSchema = z.enum(['active', 'paused']);

const CronSessionScopeSchema = z.object({
  type: z.literal('session'),
  sessionId: z.string(),
  sessionCwd: z.string(),
  storageDir: z.string(),
});

const CronRootScopeSchema = z.object({
  type: z.literal('root'),
});

export const CronScopeSchema = z.discriminatedUnion('type', [
  CronSessionScopeSchema,
  CronRootScopeSchema,
]);

const CronCreateSessionScopeSchema = z.object({
  type: z.literal('session'),
  sessionId: z.string(),
  sessionCwd: z.string(),
});

const CronCreateRootScopeSchema = z.object({
  type: z.literal('root'),
});

export const CronCreateScopeSchema = z.discriminatedUnion('type', [
  CronCreateSessionScopeSchema,
  CronCreateRootScopeSchema,
]);

const SameSessionPromptPayloadSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string().trim().min(1),
  target: z.object({
    type: z.literal('same_session'),
  }),
});

const NewSessionPromptPayloadSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string().trim().min(1),
  target: z.object({
    type: z.literal('new_session'),
    cwd: z.string().optional(),
    title: z.string().optional(),
  }),
  modelId: z.string().optional(),
  reasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
});

export const CronPayloadSchema = z.union([
  SameSessionPromptPayloadSchema,
  NewSessionPromptPayloadSchema,
]);

const CronRecordBaseSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  status: CronStatusSchema,
  source: CronSourceSchema,
  schedule: z.object({
    expression: z.string().trim().min(1),
    recurring: z.boolean(),
    nextRunAt: z.string().optional(),
    firstFireGuardUntil: z.string().optional(),
    timezone: z.literal('UTC'),
  }),
  stats: z.object({
    fireCount: z.number().int().nonnegative(),
    lastRunAt: z.string().optional(),
    lastCompletedAt: z.string().optional(),
    lastError: z.string().optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  heldAt: z.string().optional(),
  holdReason: z.string().optional(),
});

const SessionCronRecordSchema = CronRecordBaseSchema.extend({
  kind: z.literal('session_prompt'),
  scope: CronSessionScopeSchema,
  runPolicy: z.object({
    whenSessionInactive: z.literal('hold'),
  }),
  payload: SameSessionPromptPayloadSchema,
});

const RootCronRecordSchema = CronRecordBaseSchema.extend({
  kind: z.literal('root_prompt'),
  scope: CronRootScopeSchema,
  runPolicy: z.object({
    whenSessionInactive: z.literal('run_in_background'),
  }),
  payload: NewSessionPromptPayloadSchema,
});

export const CronRecordSchema = z.discriminatedUnion('kind', [
  SessionCronRecordSchema,
  RootCronRecordSchema,
]);

export const DaemonListCronsRequestParamsSchema = z.object({
  sessionId: z.string().optional(),
  includeInactive: z.boolean().optional(),
});

export const DaemonListCronsRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DaemonDroolMethod.LIST_CRONS),
  params: DaemonListCronsRequestParamsSchema,
});

export const DaemonListCronsResultSchema = z.object({
  crons: z.array(CronRecordSchema),
});

const DaemonCreateCronRequestBaseParamsSchema = z.object({
  source: CronSourceSchema,
  schedule: z.object({
    expression: z.string().trim().min(1),
    recurring: z.boolean(),
  }),
  runImmediately: z.boolean().optional(),
});

export const DaemonCreateCronRequestParamsSchema = z.discriminatedUnion(
  'kind',
  [
    DaemonCreateCronRequestBaseParamsSchema.extend({
      kind: z.literal('session_prompt'),
      scope: CronCreateSessionScopeSchema,
      runPolicy: z
        .object({
          whenSessionInactive: z.literal('hold'),
        })
        .optional(),
      payload: SameSessionPromptPayloadSchema,
    }),
    DaemonCreateCronRequestBaseParamsSchema.extend({
      kind: z.literal('root_prompt'),
      scope: CronCreateRootScopeSchema,
      runPolicy: z
        .object({
          whenSessionInactive: z.literal('run_in_background'),
        })
        .optional(),
      payload: NewSessionPromptPayloadSchema,
    }),
  ]
);

const CronUpdatePayloadPatchSchema = z
  .object({
    prompt: z.string().trim().min(1).optional(),
  })
  .strict();

export const DaemonUpdateCronRequestParamsSchema = z.object({
  cronId: z.string(),
  status: UserUpdatableCronStatusSchema.optional(),
  schedule: z
    .object({
      expression: z.string().trim().min(1),
      recurring: z.boolean(),
    })
    .optional(),
  payload: CronUpdatePayloadPatchSchema.optional(),
});

export const DaemonUpdateCronRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DaemonDroolMethod.UPDATE_CRON),
  params: DaemonUpdateCronRequestParamsSchema,
});

export const DaemonUpdateCronResultSchema = z.object({
  cron: CronRecordSchema.nullable(),
});

export const DaemonCreateCronRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DaemonDroolMethod.CREATE_CRON),
  params: DaemonCreateCronRequestParamsSchema,
});

export const DaemonCreateCronResultSchema = z.object({
  cron: CronRecordSchema,
});

export const DaemonDeleteCronRequestParamsSchema = z.object({
  cronId: z.string(),
  sessionId: z.string().optional(),
});

export const DaemonDeleteCronRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DaemonDroolMethod.DELETE_CRON),
  params: DaemonDeleteCronRequestParamsSchema,
});

export const DaemonDeleteCronResultSchema = z.object({
  deleted: z.boolean(),
});

export const DaemonHoldSessionCronsRequestParamsSchema = z.object({
  sessionId: z.string(),
  reason: z.string(),
});

export const DaemonHoldSessionCronsRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.HOLD_SESSION_CRONS),
    params: DaemonHoldSessionCronsRequestParamsSchema,
  });

export const DaemonHoldSessionCronsResultSchema = z.object({
  heldCount: z.number().int().nonnegative(),
});

export const DaemonResumeSessionCronsRequestParamsSchema = z.object({
  sessionId: z.string(),
});

export const DaemonResumeSessionCronsRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.RESUME_SESSION_CRONS),
    params: DaemonResumeSessionCronsRequestParamsSchema,
  });

export const DaemonResumeSessionCronsResultSchema = z.object({
  resumedCount: z.number().int().nonnegative(),
});

export const DaemonCronStateChangedNotificationParamsSchema = z.object({
  reason: z.enum(['created', 'updated', 'deleted']),
  cronIds: z.array(z.string()),
  crons: z.array(CronRecordSchema).optional(),
});

export const DaemonCronStateChangedNotificationSchema =
  JsonRpcBaseNotificationSchema.extend({
    method: z.literal(DaemonCronEvent.STATE_CHANGED),
    params: DaemonCronStateChangedNotificationParamsSchema,
  });
