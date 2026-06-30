import z from 'zod';

import { SkillInfoSchema } from '@industry/drool-sdk-ext/protocol/drool';
import { JsonRpcBaseRequestSchema } from '@industry/drool-sdk-ext/protocol/shared';

import { DaemonDroolMethod } from './enums';

// LIST_SKILLS - get all available skills for a session
const DaemonListSkillsRequestParamsSchema = z.object({
  sessionId: z.string(),
});

export const DaemonListSkillsRequestSchema = JsonRpcBaseRequestSchema.extend({
  method: z.literal(DaemonDroolMethod.LIST_SKILLS),
  params: DaemonListSkillsRequestParamsSchema,
});

export const DaemonListSkillsResultSchema = z.object({
  skills: z.array(SkillInfoSchema),
});
