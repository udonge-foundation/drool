import z from 'zod';

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const AgentEffectivenessIsoDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN)
  .refine(isValidIsoDate, { message: 'Invalid calendar date' });

export const AgentEffectivenessDateRangeSchema = z.enum([
  'custom',
  'lifetime',
  'last_30_days',
  'last_90_days',
]);

export const AgentEffectivenessUsageRequestSchema = z
  .object({
    dateRange: AgentEffectivenessDateRangeSchema.default('custom'),
    startDate: AgentEffectivenessIsoDateSchema.optional(),
    endDate: AgentEffectivenessIsoDateSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.dateRange === 'custom' &&
      (!request.startDate || !request.endDate)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startDate and endDate are required when dateRange is custom',
        path: ['startDate'],
      });
    }
  });

export const AgentEffectivenessCodingUsageRowSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
  userEmail: z.string().nullable(),
  sessions: z.number(),
  billingEvents: z.number(),
  billableTokens: z.number(),
  droolCommits: z.number(),
  droolPrsCreated: z.number(),
  toolCalls: z.number(),
  skillCalls: z.number(),
  fileOperations: z.number(),
});

export const AgentEffectivenessOrganizationTotalSchema = z.object({
  organizationId: z.string(),
  sessions: z.number(),
  billingEvents: z.number(),
  billableTokens: z.number(),
});

export const AgentEffectivenessReportEntitlementResponseSchema = z.object({
  enabled: z.boolean(),
  organizationId: z.string(),
  organizationName: z.string().optional(),
  supportedDateRanges: z.array(AgentEffectivenessDateRangeSchema).optional(),
  maxDateRangeDays: z.number().positive().optional(),
});

export const AgentEffectivenessUsageResponseSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  generatedAt: z.string(),
  codingUsage: z.array(AgentEffectivenessCodingUsageRowSchema),
  totalUsage: AgentEffectivenessOrganizationTotalSchema.optional(),
});

export const AgentEffectivenessRecentRunResponseSchema = z.object({
  /** Whether the org had at least one qualifying agent-effectiveness run in the trailing window. */
  hadRunInLastWeek: z.boolean(),
});
