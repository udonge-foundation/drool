import { z } from 'zod';

import { SquadBoardOperation } from './enums';

export const squadBoardSchema = z.object({
  operation: z
    .nativeEnum(SquadBoardOperation)
    .describe('The squad-board operation.'),
  squadId: z
    .string()
    .optional()
    .describe(
      'Optional squad id. Omit inside squad sessions to use the current squad.'
    ),
  callerAgentId: z
    .string()
    .optional()
    .describe(
      'Optional agent id. Omit inside squad sessions to use the current agent.'
    ),
  channelName: z
    .string()
    .optional()
    .describe('Channel name without the # prefix.'),
  targetAgentId: z.string().optional().describe('Agent to DM.'),
  parentMessageId: z
    .string()
    .optional()
    .describe('Parent message id for thread operations.'),
  content: z.string().optional().describe('Message content to send.'),
  laneId: z.string().optional().describe('Lane id for claim-lane.'),
  description: z
    .string()
    .optional()
    .describe('Lane description for create-lane.'),
  timeoutSeconds: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('How long to wait before returning from wait-for-notification.'),
});

export type SquadBoardInput = z.infer<typeof squadBoardSchema>;
