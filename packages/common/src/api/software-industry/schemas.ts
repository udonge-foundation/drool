import { z } from 'zod';

export const SoftwareIndustryRangeSchema = z.enum(['7d', '30d', '90d']);

export const SoftwareIndustryMetricsQuerySchema = z
  .object({
    range: SoftwareIndustryRangeSchema.optional().default('7d'),
  })
  .strict();

export const SoftwareIndustryTriageInputReportSchema = z
  .object({
    automationId: z.string().min(1),
    runId: z.string().min(1),
    messagesConsumed: z.number().int().nonnegative(),
    occurredAt: z.number().int().positive(),
  })
  .strict();

export const SoftwareIndustryTriageInputReportResponseSchema = z.object({
  ok: z.literal(true),
});

export const SoftwareIndustryMetricPointSchema = z.object({
  date: z.string(),
  label: z.string(),
  value: z.number(),
});

export const SoftwareIndustryMetricSchema = z.object({
  value: z.number(),
  previousValue: z.number(),
  changePercentage: z.number().nullable(),
  data: z.array(SoftwareIndustryMetricPointSchema),
});

export const SoftwareIndustryStageMetricStatusSchema = z.object({
  label: z.string(),
  kind: z.enum(['healthy', 'partial', 'unhealthy']),
  healthy: z.number(),
  total: z.number(),
});

export const SoftwareIndustryStageMetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  valueLabel: z.string(),
  tooltip: z.string().optional(),
  tone: z.enum(['default', 'orange']).optional(),
  data: SoftwareIndustryMetricSchema,
  status: SoftwareIndustryStageMetricStatusSchema.optional(),
});

export const SoftwareIndustryStageMetricsDataSchema = z.object({
  stage: z.enum(['triage', 'codegen', 'validate', 'docs', 'monitor']),
  metrics: z.array(SoftwareIndustryStageMetricSchema),
});

export const SoftwareIndustryWorkflowRunsRepositorySchema = z.object({
  fullName: z.string(),
  configured: z.boolean(),
  value: z.number(),
  lastRunAt: z.string().nullable(),
});

export const SoftwareIndustryWorkflowRunsRepositorySeriesSchema = z.record(
  SoftwareIndustryMetricSchema
);

export const SoftwareIndustryPrsValidatedBreakdownSchema = z.object({
  qa: z.number(),
  codeReview: z.number(),
});

export const SoftwareIndustryPrsValidatedRepositorySchema = z.object({
  fullName: z.string(),
  qaConfigured: z.boolean(),
  codeReviewConfigured: z.boolean(),
  qa: z.number(),
  codeReview: z.number(),
  value: z.number(),
  qaLastRunAt: z.string().nullable(),
  codeReviewLastRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
});

export const SoftwareIndustryPrsValidatedSeriesSchema = z.object({
  qa: SoftwareIndustryMetricSchema,
  codeReview: SoftwareIndustryMetricSchema,
});

export const SoftwareIndustryPrsValidatedRepositorySeriesSchema = z.record(
  SoftwareIndustryPrsValidatedSeriesSchema
);

export const SoftwareIndustryMetricMetaSchema = z.object({
  org_id: z.string(),
  range: SoftwareIndustryRangeSchema,
  start_date: z.string(),
  end_date: z.string(),
  previous_start_date: z.string(),
  previous_end_date: z.string(),
  refreshed_at: z.number(),
  cache_ttl_ms: z.number(),
});

export const SoftwareIndustryMetricResponseSchema = z.object({
  data: SoftwareIndustryMetricSchema,
  meta: SoftwareIndustryMetricMetaSchema,
});

export const SoftwareIndustryStageMetricsResponseSchema = z.object({
  data: SoftwareIndustryStageMetricsDataSchema,
  meta: SoftwareIndustryMetricMetaSchema,
});

export const SoftwareIndustryWorkflowRunsResponseSchema = z.object({
  data: SoftwareIndustryMetricSchema,
  repositories: z.array(SoftwareIndustryWorkflowRunsRepositorySchema).optional(),
  repositorySeries:
    SoftwareIndustryWorkflowRunsRepositorySeriesSchema.optional(),
  meta: SoftwareIndustryMetricMetaSchema,
});

export const SoftwareIndustryPrsValidatedResponseSchema = z.object({
  data: SoftwareIndustryMetricSchema,
  breakdown: SoftwareIndustryPrsValidatedBreakdownSchema,
  repositories: z.array(SoftwareIndustryPrsValidatedRepositorySchema).optional(),
  series: SoftwareIndustryPrsValidatedSeriesSchema.optional(),
  repositorySeries:
    SoftwareIndustryPrsValidatedRepositorySeriesSchema.optional(),
  meta: SoftwareIndustryMetricMetaSchema,
});
