import z from 'zod';

import { CustomCommandInfoSchema } from '@industry/drool-sdk-ext/protocol/drool';
import { JsonRpcBaseRequestSchema } from '@industry/drool-sdk-ext/protocol/shared';

import { DaemonDroolMethod } from './enums';

// LIST_COMMANDS - get all custom slash commands for a session
const DaemonListCommandsRequestParamsSchema = z.object({
  sessionId: z.string(),
});

export const DaemonListCommandsRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DaemonDroolMethod.LIST_COMMANDS),
  params: DaemonListCommandsRequestParamsSchema,
});

export const DaemonListCommandsResultSchema = z.object({
  commands: z.array(CustomCommandInfoSchema),
});
