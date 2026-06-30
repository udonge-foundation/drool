import z from 'zod';

// Tool input schemas must serialize to a JSON Schema with a top-level
// `type: "object"` (the LLM tool-calling APIs reject root-level `anyOf`).
// We therefore model the local/remote variants as a single flat object keyed
// on `executionLocation` and enforce the per-variant required fields with
// `superRefine` instead of a discriminated union.
//
// `executionLocation` selects which computer runs the automation. Today only
//   remote → a cloud automation that runs on another drool computer (v0 API)
// is supported by the agent tools. The local (daemon filesystem) variant is not
// yet wired through the CLI in-process daemon, so it is disabled in
// ExecutionLocationSchema below. Re-add `local` (and restore the local-only edit
// guards in AutomationEditToolInputSchema) once the daemon path lands; the local
// service/actions code is already in place.
const ExecutionLocationSchema = z.enum(['remote']);
const AutomationStatusSchema = z.enum(['active', 'paused']);
const AutomationIdSchema = z.string().trim().min(1);
const PromptSchema = z.string().trim().min(1);

function requireField(
  ctx: z.RefinementCtx,
  field: string,
  message: string
): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
}

// CreateAutomation
export const AutomationCreateToolInputSchema = z
  .object({
    executionLocation: ExecutionLocationSchema.describe(
      'Must be "remote": create a cloud automation that runs on a drool computer. Local automations are not yet supported in the CLI.'
    ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe('Display name for the automation.'),
    schedule: z
      .string()
      .trim()
      .min(1)
      .describe(
        'A 5-field cron expression or natural-language cadence (normalized server-side for remote).'
      ),
    prompt: PromptSchema.describe(
      'Agent instructions to run on each scheduled tick.'
    ),
    description: z
      .string()
      .trim()
      .max(1024)
      .optional()
      .describe('Optional description.'),
    visualization_instruction: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Optional visualization guidance, folded into the run prompt as a "## Visualization" section.'
      ),
    memory_instruction: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Optional memory guidance, folded into the run prompt as a "## Memory & Evolution" section.'
      ),
    computerId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Required: ID of the drool computer the automation runs on.'),
  })
  .superRefine((data, ctx) => {
    if (data.executionLocation === 'remote' && !data.computerId) {
      requireField(
        ctx,
        'computerId',
        'computerId is required when executionLocation is "remote".'
      );
    }
  });

// ListAutomations
export const AutomationListToolInputSchema = z.object({
  executionLocation: ExecutionLocationSchema.describe(
    'Must be "remote": list cloud automations. Local automations are not yet supported in the CLI.'
  ),
});

// ReadAutomation
export const AutomationReadToolInputSchema = z.object({
  executionLocation: ExecutionLocationSchema.describe(
    'Must be "remote": read a cloud automation by id. Local automations are not yet supported in the CLI.'
  ),
  automationId: AutomationIdSchema.describe('Automation id.'),
});

// DeleteAutomation
export const AutomationDeleteToolInputSchema = z.object({
  executionLocation: ExecutionLocationSchema.describe(
    'Must be "remote": delete a cloud automation by id. Local automations are not yet supported in the CLI.'
  ),
  automationId: AutomationIdSchema.describe('Automation id.'),
});

// EditAutomation
export const AutomationEditToolInputSchema = z
  .object({
    executionLocation: ExecutionLocationSchema.describe(
      'Must be "remote": edit a cloud automation by id. Local automations are not yet supported in the CLI.'
    ),
    automationId: AutomationIdSchema.describe('Automation id.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe('New display name.'),
    description: z
      .string()
      .trim()
      .max(1024)
      .optional()
      .describe('New description.'),
    schedule: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('New cron expression or natural-language cadence.'),
    prompt: PromptSchema.optional().describe('New agent instructions.'),
    status: AutomationStatusSchema.optional().describe(
      'New status: "active" or "paused".'
    ),
    computerId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Move the automation to a different computer.'),
  })
  .superRefine((data, ctx) => {
    const hasAnyUpdate =
      data.name !== undefined ||
      data.description !== undefined ||
      data.schedule !== undefined ||
      data.prompt !== undefined ||
      data.status !== undefined ||
      data.computerId !== undefined;
    if (!hasAnyUpdate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least one field to update.',
      });
    }
  });
