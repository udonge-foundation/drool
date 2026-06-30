import { z } from 'zod';

import { READINESS_CRITERIA } from '@industry/common/agentReadiness/constants';
import {
  AgentEffectivenessCodingUsageRowSchema,
  AgentEffectivenessDateRangeSchema,
  AgentEffectivenessIsoDateSchema,
  AgentEffectivenessOrganizationTotalSchema,
  AgentEffectivenessUsageRequestSchema,
  AgentEffectivenessUsageResponseSchema,
} from '@industry/common/api/agent-effectiveness';
import { RiskLevel } from '@industry/drool-sdk-ext/protocol/tools';

import {
  deprecatedRepoLocationSchema,
  repoLocationSchema,
} from './file-tools/schema';

export const folderOperationResultSchema = z.object({
  success: z.boolean(),
  repoLocation: deprecatedRepoLocationSchema.optional(),
  folderPath: z.string(),
  content: z
    .string()
    .describe('Directory listing output similar to ls command'),
  repositoryUrl: z.string().optional(),
});

export type FolderOperationResult = z.infer<typeof folderOperationResultSchema>;
// The actual schema sent to LLM

export const viewFolderSchema = z.object({
  repoLocation: repoLocationSchema,
  folderPath: z
    .string()
    .describe(
      `folderPath of the directory to view, relative to the repository root or to the working folder (in case of direct_file_system). Example: 'src/components'.`
    ),
});
export type ViewFolderParams = z.infer<typeof viewFolderSchema>; // The actual schema sent to LLM
export const viewFileSchema = z.object({
  repoLocation: repoLocationSchema,
  filePath: z
    .string()
    .describe(
      `filePath of the file to view, relative to the repository root or to the working folder (in case of direct_file_system).Example: 'src/app/index.ts'.`
    ),
  start: z
    .number()
    .optional()
    .describe(
      'Start line number for viewing the file (1-based, inclusive). Only provide if the file is too large to read at once.'
    ),
  end: z
    .number()
    .optional()
    .describe(
      'End line number for viewing the file (1-based, inclusive). Only provide if the file is too large to read at once.'
    ),
});
export type ViewFileParams = z.infer<typeof viewFileSchema>;

const searchResultFileSchema = z.object({
  filePath: z.string(),
  numberOfLines: z.number().optional(),
});

export const searchToolResultSchema = z.object({
  filePaths: z.array(z.string()).optional(), // To be deprecated in favor of files
  files: z.array(searchResultFileSchema).optional(),
  folderSummaries: z
    .array(
      z.object({
        dirName: z.string(),
        summary: z.string(),
      })
    )
    .optional(),
  isTruncated: z.boolean(),
});

export type SearchResultFile = z.infer<typeof searchResultFileSchema>;

export type SearchToolResult = z.infer<typeof searchToolResultSchema>;

const ExecuteProcessRiskLevelValueSchema = z.nativeEnum(RiskLevel);
const ExecuteProcessRiskLevelObjectSchema = z.object({
  value: ExecuteProcessRiskLevelValueSchema,
  reason: z.string(),
});

const _ExecuteProcessToolParametersSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  riskLevel: z
    .union([
      ExecuteProcessRiskLevelValueSchema,
      ExecuteProcessRiskLevelObjectSchema,
    ])
    .optional(),
});

export type ExecuteProcessRiskLevelWithReason = z.infer<
  typeof ExecuteProcessRiskLevelObjectSchema
>;
export type ExecuteProcessToolParameters = z.infer<
  typeof _ExecuteProcessToolParametersSchema
>;

const _ExecuteProcessToolResultSchema = z.object({
  pid: z.number(),
  isComplete: z.boolean(),
});
export type ExecuteProcessToolResult = z.infer<
  typeof _ExecuteProcessToolResultSchema
>;

// Store Agent Readiness Report Remote Tool Schemas
const signalEvaluationSchema = z.object({
  numerator: z
    .number()
    .min(0)
    .nullable()
    .describe('Number of items that passed the criterion, or null if skipped'),
  denominator: z.number().min(1).describe('Total number of items evaluated'),
  rationale: z.string().min(1).describe('Explanation of the evaluation result'),
});

// Schema that enforces required criterion keys from READINESS_CRITERIA
export const readinessReportSchemaShape = READINESS_CRITERIA.reduce(
  (acc, criterion) => {
    acc[criterion.id] = signalEvaluationSchema;
    return acc;
  },
  {} as Record<string, typeof signalEvaluationSchema>
);

// Enforce strict schema - only allow defined criterion keys
// This prevents the LLM from inventing new criteria names
const readinessReportSchema = z.object(readinessReportSchemaShape).strict();

const appDescriptionSchema = z.object({
  description: z
    .string()
    .describe('Description of what the app does and its purpose'),
});

const appsSchema = z
  .record(z.string().min(1), appDescriptionSchema)
  .describe('Map of app paths to their descriptions for monorepo repositories');

const modelUsedSchema = z.object({
  id: z.string().describe('Model identifier'),
  reasoningEffort: z
    .enum(['low', 'medium', 'high', 'off'])
    .describe('Reasoning effort level used'),
});

export const storeAgentReadinessReportRemoteInputSchema = z.object({
  repoUrl: z
    .string()
    .url()
    .describe(
      'Repository URL (e.g., "https://github.com/owner/repo", "https://gitlab.com/owner/repo")'
    ),
  report: readinessReportSchema.describe(
    `Evaluation results for each criterion - must include all ${READINESS_CRITERIA.length} required keys: ${READINESS_CRITERIA.map((c) => c.id).join(', ')}`
  ),
  apps: appsSchema.optional(),
  commitHash: z
    .string()
    .optional()
    .describe(
      'Git commit hash at the time of report generation (from git rev-parse HEAD)'
    ),
  branch: z
    .string()
    .optional()
    .describe(
      'Git branch name at the time of report generation (from git rev-parse --abbrev-ref HEAD)'
    ),
  hasLocalChanges: z
    .boolean()
    .optional()
    .describe(
      'Whether there were uncommitted local changes (from git status --porcelain)'
    ),
  hasNonRemoteCommits: z
    .boolean()
    .optional()
    .describe(
      'Whether there were commits not pushed to remote (from git rev-list @{u}..HEAD --count)'
    ),
  modelUsed: modelUsedSchema
    .optional()
    .describe('Model and reasoning level used to generate the report'),
  droolVersion: z
    .string()
    .optional()
    .describe('Version of the drool/CLI that generated the report'),
});

export const storeAgentReadinessReportRemoteOutputSchema = z.object({
  success: z.boolean().describe('Whether the report was successfully stored'),
  reportId: z.string().describe('UUID of the created report'),
  message: z.string().describe('Success or error message'),
});

export const getAgentEffectivenessUsageInputSchema =
  AgentEffectivenessUsageRequestSchema.describe(
    'Fetch Industry usage metrics for the current authenticated organization. For custom dateRange, startDate and endDate are required.'
  );

export const getAgentEffectivenessUsageOutputSchema =
  AgentEffectivenessUsageResponseSchema;

const agentEffectivenessWorkItemSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  assigneeEmail: z.string().optional(),
  assigneeName: z.string().optional(),
  storyPoints: z.number().optional(),
  status: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  linkedPrIds: z.array(z.string()).default([]),
});

const agentEffectivenessPullRequestSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  repo: z.string().optional(),
  authorEmail: z.string().optional(),
  authorEmails: z.array(z.string()).optional(),
  authorLogin: z.string().optional(),
  authorName: z.string().optional(),
  mergedAt: z.string().optional(),
  additions: z.number(),
  deletions: z.number(),
  testFileChanges: z.number(),
  linkedWorkItemIds: z.array(z.string()).default([]),
  industrySessionIds: z.array(z.string()).default([]),
  aiAssisted: z.boolean().optional(),
  majorRework: z.boolean().optional(),
  defectLinked: z.boolean().optional(),
});

const resolvedAgentEffectivenessReportRequestSchema = z.object({
  orgId: z.string(),
  orgName: z.string().optional(),
  sourceType: z.enum(['upload', 'integration']),
  dateRange: AgentEffectivenessDateRangeSchema,
  startDate: AgentEffectivenessIsoDateSchema,
  endDate: AgentEffectivenessIsoDateSchema,
  workItems: z.array(agentEffectivenessWorkItemSchema),
  pullRequests: z.array(agentEffectivenessPullRequestSchema),
  checkedRepositories: z.array(z.string()),
  identityAliases: z
    .record(z.string())
    .optional()
    .describe(
      'Optional aliasEmail -> canonicalEmail lookup. When provided, the renderer canonicalizes every email on usage rows, work items, and pull requests before joining so aliases collapse onto a single row instead of appearing as separate users.'
    ),
  options: z.object({
    includeHtml: z.boolean().default(true),
    currency: z.string().default('USD'),
    fscUnitCostUsd: z.number().optional(),
  }),
});

const agentEffectivenessDailyUsageRowsSchema = z.object({
  date: AgentEffectivenessIsoDateSchema,
  usageRows: z.array(AgentEffectivenessCodingUsageRowSchema),
});

export const renderAgentEffectivenessReportInputSchema = z
  .object({
    request: resolvedAgentEffectivenessReportRequestSchema,
    codingUsage: z.array(AgentEffectivenessCodingUsageRowSchema),
    totalUsage: AgentEffectivenessOrganizationTotalSchema.optional().describe(
      'Unfiltered org-wide token/session totals returned alongside `codingUsage` by `get_agent_effectiveness_usage`. When provided, the renderer uses this for the headline "Industry credits" card while every chart, scatter plot, ratio, and per-user table cell continues to use the filtered `codingUsage` rows.'
    ),
    dailyUsageRows: z.array(agentEffectivenessDailyUsageRowsSchema),
  })
  .strict()
  .describe(
    'Render and save the local Agent Effectiveness HTML report from already-collected Industry usage, pull request, work-item, repository, and daily usage data.'
  );

export const renderAgentEffectivenessReportOutputSchema = z.object({
  filename: z.string(),
  path: z.string(),
  fileUrl: z.string(),
  trendPointCount: z.number(),
  message: z.string(),
});

export type StoreAgentReadinessReportRemoteInput = z.infer<
  typeof storeAgentReadinessReportRemoteInputSchema
>;

export type StoreAgentReadinessReportRemoteOutput = z.infer<
  typeof storeAgentReadinessReportRemoteOutputSchema
>;

export type GetAgentEffectivenessUsageInput = z.infer<
  typeof getAgentEffectivenessUsageInputSchema
>;

export type GetAgentEffectivenessUsageOutput = z.infer<
  typeof getAgentEffectivenessUsageOutputSchema
>;

export type RenderAgentEffectivenessReportInput = z.infer<
  typeof renderAgentEffectivenessReportInputSchema
>;

export type RenderAgentEffectivenessReportOutput = z.infer<
  typeof renderAgentEffectivenessReportOutputSchema
>;
