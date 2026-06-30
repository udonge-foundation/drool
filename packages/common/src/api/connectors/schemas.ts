import { z } from 'zod';

import type {
  CallConnectorToolResponse,
  ConnectorTool,
  ListConnectorToolsResponse,
} from './types';

export const CreateConnectorLinkRequestSchema = z.object({
  connector: z.string().min(1),
});

export const DisconnectConnectorRequestSchema = z.object({
  connector: z.string().min(1),
});

export const ListConnectorToolsRequestSchema = z.object({
  authenticatedOnly: z.boolean().optional(),
  discoveryOnly: z.boolean().optional(),
});

export const CallConnectorToolRequestSchema = z.object({
  toolName: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
});

export const SetOrgConnectorRequestSchema = z.object({
  connector: z.string().min(1),
  enabled: z.boolean(),
});

// Response schemas are annotated with the contract types from `types.ts` so
// the compiler flags any drift between the two.
const ConnectorToolSchema: z.ZodType<ConnectorTool> = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
});

export const ListConnectorToolsResponseSchema: z.ZodType<ListConnectorToolsResponse> =
  z.object({
    tools: z.array(ConnectorToolSchema),
  });

export const CallConnectorToolResponseSchema: z.ZodType<CallConnectorToolResponse> =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('success'),
      content: z.string(),
    }),
    z.object({
      status: z.literal('authentication_required'),
      connector: z.string(),
      magicLinkUrl: z.string(),
      message: z.string(),
    }),
  ]);
