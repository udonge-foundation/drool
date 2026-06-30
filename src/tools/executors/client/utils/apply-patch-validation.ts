import { z } from 'zod';

export function validateApplyPatchParameters<T>(
  parameters: unknown,
  schema: z.ZodType<T>
): { data: T; error?: undefined } | { data?: undefined; error: true } {
  const parsed = schema.safeParse(parameters);

  if (!parsed.success) {
    const hasInputIssue = parsed.error.issues.some(
      (issue) => issue.path[0] === 'input'
    );
    if (hasInputIssue) {
      return { error: true };
    }
    throw parsed.error;
  }

  const inputValue = (parsed.data as { input?: unknown }).input;
  if (typeof inputValue !== 'string' || inputValue.trim().length === 0) {
    return { error: true };
  }

  return { data: parsed.data };
}
