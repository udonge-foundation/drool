import { z } from 'zod';

import { IndustryRegion } from '../../shared/enums';

/**
 * Response from `GET /api/cli/whoami`.
 *
 * Identifies the caller behind the bearer credential. Works for
 * both WorkOS JWTs and Industry API keys, since the backend
 * middleware authenticates either via the same Bearer header.
 */
export const WhoamiResponseSchema = z
  .object({
    userId: z.string().min(1).describe('Authenticated WorkOS user ID'),
    orgId: z.string().min(1).describe('Org ID for the user'),
    region: z
      .nativeEnum(IndustryRegion)
      .optional()
      .describe('Residency region the org belongs to'),
  })
  .strict();

export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;
