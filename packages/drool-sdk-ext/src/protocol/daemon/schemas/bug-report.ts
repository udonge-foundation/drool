import z from 'zod';

import { JsonRpcBaseRequestSchema } from '@industry/drool-sdk-ext/protocol/shared';

import { DaemonDroolMethod } from './enums';

// SUBMIT_BUG_REPORT - create and upload a bug report
const DaemonSubmitBugReportRequestParamsSchema = z.object({
  sessionId: z.string(),
  userComment: z.string(),
  clientLogs: z.string().optional(),
});

export const DaemonSubmitBugReportRequestSchema =
  JsonRpcBaseRequestSchema.extend({
    method: z.literal(DaemonDroolMethod.SUBMIT_BUG_REPORT),
    params: DaemonSubmitBugReportRequestParamsSchema,
  });

export const DaemonSubmitBugReportResultSchema = z.object({
  bugReportId: z.string(),
});
