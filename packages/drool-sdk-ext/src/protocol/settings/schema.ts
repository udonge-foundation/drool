import { z } from 'zod';

import { SandboxMode } from './enums';
import {
  ModelID,
  ModelProvider,
  ReasoningEffort,
  ROUTER_MODEL_IDS,
} from '../llm';
import { McpOAuthTokenEndpointAuthMethod } from '../mcp-oauth/enums';

import type { BuiltInModelID } from '../llm';

const ReasoningEffortSchema = z.nativeEnum(ReasoningEffort);

// =============================================================================
// MCP OAuth Schema
// =============================================================================

const MCP_OAUTH_CLIENT_METADATA_DOT_SEGMENT_RE =
  /(?:^|\/)(?:\.\.|\.(?:%2e)?|%2e(?:\.|%2e)?)(?:\/|$|[?#])/i;

function isValidMcpOAuthClientMetadataUrl(url: string): boolean {
  if (MCP_OAUTH_CLIENT_METADATA_DOT_SEGMENT_RE.test(url)) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return (
    parsed.protocol === 'https:' &&
    parsed.pathname !== '/' &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash
  );
}

export const McpOAuthOptionsSchema = z
  .object({
    scopes: z.array(z.string().trim().min(1)).optional(),
    authorizationServerIssuer: z.string().url().optional(),
    clientMetadataUrl: z
      .string()
      .url()
      .refine(isValidMcpOAuthClientMetadataUrl, {
        message:
          'clientMetadataUrl must be an HTTPS URL with a non-root pathname, no credentials, query, fragment, or dot segments',
      })
      .optional(),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z
      .string()
      .min(1)
      .refine((secret) => secret.trim().length > 0, {
        message: 'clientSecret cannot be blank',
      })
      .optional(),
    callbackPort: z.number().int().min(1).max(65535).optional(),
    tokenEndpointAuthMethod: z
      .nativeEnum(McpOAuthTokenEndpointAuthMethod)
      .optional(),
  })
  .superRefine((oauth, context) => {
    if (oauth.clientMetadataUrl && (oauth.clientId || oauth.clientSecret)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'clientMetadataUrl cannot be combined with configured OAuth client credentials',
        path: ['clientMetadataUrl'],
      });
    }
    if (
      oauth.clientMetadataUrl &&
      oauth.tokenEndpointAuthMethod &&
      oauth.tokenEndpointAuthMethod !== McpOAuthTokenEndpointAuthMethod.None
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'clientMetadataUrl requires public OAuth token endpoint authentication',
        path: ['clientMetadataUrl'],
      });
    }
    if (
      (oauth.clientId || oauth.clientSecret) &&
      !oauth.authorizationServerIssuer
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'authorizationServerIssuer is required with configured OAuth client credentials',
        path: ['authorizationServerIssuer'],
      });
    }
  });

export const McpOAuthConfigSchema = z.union([
  z.literal(false),
  McpOAuthOptionsSchema,
]);

const BuiltInModelIDSchema = z.custom<BuiltInModelID>(
  (value) =>
    typeof value === 'string' &&
    Object.values(ModelID).some((modelId) => modelId === value) &&
    !ROUTER_MODEL_IDS.some((routerId) => routerId === value)
);

// =============================================================================
// Custom Model Schema (for managed/org-provisioned models)
// =============================================================================

const CustomModelBedrockSchema = z.object({
  awsProfile: z.string().optional(),
  awsRegion: z.string().min(1).optional(),
  bedrockBaseUrl: z.string().url().optional(),
  awsAuthRefresh: z.string().optional(),
  awsCredentialExport: z.string().optional(),
});

export const ManagedCustomModelSchema = z
  .object({
    model: z.string(),
    id: z.string().optional(),
    index: z.number().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    provider: z.nativeEnum(ModelProvider),
    displayName: z.string().optional(),
    maxContextLimit: z.number().optional(),
    enableThinking: z.boolean().optional(),
    thinkingMaxTokens: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    extraHeaders: z.record(z.string()).optional(),
    extraArgs: z.record(z.unknown()).optional(),
    noImageSupport: z.boolean().optional(),
    bedrock: CustomModelBedrockSchema.optional(),
    baseModelId: BuiltInModelIDSchema.optional(),
    useInRouter: z.boolean().optional(),
  })
  .superRefine((model, ctx) => {
    if (model.provider === ModelProvider.BEDROCK_CONVERSE && !model.bedrock) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bedrock'],
        message:
          'bedrock-converse custom models require a bedrock configuration block',
      });
      return;
    }
    if (model.bedrock) {
      if (
        model.provider !== ModelProvider.ANTHROPIC &&
        model.provider !== ModelProvider.BEDROCK_CONVERSE &&
        model.provider !== ModelProvider.OPENAI
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['provider'],
          message:
            'bedrock custom models require provider "anthropic", "bedrock-converse", or "openai"',
        });
      }
      return;
    }
    if (!model.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'baseUrl is required unless bedrock is configured',
      });
    }
    if (!model.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: 'apiKey is required unless bedrock is configured',
      });
    }
  });

export const CustomModelsSchema = z.array(ManagedCustomModelSchema);

// =============================================================================
// Sandbox Settings Schema
// =============================================================================

export const SandboxModeSchema = z.nativeEnum(SandboxMode);

// =============================================================================
// Mission Model Settings Schema
// =============================================================================

export const MissionModelSettingsSchema = z.object({
  workerModel: z.string().optional(),
  workerReasoningEffort: ReasoningEffortSchema.optional(),
  validationWorkerModel: z.string().optional(),
  validationWorkerReasoningEffort: ReasoningEffortSchema.optional(),
  skipScrutiny: z.boolean().optional(),
  skipUserTesting: z.boolean().optional(),
});
