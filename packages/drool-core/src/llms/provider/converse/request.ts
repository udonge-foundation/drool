/**
 * Pure, transport-agnostic request conversion for the AWS Bedrock
 * **Converse** API.
 *
 * Consumes the Drool message type (`IndustryDroolMessage`) directly and
 * emits the native Converse schema — there is NO runtime dependency on the
 * Anthropic message pipeline. Keeping this pure means a future server-side
 * built-in Converse route (SigV4 in `apps/backend`) can reuse it verbatim.
 *
 * Parallel to `convertDroolToOpenAiChatMessages` in
 * `../../client/converters.ts`.
 */
import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  type ContentBlock as DroolContentBlock,
  type IndustryDroolMessage,
  type ImageBlock,
  type TextBlock as DroolTextBlock,
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  clampMaxTokensAboveThinkingBudget,
  getClaudeReasoningTokens,
} from '@industry/utils/llm';
import { getCustomModelSupportedEfforts } from '@industry/utils/models';

import { PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH } from '../../client/constants';
import { sanitizeToolNameForProvider } from '../../client/tool-call-ids';

import type {
  ContentBlock as ConverseContentBlock,
  ConverseStreamCommandInput,
  ImageFormat,
  Message as ConverseMessage,
  SystemContentBlock,
  Tool as ConverseTool,
  ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { CustomModel } from '@industry/common/settings';
import type { DocumentType } from '@smithy/types';

interface ConvertDroolToConverseMessagesOptions {
  includeReasoning?: boolean;
  includeUnsignedReasoning?: boolean;
}

interface BuildConverseRequestParams {
  modelId: string;
  messages: IndustryDroolMessage[];
  systemMessage: DroolTextBlock[];
  tools: ConverseTool[];
  customModel?: CustomModel | null;
  reasoningEffort?: ReasoningEffort;
  maxTokensOverride?: number;
  temperature?: number;
  stopSequences?: string[];
}

type ConverseRole = 'user' | 'assistant';

const IMAGE_MEDIA_TYPE_TO_FORMAT: Record<string, ImageFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function base64ToBytes(data: string): Uint8Array {
  return Buffer.from(data, 'base64');
}

function imageBlockToConverse(
  block: ImageBlock
): ConverseContentBlock | undefined {
  if (block.source.type !== 'base64') return undefined;
  const format = IMAGE_MEDIA_TYPE_TO_FORMAT[block.source.mediaType];
  if (!format) return undefined;
  return {
    image: {
      format,
      source: { bytes: base64ToBytes(block.source.data) },
    },
  };
}

function toolResultContent(content: unknown): ToolResultContentBlock[] {
  if (typeof content === 'string') {
    return [{ text: content || 'Tool executed successfully' }];
  }
  if (!Array.isArray(content)) {
    return [{ text: 'Tool executed successfully' }];
  }
  const blocks: ToolResultContentBlock[] = [];
  for (const c of content as DroolContentBlock[]) {
    if (c.type === MessageContentBlockType.Text) {
      blocks.push({ text: c.text });
    } else if (c.type === MessageContentBlockType.Image) {
      const img = imageBlockToConverse(c);
      if (img?.image) blocks.push({ image: img.image });
    }
    // Documents are intentionally out of scope for Converse v1.
  }
  return blocks.length > 0 ? blocks : [{ text: 'Tool executed successfully' }];
}

/**
 * Converts the Drool conversation history into Converse `messages`.
 *
 * - text                -> `{ text }`
 * - image (base64)      -> `{ image: { format, source: { bytes } } }`
 * - tool_use            -> `{ toolUse }`            (assistant)
 * - tool_result / tool  -> `{ toolResult }`         (user)
 * - thinking (replay)   -> `{ reasoningContent }`   (assistant)
 *
 * System messages are not emitted here — they are hoisted to the
 * top-level `system` blocks by {@link buildConverseRequest}.
 *
 * Consecutive messages that resolve to the same Converse role are merged
 * into a single message so the strict user/assistant alternation Converse
 * requires is preserved.
 */
function convertDroolToConverseMessages(
  messages: IndustryDroolMessage[],
  options: ConvertDroolToConverseMessagesOptions = {}
): ConverseMessage[] {
  const includeReasoning = options.includeReasoning ?? true;
  const includeUnsignedReasoning = options.includeUnsignedReasoning ?? true;
  const result: ConverseMessage[] = [];

  const pushBlocks = (
    role: ConverseRole,
    blocks: ConverseContentBlock[]
  ): void => {
    if (blocks.length === 0) return;
    const last = result[result.length - 1];
    if (last && last.role === role) {
      if (last.content) {
        last.content.push(...blocks);
      } else {
        last.content = blocks;
      }
      return;
    }
    result.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === MessageRole.System) continue;

    const content: DroolContentBlock[] =
      typeof message.content === 'string'
        ? [{ type: MessageContentBlockType.Text, text: message.content }]
        : message.content;

    if (
      message.role === MessageRole.User ||
      message.role === MessageRole.Tool
    ) {
      // Tool results must be emitted as their own user content blocks.
      const toolResults: ConverseContentBlock[] = [];
      const userBlocks: ConverseContentBlock[] = [];
      for (const block of content) {
        if (block.type === MessageContentBlockType.ToolResult) {
          toolResults.push({
            toolResult: {
              toolUseId: block.toolUseId,
              content: toolResultContent(block.content),
              status: block.isError ? 'error' : 'success',
            },
          });
        } else if (block.type === MessageContentBlockType.Text) {
          if (block.text.length > 0) userBlocks.push({ text: block.text });
        } else if (block.type === MessageContentBlockType.Image) {
          const img = imageBlockToConverse(block);
          if (img) userBlocks.push(img);
        }
      }
      // Tool results first (mirrors the OpenAI converter ordering) so the
      // model sees results before any accompanying user prose.
      pushBlocks('user', [...toolResults, ...userBlocks]);
      continue;
    }

    if (message.role === MessageRole.Assistant) {
      const blocks: ConverseContentBlock[] = [];
      for (const block of content) {
        if (block.type === MessageContentBlockType.Text) {
          if (block.text.length > 0) blocks.push({ text: block.text });
        } else if (block.type === MessageContentBlockType.ToolUse) {
          blocks.push({
            toolUse: {
              toolUseId: block.id,
              name: sanitizeToolNameForProvider(
                block.name,
                PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
              ),
              input: block.input as DocumentType,
            },
          });
        } else if (
          includeReasoning &&
          block.type === MessageContentBlockType.Thinking &&
          block.thinking.length > 0 &&
          (includeUnsignedReasoning || !!block.signature?.trim())
        ) {
          blocks.push({
            reasoningContent: {
              reasoningText: {
                text: block.thinking,
                ...(block.signature?.trim()
                  ? { signature: block.signature }
                  : {}),
              },
            },
          });
        } else if (
          includeReasoning &&
          block.type === MessageContentBlockType.RedactedThinking
        ) {
          blocks.push({
            reasoningContent: {
              redactedContent: base64ToBytes(block.data),
            },
          });
        }
      }
      pushBlocks('assistant', blocks);
    }
  }

  return result;
}

/** Conservative ceiling when neither the override nor the BYOK config sets one. */
const DEFAULT_CONVERSE_MAX_TOKENS = 8192;

/**
 * Reasoning passthrough for Converse. The exact request field is
 * model-family specific (Kimi K2 family is the v1 target); we surface it
 * via `additionalModelRequestFields` and let `customModel.extraArgs`
 * override/extend it so other Converse models can opt in without code
 * changes. Returns `undefined` when reasoning is not enabled and there are
 * no extra args to pass through.
 */
function isThinkingDisabled(reasoningEffort?: ReasoningEffort): boolean {
  return (
    reasoningEffort === ReasoningEffort.None ||
    reasoningEffort === ReasoningEffort.Off
  );
}

export function isConverseThinkingSignatureEnforcedModel(
  modelId: string
): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes('anthropic') || normalized.includes('claude');
}

function shouldSendThinkingConfig({
  customModel,
  modelId,
  reasoningEffort,
}: {
  customModel?: CustomModel | null;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}): boolean {
  if (customModel?.enableThinking === false) return false;
  if (customModel?.enableThinking === true) return true;

  const effectiveReasoningEffort =
    reasoningEffort ?? customModel?.reasoningEffort;
  if (!effectiveReasoningEffort) return false;

  const supportedEfforts = getCustomModelSupportedEfforts(
    customModel?.reasoningEffort,
    customModel?.model ?? modelId
  );
  return supportedEfforts.includes(effectiveReasoningEffort);
}

function shouldIncludeReasoningReplay({
  customModel,
  modelId,
}: {
  customModel?: CustomModel | null;
  modelId: string;
}): boolean {
  if (customModel?.enableThinking === false) return false;
  if (customModel?.enableThinking === true) return true;

  const supportedEfforts = getCustomModelSupportedEfforts(
    customModel?.reasoningEffort,
    customModel?.model ?? modelId
  );
  return supportedEfforts.some((effort) => !isThinkingDisabled(effort));
}

/** Bedrock's documented minimum extended-thinking budget. */
const CONVERSE_MIN_THINKING_BUDGET_TOKENS = 1024;

function resolveConverseThinkingBudget({
  customModel,
  effort,
}: {
  customModel?: CustomModel | null;
  effort?: ReasoningEffort;
}): number {
  if (
    typeof customModel?.thinkingMaxTokens === 'number' &&
    customModel.thinkingMaxTokens > 0
  ) {
    // A BYOK config may pin a positive sub-minimum value (e.g. 512); Bedrock
    // rejects budgets below its documented floor, so clamp up to the minimum.
    return Math.max(
      customModel.thinkingMaxTokens,
      CONVERSE_MIN_THINKING_BUDGET_TOKENS
    );
  }
  // Efforts without a Claude budget mapping (e.g. Max maps to 0) fall back
  // to the High budget rather than an invalid sub-minimum value.
  const effortBudget = effort ? getClaudeReasoningTokens(effort) : 0;
  const fallbackBudget = getClaudeReasoningTokens(ReasoningEffort.High);
  return Math.max(
    effortBudget > 0 ? effortBudget : fallbackBudget,
    CONVERSE_MIN_THINKING_BUDGET_TOKENS
  );
}

function buildAdditionalModelRequestFields({
  customModel,
  modelId,
  reasoningEffort,
}: {
  customModel?: CustomModel | null;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}): DocumentType | undefined {
  const fields: Record<string, unknown> = {};
  const effectiveReasoningEffort =
    reasoningEffort ?? customModel?.reasoningEffort;

  if (shouldSendThinkingConfig({ customModel, modelId, reasoningEffort })) {
    if (isThinkingDisabled(effectiveReasoningEffort)) {
      fields.thinking = { type: 'disabled' };
    } else {
      // Bedrock rejects `{ type: 'enabled' }` without a budget with
      // `ValidationException: thinking.enabled.budget_tokens: Field
      // required`, so always derive one when the BYOK config doesn't pin it.
      fields.thinking = {
        type: 'enabled',
        budget_tokens: resolveConverseThinkingBudget({
          customModel,
          effort: effectiveReasoningEffort,
        }),
      };

      if (effectiveReasoningEffort) {
        fields.reasoning_effort = effectiveReasoningEffort;
      }
    }
  }

  // extraArgs is the user escape hatch; it wins over the defaults above so
  // a BYOK config can pin the exact reasoning field its model expects.
  if (customModel?.extraArgs) {
    Object.assign(fields, customModel.extraArgs);
  }

  return Object.keys(fields).length > 0 ? (fields as DocumentType) : undefined;
}

/**
 * Narrows the Converse `additionalModelRequestFields` document to the enabled
 * thinking budget and applies the shared `max_tokens > budget` reconciliation
 * (mutating the budget in place when it must drop under the ceiling). Returns
 * the resolved `maxTokens` for the inference config.
 */
function resolveConverseMaxTokens({
  additionalModelRequestFields,
  maxTokens,
  ceiling,
}: {
  additionalModelRequestFields: DocumentType | undefined;
  maxTokens: number;
  ceiling: number | undefined;
}): number {
  const fields = additionalModelRequestFields;
  if (
    fields === undefined ||
    fields === null ||
    typeof fields !== 'object' ||
    Array.isArray(fields)
  ) {
    return maxTokens;
  }
  const thinking = fields.thinking;
  if (
    thinking === undefined ||
    thinking === null ||
    typeof thinking !== 'object' ||
    Array.isArray(thinking)
  ) {
    return maxTokens;
  }
  if (
    thinking.type !== 'enabled' ||
    typeof thinking.budget_tokens !== 'number'
  ) {
    return maxTokens;
  }
  const result = clampMaxTokensAboveThinkingBudget({
    budgetTokens: thinking.budget_tokens,
    requestedMaxTokens: maxTokens,
    ceiling,
  });
  thinking.budget_tokens = result.budgetTokens;
  return result.maxTokens;
}

/**
 * Assembles a `ConverseStreamCommandInput` from Drool history + resolved
 * tools + BYOK config. Pure: no SDK client, no I/O, no Anthropic types.
 */
export function buildConverseRequest({
  modelId,
  messages,
  systemMessage,
  tools,
  customModel,
  reasoningEffort,
  maxTokensOverride,
  temperature,
  stopSequences,
}: BuildConverseRequestParams): ConverseStreamCommandInput {
  const system: SystemContentBlock[] = systemMessage
    .filter((b) => b.text.length > 0)
    .map((b) => ({ text: b.text }));

  const additionalModelRequestFields = buildAdditionalModelRequestFields({
    customModel,
    modelId,
    reasoningEffort,
  });
  const includeReasoning = shouldIncludeReasoningReplay({
    customModel,
    modelId,
  });
  const includeUnsignedReasoning =
    !isConverseThinkingSignatureEnforcedModel(modelId);

  const maxTokens = resolveConverseMaxTokens({
    additionalModelRequestFields,
    maxTokens:
      maxTokensOverride ??
      customModel?.maxOutputTokens ??
      DEFAULT_CONVERSE_MAX_TOKENS,
    ceiling: customModel?.maxOutputTokens,
  });

  return {
    modelId,
    messages: convertDroolToConverseMessages(messages, {
      includeReasoning,
      includeUnsignedReasoning,
    }),
    ...(system.length > 0 ? { system } : {}),
    inferenceConfig: {
      maxTokens,
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(stopSequences && stopSequences.length > 0 ? { stopSequences } : {}),
    },
    ...(tools.length > 0 ? { toolConfig: { tools } } : {}),
    ...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
  };
}
