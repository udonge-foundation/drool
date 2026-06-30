import { z } from 'zod';

import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const generateDroolSchema = z.object({
  description: z
    .string()
    .min(10)
    .describe(
      'Comprehensive description of what this drool should do and when it should be used'
    ),
  location: z
    .enum(['project', 'personal'])
    .default('project')
    .describe(
      'Where to save the drool: project (.industry/drools) or personal (~/.industry/drools)'
    ),
});

const generateDroolOutputSchema = z.object({
  identifier: z
    .string()
    .regex(/^[a-z0-9-_]+$/)
    .describe('Unique kebab-case identifier (e.g., "security-code-reviewer")'),
  description: z
    .string()
    .min(120)
    .describe(
      "Expanded multi-sentence summary of the drool's responsibilities and scope"
    ),
  systemPrompt: z
    .string()
    .min(200)
    .describe(
      "Comprehensive system prompt defining the drool's specific role and behavior"
    ),
});

export const generateDroolCliTool = createTool({
  id: 'generate-drool-cli',
  llmId: 'GenerateDrool',
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Generate Drool Configuration',
  description:
    'Generate a custom drool configuration based on your description using AI',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: generateDroolSchema,
  outputSchemas: {
    result: generateDroolOutputSchema,
  },
  isVisibleToUser: false,
  isTopLevelTool: false,
  requiresConfirmation: false,
  // The executor only calls the Industry LLM API and returns the generated
  // config; persisting it to disk happens through the regular file tools,
  // which carry their own sandbox checks.
  sideEffects: [SandboxSideEffect.ExternalService],
  toolkit: Toolkit.Base,
  deferred: true,
  isToolEnabled: true,
});
