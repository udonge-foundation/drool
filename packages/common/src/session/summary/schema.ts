import { z } from 'zod';

import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { HostIdSchema } from '@industry/drool-sdk-ext/protocol/host';

import { SessionTitleAutoStage } from './enums';

/**
 * Schema for the first line (session_start event) of a session .jsonl file.
 * This is the canonical definition of the session summary format on disk.
 */
export const SessionSummaryEventSchema = z.object({
  type: z.literal('session_start'),
  id: z.string(),
  title: z.string(),
  sessionTitle: z.string().optional(),
  isSessionTitleManuallySet: z.boolean().optional(),
  sessionTitleAutoStage: z.nativeEnum(SessionTitleAutoStage).optional(),
  owner: z.string(),
  parent: z.string().nullable().optional(),
  version: z.number().optional(),
  cwd: z.string().optional(),
  lastCwd: z.string().optional(),
  decompSessionType: z.nativeEnum(DecompSessionType).optional(),
  decompMissionId: z.string().optional(),
  callingSessionId: z.string().optional(),
  callingToolUseId: z.string().optional(),
  // Durable execution-store identity for this local session file.
  hostId: HostIdSchema.optional(),
});

export type SessionSummaryEvent = z.infer<typeof SessionSummaryEventSchema>;
