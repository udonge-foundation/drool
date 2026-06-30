import z from 'zod';

const ParamsWithSessionIdSchema = z.object({
  sessionId: z.string(),
});

export function tryExtractSessionId(params: unknown): string | undefined {
  const result = ParamsWithSessionIdSchema.safeParse(params);
  return result.success ? result.data.sessionId : undefined;
}
