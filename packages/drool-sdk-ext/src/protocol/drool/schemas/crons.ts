import z from 'zod';

const CronExpressionSchema = z
  .string()
  .trim()
  .regex(/^(\S+\s+){4}\S+$/, 'Expected a standard 5-field cron expression');

export const CronCreateToolInputSchema = z.object({
  expression: CronExpressionSchema.describe(
    'Standard 5-field cron expression in local time.'
  ),
  job: z.object({
    type: z.literal('prompt'),
    prompt: z.string().trim().min(1),
  }),
  target: z
    .discriminatedUnion('type', [
      z
        .object({
          type: z.literal('same_session'),
        })
        .describe(
          'Send the prompt back to this same Drool session, for /loop-style reminders.'
        ),
      z
        .object({
          type: z.literal('new_session'),
          cwd: z.string().optional(),
          title: z.string().optional(),
        })
        .describe(
          'Start a new Drool session for a root-scoped cron, for local automation-style reminders.'
        ),
    ])
    .optional(),
  recurring: z.boolean().describe('true for recurring tasks, false for once'),
});

export const CronDeleteToolInputSchema = z.object({
  cronId: z.string().length(8),
});

export const CronListToolInputSchema = z.object({});
