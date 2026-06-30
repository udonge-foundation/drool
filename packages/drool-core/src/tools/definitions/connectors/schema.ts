import { z } from 'zod';

export const connectorSearchSchema = z.object({
  action: z
    .enum(['list_tools', 'call_tool'])
    .describe(
      'Use "list_tools" to discover the connector tools available to the user (grouped by connector, with compact argument hints), or "call_tool" to run one.'
    ),
  toolName: z
    .string()
    .optional()
    .describe(
      'The fully-qualified connector tool name (e.g. "github__list_pull_requests"). Required when action is "call_tool". When provided with "list_tools", returns the full input schema for just that tool.'
    ),
  toolArguments: z
    .record(z.unknown())
    .optional()
    .describe(
      'Arguments object for the connector tool, matching its input schema. Used when action is "call_tool".'
    ),
  authenticatedOnly: z
    .boolean()
    .optional()
    .describe(
      'When action is "list_tools", set true to only return tools for connectors the user has already authenticated.'
    ),
});

export type ConnectorSearchParams = z.infer<typeof connectorSearchSchema>;
