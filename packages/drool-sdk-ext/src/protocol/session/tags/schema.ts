import { z } from 'zod';

import type { DecompSessionType } from '../../drool/enums';

export const SessionTagSchema = z.object({
  name: z.string().min(1),
  metadata: z.record(z.string()).optional(),
});

export type SessionTag = z.infer<typeof SessionTagSchema>;

export interface MissionSessionTagMetadata {
  role: DecompSessionType;
  missionId: string;
}
