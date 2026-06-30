import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import {
  ChatCompletionReasoningField,
  ModelProvider,
  OpenAIPhase,
} from '@industry/drool-sdk-ext/protocol/llm';
import {
  Base64PDFSource,
  type ContentBlock,
  DocumentBlock,
  DocumentSourceType,
  IndustryDroolMessage,
  IndustryDroolMessageWithCaching,
  ImageBlock,
  MessageContentBlockType,
  TextBlock,
  type ThinkingBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { TOOL_LLM_ID_APPLY_PATCH } from '@industry/drool-sdk-ext/protocol/tools';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  findClosestModelId,
  getModel,
  getModelConfig,
} from '@industry/utils/llm';

import {
  ANTHROPIC_TOOL_NAME_MAX_LENGTH,
  PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH,
} from './constants';
import {
  createCallIdTranslator,
  sanitizeToolNameForProvider,
} from './tool-call-ids';
import { readCliTool, readCliSchema } from '../../tools/definitions/cli';
import { convertJsonSchemaToGeminiSchema } from '../provider/google/convert-schema';
import {
  getApplyPatchInputFromParameters,
  getOpenAIApplyPatchCustomToolDescription,
  getOpenAIApplyPatchCustomToolFormat,
  isApplyPatchToolName,
  normalizeApplyPatchToolName,
} from '../provider/openai/apply-patch-interop';
import { sanitizeJsonSchemaForLLM } from '../provider/sanitize-json-schema';

import type {
  ChatCompletionConvertOptions,
  ExtendedChatCompletionAssistantMessage,
  ModelCapabilities,
} from './types';
import type { Tool as ConverseTool } from '@aws-sdk/client-bedrock-runtime';
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import type { DocumentType } from '@smithy/types';

type ApplyPatchOpenAIToolMode = 'custom' | 'function';

interface OpenAIResponsesConversionOptions {
  applyPatchToolMode?: ApplyPatchOpenAIToolMode;
}

/**
 * Registry-only model-capability resolver, used when the caller doesn't
 * pass a host-specific `ModelCapabilities` in the convert options. Mirrors
 * the built-in lookups exposed by `@industry/utils/llm` without any
 * knowledge of CLI-side custom-model settings.
 */
const REGISTRY_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsImages(modelId: string): boolean {
    try {
      return getModelConfig(modelId).noImageSupport !== true;
    } catch (error) {
      logWarn(
        '[REGISTRY_MODEL_CAPABILITIES] Unknown model, defaulting to no image support',
        { modelId, cause: error }
      );
      return false;
    }
  },
  supportsPDFs(modelId: string): boolean {
    try {
      return getModelConfig(modelId).supportsPDFs === true;
    } catch (error) {
      logWarn(
        '[REGISTRY_MODEL_CAPABILITIES] Unknown model, defaulting to no PDF support',
        { modelId, cause: error }
      );
      return false;
    }
  },
};

/**
 * Type guard for ContentBlock that may be a DocumentBlock.
 * Needed because TS discriminated union narrowing exhausts the type after
 * checking text/image/thinking/etc branches, leaving `never` even though
 * DocumentBlock is a valid member of the union.
 */
function isContentBlockDocument(block: ContentBlock): block is DocumentBlock {
  return block.type === MessageContentBlockType.Document;
}

/**
 * Converts a DocumentBlock to text content for LLM consumption.
 * PDFs use parsedData, text files use data.
 */
function convertDocumentBlockToText(block: DocumentBlock): string {
  const fileContent =
    block.source.mediaType === 'application/pdf'
      ? block.source.parsedData
      : block.source.data;
  const filename = block.source.name ?? 'unknown';
  return fileContent
    ? `<attached-file name="${filename}" type="${block.source.mediaType}">\n${fileContent}\n</attached-file>`
    : `<attached-file name="${filename}" type="${block.source.mediaType}">[File content unavailable]</attached-file>`;
}

/**
 * Checks if a DocumentBlock is a PDF with base64 data available for native provider support.
 * When true, `block.source` is the Base64PDFSource variant with `data`, `name`, and `path` fields.
 */
function isPdfDocumentWithData(
  block: DocumentBlock
): block is DocumentBlock & { source: Base64PDFSource } {
  return (
    block.source.type === DocumentSourceType.Base64 &&
    block.source.mediaType === 'application/pdf' &&
    !!block.source.data
  );
}

/**
 * Sanitize Anthropic tools by:
 * - inferring missing `type` fields in MCP tool schemas (Anthropic requires
 *   `type` on `input_schema` but is permissive about other keywords),
 * - sanitizing tool names to Anthropic's provider-safe shape.
 */
export function sanitizeAnthropicTools(
  tools: Anthropic.Tool[]
): Anthropic.Tool[] {
  return tools.map((tool) => {
    const sanitizedName = sanitizeToolNameForProvider(
      tool.name,
      ANTHROPIC_TOOL_NAME_MAX_LENGTH
    );
    const schema = tool.input_schema;
    const needsTypeInference =
      !schema.type && Boolean(schema.properties as unknown);
    if (sanitizedName === tool.name && !needsTypeInference) return tool;
    return {
      ...tool,
      name: sanitizedName,
      input_schema: needsTypeInference
        ? { ...schema, type: 'object' as const }
        : schema,
    };
  });
}

/**
 * Converts Anthropic tools to OpenAI Chat Completions format
 */
export function convertAnthropicToOpenAIChatTools(
  anthropicTools: Anthropic.Tool[]
): OpenAI.Chat.ChatCompletionTool[] {
  return anthropicTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: sanitizeToolNameForProvider(
        tool.name,
        PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
      ),
      description: tool.description || '',
      parameters: sanitizeJsonSchemaForLLM(tool.input_schema) as
        | Record<string, unknown>
        | undefined,
    },
  }));
}

/**
 * Converts Anthropic tools (the shape the tool registry emits) to the AWS
 * Bedrock Converse `toolConfig.tools` shape.
 *
 * This is an isolated schema adapter — the registry emits the Anthropic
 * tool shape once and each provider path adapts it (see
 * {@link convertAnthropicToOpenAIChatTools} for the OpenAI precedent). It
 * does NOT imply any Anthropic message-pipeline dependency for Converse.
 */
export function convertAnthropicToConverseTools(
  anthropicTools: Anthropic.Tool[]
): ConverseTool[] {
  return anthropicTools.map(
    (tool) =>
      ({
        toolSpec: {
          name: sanitizeToolNameForProvider(
            tool.name,
            PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
          ),
          description: tool.description || '',
          inputSchema: {
            json: (sanitizeJsonSchemaForLLM(tool.input_schema) ?? {
              type: 'object',
            }) as DocumentType,
          },
        },
      }) as ConverseTool
  );
}

/**
 * Converts Anthropic tools to OpenAI format
 *
 * This is a short-term solution for converting tools types between model providers.
 * In the future, we'll use a generic tool type to avoid converting from one model
 * provider type to another.
 */
export function convertAnthropicToOpenAITools(
  anthropicTools: Anthropic.Tool[],
  options: OpenAIResponsesConversionOptions = {}
): OpenAI.Responses.Tool[] {
  const applyPatchToolMode = options.applyPatchToolMode ?? 'custom';
  return anthropicTools.map((tool) => {
    if (isApplyPatchToolName(tool.name)) {
      if (applyPatchToolMode === 'function') {
        return {
          type: 'function',
          name: TOOL_LLM_ID_APPLY_PATCH,
          description: getOpenAIApplyPatchCustomToolDescription(),
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'Patch text in the ApplyPatch Lark grammar.',
              },
            },
            required: ['input'],
            additionalProperties: false,
          },
          strict: false,
        } as OpenAI.Responses.Tool;
      }

      return {
        type: 'custom',
        name: TOOL_LLM_ID_APPLY_PATCH,
        description: getOpenAIApplyPatchCustomToolDescription(),
        format: getOpenAIApplyPatchCustomToolFormat(),
      } as OpenAI.Responses.Tool;
    }

    return {
      type: 'function',
      name: sanitizeToolNameForProvider(
        tool.name,
        PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
      ),
      description: tool.description || '',
      parameters: sanitizeJsonSchemaForLLM(tool.input_schema) as Record<
        string,
        unknown
      > | null,
      strict: false,
    };
  });
}

// Counter for generating synthetic msg_ IDs for cross-provider replay
let syntheticMsgCounter = 0;

type OpenAIResponseOutputMessageWithPhase = Omit<
  OpenAI.Responses.ResponseOutputMessage,
  'phase'
> & {
  phase?: OpenAIPhase | null;
};

/**
 * Creates an OpenAI assistant message with optional message ID.
 * When no valid msg_ ID is available (e.g. replaying Claude sessions),
 * a synthetic one is generated to match what OpenAI models expect.
 */
function createOpenAIAssistantMessage(
  text: string,
  openaiMessageId?: string,
  openaiPhase?: OpenAIPhase | null
): OpenAIResponseOutputMessageWithPhase {
  // Always include an OpenAI message ID. When replaying cross-provider sessions
  // (e.g. Claude → OpenAI), the original messages lack msg_ IDs.  OpenAI models
  // expect every prior assistant message to carry one, so we synthesise one to
  // keep the conversation history consistent with what the model sees in production.
  const id =
    openaiMessageId && openaiMessageId.startsWith('msg_')
      ? openaiMessageId
      : `msg_synth_${syntheticMsgCounter++}`;

  const assistantMessage: OpenAIResponseOutputMessageWithPhase = {
    type: 'message' as const,
    id,
    status: 'completed' as const,
    role: 'assistant' as const,
    content: [
      {
        type: 'output_text' as const,
        text,
        annotations: [],
      },
    ],
    // Skip null — older persisted sessions may have openaiPhase: null which
    // would serialize as phase: null and bypass the backfill loop.
    phase: openaiPhase ?? undefined,
  };

  return assistantMessage;
}

/**
 * Convert Anthropic messages to OpenAI Responses format
 *
 * This is a short-term solution for converting message types between model providers.
 * In the future, we'll consolidate messages to use IndustryMessage type to avoid
 * conversions from one model provider to another.
 */
export async function convertDroolToOpenAIMessages(
  messages: IndustryDroolMessage[],
  options: OpenAIResponsesConversionOptions = {}
): Promise<OpenAI.Responses.ResponseInputItem[]> {
  const result: OpenAI.Responses.ResponseInputItem[] = [];
  const applyPatchToolMode = options.applyPatchToolMode ?? 'custom';

  // Track Read tool calls to provide file path context for images
  const readToolFilePaths = new Map<string, string>();

  // Translate non-OpenAI tool call IDs (e.g. Anthropic's "toolu_01..." format) to
  // OpenAI-compatible "call_..." IDs.  When replaying Claude sessions with OpenAI
  // models, mismatched IDs cause the model to fall back to text-based tool calling
  // with garbled tokenizer noise instead of structured function_call output items.
  const toOpenAICallId = createCallIdTranslator();
  const callIdToToolName = new Map<string, string>();

  for (const message of messages) {
    // Check if this message has encrypted reasoning content (OpenAI only)
    // Reasoning blocks must come before their associated assistant message
    if (message.openaiEncryptedContent && message.openaiReasoningId) {
      const reasoningBlock: {
        type: 'reasoning';
        encrypted_content: string;
        summary: Array<{ type: 'summary_text'; text: string }>;
      } = {
        type: 'reasoning' as const,
        encrypted_content: message.openaiEncryptedContent,
        // Summary is required by the API - use empty array if not available
        summary: message.openaiReasoningSummary
          ? [
              {
                type: 'summary_text',
                text: message.openaiReasoningSummary,
              },
            ]
          : [],
      };

      result.push(reasoningBlock as OpenAI.Responses.ResponseInputItem);
    }

    // Handle string content early to keep block types clean
    if (typeof message.content === 'string') {
      if (message.role === 'user') {
        result.push({
          role: 'user' as const,
          content: [{ type: 'input_text' as const, text: message.content }],
        });
      } else if (message.role === 'assistant') {
        result.push(
          createOpenAIAssistantMessage(
            message.content,
            message.openaiMessageId,
            message.openaiPhase
          )
        );
      }
      continue;
    }

    const content: ContentBlock[] = message.content;

    if (message.role === 'user' || message.role === 'tool') {
      const isToolMessage = message.role === 'tool';
      // Process user message content blocks
      const textBlocks: OpenAI.Responses.ResponseInputText[] = [];
      const mediaBlocks: Array<
        OpenAI.Responses.ResponseInputImage | OpenAI.Responses.ResponseInputFile
      > = [];

      for (const block of content) {
        if (!isToolMessage && block.type === 'text') {
          textBlocks.push({
            type: 'input_text' as const,
            text: block.text,
          });
        } else if (!isToolMessage && block.type === 'image') {
          // Convert Anthropic image format to OpenAI data URL format
          // Handle base64 images (most common in CLI)
          if (block.source.type === 'base64') {
            const dataUrl = `data:${block.source.mediaType};base64,${block.source.data}`;
            mediaBlocks.push({
              type: 'input_image' as const,
              image_url: dataUrl,
              detail: 'auto' as const,
            });
          }
          // Note: URL-based images would need to be handled differently if supported in the future
        } else if (!isToolMessage && block.type === 'document') {
          if (isPdfDocumentWithData(block)) {
            mediaBlocks.push({
              type: 'input_file',
              file_data: `data:application/pdf;base64,${block.source.data}`,
              filename: block.source.name ?? 'document.pdf',
            });
          } else {
            textBlocks.push({
              type: 'input_text' as const,
              text: convertDocumentBlockToText(block),
            });
          }
        } else if (block.type === 'tool_result') {
          // Extract text content from the tool result
          const textContent = Array.isArray(block.content)
            ? block.content
                .filter((c): c is TextBlock => c.type === 'text')
                .map((c) => c.text)
                .join('\n')
            : typeof block.content === 'string'
              ? block.content
              : '';

          const callId = toOpenAICallId(block.toolUseId);
          const toolName = callIdToToolName.get(callId);
          const isApplyPatchCall =
            typeof toolName === 'string' && isApplyPatchToolName(toolName);

          // Always add the function_call_output with text content
          if (isApplyPatchCall && applyPatchToolMode === 'custom') {
            result.push({
              type: 'custom_tool_call_output',
              call_id: callId,
              output: textContent || 'Patch applied successfully',
            } as OpenAI.Responses.ResponseCustomToolCallOutput);
          } else {
            result.push({
              type: 'function_call_output' as const,
              call_id: callId,
              output: textContent || 'Image content read successfully',
            } satisfies OpenAI.Responses.ResponseInputItem.FunctionCallOutput);
          }

          // Check if content has images or PDFs and add synthetic user messages if needed
          if (Array.isArray(block.content)) {
            const toolResultImages = block.content.filter(
              (c): c is ImageBlock => c.type === 'image'
            );

            if (toolResultImages.length > 0) {
              // Convert images to OpenAI format
              const openAIImages: OpenAI.Responses.ResponseInputImage[] =
                toolResultImages.map((img) => {
                  if (img.source.type === 'base64') {
                    const dataUrl = `data:${img.source.mediaType};base64,${img.source.data}`;
                    return {
                      type: 'input_image' as const,
                      image_url: dataUrl,
                      detail: 'auto' as const,
                    };
                  }
                  // URL-based images would need different handling
                  throw new MetaError(
                    'URL-based images not yet supported for OpenAI conversion'
                  );
                });

              // Get the file path from Read tool call
              const filePath = readToolFilePaths.get(
                toOpenAICallId(block.toolUseId)
              );
              const contextText = filePath
                ? `Image content from ${filePath}:`
                : 'Image content from tool result:';

              // Add synthetic user message with images
              result.push({
                role: 'user' as const,
                content: [
                  {
                    type: 'input_text' as const,
                    text: contextText,
                  },
                  ...openAIImages,
                ],
              });
            }

            // Handle PDF documents in tool results
            const toolResultDocs = block.content
              .filter(
                (c): c is DocumentBlock =>
                  c.type === MessageContentBlockType.Document
              )
              .filter(isPdfDocumentWithData);

            if (toolResultDocs.length > 0) {
              const openAIFiles: OpenAI.Responses.ResponseInputFile[] =
                toolResultDocs.map((doc) => ({
                  type: 'input_file' as const,
                  file_data: `data:application/pdf;base64,${doc.source.data}`,
                  filename: doc.source.name ?? 'document.pdf',
                }));

              // Mirror the image branch: look up the translated OpenAI
              // call id so the Read-tool file path survives cross-provider
              // replay when `block.toolUseId` is a non-OpenAI id (e.g.
              // `toolu_*`).
              const filePath = readToolFilePaths.get(
                toOpenAICallId(block.toolUseId)
              );
              const contextText = filePath
                ? `PDF document from ${filePath}:`
                : 'PDF document from tool result:';

              result.push({
                role: 'user' as const,
                content: [
                  {
                    type: 'input_text' as const,
                    text: contextText,
                  },
                  ...openAIFiles,
                ],
              });
            }
          }
        }
        // Note: We skip other block types that aren't supported in OpenAI format
        // such as 'tool_use' blocks in user messages (which shouldn't normally appear there)
      }

      // Add user message if it has text or images
      if (!isToolMessage && (textBlocks.length > 0 || mediaBlocks.length > 0)) {
        result.push({
          role: 'user' as const,
          content: [...textBlocks, ...mediaBlocks],
        });
      }
    } else if (message.role === 'assistant') {
      // Process assistant message content blocks
      const textContents: string[] = [];

      for (const block of content) {
        if (block.type === 'text') {
          textContents.push(block.text);
        } else if (block.type === 'tool_use') {
          const translatedCallId = toOpenAICallId(block.id);
          callIdToToolName.set(translatedCallId, block.name);

          // Track Read tool calls that might return images
          if (block.name === readCliTool.llmId) {
            const parseResult = readCliSchema.safeParse(block.input);
            if (parseResult.success) {
              readToolFilePaths.set(
                translatedCallId,
                parseResult.data.file_path
              );
            }
          }

          // First, add any accumulated text as a message
          if (textContents.length > 0) {
            result.push(
              createOpenAIAssistantMessage(
                textContents.join(''),
                message.openaiMessageId,
                message.openaiPhase
              )
            );
            textContents.length = 0; // Clear accumulated text
          }

          // Add tool call as function_call
          if (
            isApplyPatchToolName(block.name) &&
            applyPatchToolMode === 'custom'
          ) {
            result.push({
              type: 'custom_tool_call',
              call_id: translatedCallId,
              name: normalizeApplyPatchToolName(block.name),
              input: getApplyPatchInputFromParameters(block.input),
            } as OpenAI.Responses.ResponseCustomToolCall);
          } else {
            result.push({
              type: 'function_call' as const,
              call_id: translatedCallId,
              name: isApplyPatchToolName(block.name)
                ? TOOL_LLM_ID_APPLY_PATCH
                : sanitizeToolNameForProvider(
                    block.name,
                    PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
                  ),
              arguments: JSON.stringify(
                isApplyPatchToolName(block.name)
                  ? { input: getApplyPatchInputFromParameters(block.input) }
                  : block.input
              ),
            } satisfies OpenAI.Responses.ResponseFunctionToolCall);
          }
        }
      }

      // Add any remaining text content as a message
      if (textContents.length > 0) {
        result.push(
          createOpenAIAssistantMessage(
            textContents.join(''),
            message.openaiMessageId,
            message.openaiPhase
          )
        );
      }
    }
  }

  // Backfill `phase` on assistant messages that lack it (cross-provider replay).
  // In production OpenAI sessions every assistant message carries a phase; without
  // it the model may fall back to text-based tool calling.
  //   - "commentary" when the message is immediately followed by a function_call
  //   - "final_answer" otherwise (followed by user input or end of conversation)
  for (let i = 0; i < result.length; i++) {
    const item = result[i];
    if ('role' in item && item.role === 'assistant') {
      const msg = item as OpenAIResponseOutputMessageWithPhase;
      if (msg.phase == null) {
        const next = result[i + 1];
        msg.phase =
          next &&
          'type' in next &&
          (next.type === 'function_call' || next.type === 'custom_tool_call')
            ? OpenAIPhase.Commentary
            : OpenAIPhase.FinalAnswer;
      }
    }
  }

  return result;
}

/**
 * Determine whether the target model's Chat Completions endpoint accepts
 * reasoning fields (`reasoning`, `reasoning_content`) on assistant messages.
 *
 * This is orthogonal to reasoning-effort support (FAC-16931): a model may
 * _produce_ reasoning in responses yet reject it as input (e.g. GLM-4.7 on
 * Fireworks returns `reasoning_content` but HTTP 400s if you send it back).
 *
 * Resolution order:
 *  1. Custom model with `enableThinking` → true (user explicitly opted in).
 *  2. Registry model with `chatCompletionAcceptsReasoning` → use that value.
 *  3. Default → false (strip reasoning to be safe).
 */
function modelAcceptsReasoningFields(
  modelId: string | undefined,
  options: ChatCompletionConvertOptions | undefined
): boolean {
  if (options?.enableThinking) return true;

  if (modelId) {
    const resolved = findClosestModelId(modelId);
    if (resolved) {
      try {
        const cfg = getModel(resolved);
        return cfg.chatCompletionRequest?.acceptsReasoning ?? false;
      } catch (error) {
        logWarn(
          '[modelAcceptsReasoningFields] Model not in registry, defaulting to false',
          { modelId: resolved, cause: error }
        );
      }
    }
  }
  return false;
}

/**
 * Resolve the wire-format field name to use for replayed reasoning on
 * assistant messages. Some models (e.g. Kimi on vLLM/SGLang/Fireworks) accept
 * only `reasoning_content` and HTTP 400 on `reasoning`, even though a stored
 * message captured from a different provider may have used `reasoning`.
 *
 * Reads the target model's preferred field name from the registry's
 * `chatCompletionRequest.reasoningFieldName`, falling back to the stored
 * field when no preference is known (preserves prior behavior).
 */
function resolveReasoningFieldName(
  modelId: string | undefined,
  storedField: ChatCompletionReasoningField
): ChatCompletionReasoningField {
  if (!modelId) return storedField;
  const resolved = findClosestModelId(modelId);
  if (!resolved) return storedField;
  try {
    const cfg = getModel(resolved);
    return cfg.chatCompletionRequest?.reasoningFieldName ?? storedField;
  } catch (error) {
    logWarn(
      '[resolveReasoningFieldName] Model not in registry, defaulting to stored field',
      { modelId: resolved, cause: error }
    );
    return storedField;
  }
}

/**
 * Whether the target model rejects assistant tool-call turns on replay that
 * omit reasoning (DeepSeek V4: HTTP 400 "the `reasoning_content` in the
 * thinking mode must be passed back to the API"). When true, the converter
 * backfills a non-empty placeholder for tool-call turns whose captured
 * reasoning is empty or missing (empty thinking, non-thinking turn,
 * compaction-synthesised turn, aborted stream) so the per-turn contract holds.
 */
function modelRequiresReasoningOnReplay(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const resolved = findClosestModelId(modelId);
  if (!resolved) return false;
  try {
    return (
      getModel(resolved).chatCompletionRequest?.reasoningRequiredOnReplay ??
      false
    );
  } catch (error) {
    logWarn(
      '[modelRequiresReasoningOnReplay] Model not in registry, defaulting to false',
      { modelId: resolved, cause: error }
    );
    return false;
  }
}

/**
 * Strip `tool_calls` entries from non-trailing assistant messages whose IDs
 * have no matching `tool`-role response immediately following. This commonly
 * happens when the user interrupts tool execution mid-flight, leaving the
 * history with an assistant message advertising a tool call that was never
 * answered. Providers like Moonshot — and Kimi on Fireworks with
 * `preserve_thinking` — reject such histories with HTTP 400.
 *
 * We only look at the immediately-adjacent run of `tool` messages because the
 * OpenAI Chat Completions spec requires tool results to sit right after the
 * assistant message that produced them; a `tool_call_id` separated by a
 * user/assistant turn is considered orphaned.
 *
 * The trailing assistant message (current generation in progress) is left
 * alone — its tool calls are the pending output, not history.
 *
 * If stripping leaves the assistant message with no content and no remaining
 * tool_calls (interrupted turn where the model only emitted a `tool_use`
 * block), the whole message is removed — an assistant message with both
 * `content: null` and no `tool_calls` is invalid per the Chat Completions
 * spec and would still 400 on replay.
 */
function sanitizeOrphanedToolCalls(
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
): void {
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !('tool_calls' in msg) || !msg.tool_calls) {
      continue;
    }

    const adjacentToolResultIds = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role !== 'tool') break;
      if ('tool_call_id' in next) {
        adjacentToolResultIds.add(next.tool_call_id);
      }
    }

    const filtered = msg.tool_calls.filter((tc) =>
      adjacentToolResultIds.has(tc.id)
    );
    if (filtered.length === msg.tool_calls.length) continue;

    const mutable = msg as unknown as Record<string, unknown>;
    if (filtered.length > 0) {
      mutable.tool_calls = filtered;
      continue;
    }
    delete mutable.tool_calls;
    if (msg.content == null || msg.content === '') {
      messages.splice(i, 1);
      i--;
    }
  }
}

/**
 * Convert messages from other models to OpenAI Chat Completions format
 */
export function convertDroolToOpenAiChatMessages(
  messages: IndustryDroolMessage[],
  modelId?: string,
  modelProvider?: ModelProvider,
  options: ChatCompletionConvertOptions = {}
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const modelCapabilities: ModelCapabilities =
    options.modelCapabilities ?? REGISTRY_MODEL_CAPABILITIES;
  const supportsPDFs = modelId
    ? modelCapabilities.supportsPDFs(modelId)
    : false;
  const includeReasoning = modelAcceptsReasoningFields(modelId, options);
  const requiresReasoningOnReplay =
    includeReasoning && modelRequiresReasoningOnReplay(modelId);

  // Translate non-OpenAI tool call IDs for cross-provider replay compatibility
  const toOpenAICallId = createCallIdTranslator();

  for (const message of messages) {
    // Handle string content early to keep block types clean
    if (typeof message.content === 'string') {
      if (message.role === 'user') {
        result.push({ role: 'user', content: message.content });
      } else if (message.role === 'assistant') {
        result.push({
          role: 'assistant',
          content: message.content,
          tool_calls: undefined,
        });
      }
      continue;
    }

    const content: ContentBlock[] = message.content;

    if (message.role === 'user' || message.role === 'tool') {
      // Process user message content blocks
      // IMPORTANT: Tool results must be added BEFORE user messages for OpenAI API
      const chatContent: Array<
        | OpenAI.Chat.ChatCompletionContentPartText
        | OpenAI.Chat.ChatCompletionContentPartImage
        | OpenAI.Chat.ChatCompletionContentPart.File
      > = [];

      // First pass: Process tool_result blocks and add them as tool messages
      for (const block of content) {
        if (block.type === 'tool_result') {
          // Add tool result as a tool message
          const toolContent = Array.isArray(block.content)
            ? block.content
                .filter((c): c is TextBlock => c.type === 'text')
                .map((c) => c.text)
                .join('\n')
            : typeof block.content === 'string'
              ? block.content
              : 'Tool executed successfully';

          result.push({
            role: 'tool',
            content: toolContent,
            tool_call_id: toOpenAICallId(block.toolUseId),
          });

          // Extract images from tool result and add as synthetic user message
          // for models that support images
          if (
            modelId &&
            modelCapabilities.supportsImages(modelId) &&
            Array.isArray(block.content)
          ) {
            const imageBlocks = block.content.filter(
              (c): c is ImageBlock =>
                c.type === MessageContentBlockType.Image &&
                'source' in c &&
                c.source.type === 'base64'
            );

            if (imageBlocks.length > 0) {
              const chatImages: OpenAI.Chat.ChatCompletionContentPartImage[] =
                imageBlocks.map((img) => ({
                  type: 'image_url',
                  image_url: {
                    url: `data:${img.source.mediaType};base64,${img.source.data}`,
                    detail: 'auto',
                  },
                }));

              // Add synthetic user message with images
              result.push({
                role: 'user',
                content: [
                  { type: 'text', text: 'Image content from tool result:' },
                  ...chatImages,
                ],
              });
            }

            // Extract PDFs from tool result
            const pdfBlocks = block.content
              .filter(
                (c): c is DocumentBlock =>
                  c.type === MessageContentBlockType.Document
              )
              .filter(isPdfDocumentWithData);

            if (pdfBlocks.length > 0 && supportsPDFs) {
              // Native PDF support: send as synthetic user message with file parts
              const chatFiles: OpenAI.Chat.ChatCompletionContentPart.File[] =
                pdfBlocks.map((doc) => ({
                  type: 'file' as const,
                  file: {
                    file_data: `data:application/pdf;base64,${doc.source.data}`,
                    filename: doc.source.name ?? 'document.pdf',
                  },
                }));

              const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
                {
                  type: 'text',
                  text: 'PDF document from tool result:',
                },
                ...chatFiles,
              ];
              result.push({
                role: 'user',
                content: contentParts,
              });
            }
          }
        }
      }

      // Second pass: Process other content (text, images)
      for (const block of content) {
        if (block.type === 'text') {
          chatContent.push({
            type: 'text',
            text: block.text,
          });
        } else if (block.type === 'image') {
          // Convert Anthropic image format to OpenAI format
          if (block.source.type === 'base64') {
            const dataUrl = `data:${block.source.mediaType};base64,${block.source.data}`;
            chatContent.push({
              type: 'image_url',
              image_url: {
                url: dataUrl,
                detail: 'auto',
              },
            });
          }
        } else if (isContentBlockDocument(block)) {
          const src = block.source;
          if (
            supportsPDFs &&
            src.type === DocumentSourceType.Base64 &&
            src.mediaType === 'application/pdf' &&
            src.data
          ) {
            chatContent.push({
              type: 'file',
              file: {
                file_data: `data:application/pdf;base64,${src.data}`,
                filename: src.name ?? 'document.pdf',
              },
            });
          } else {
            chatContent.push({
              type: 'text',
              text: convertDocumentBlockToText(block),
            });
          }
        }
      }

      // Add user message if it has content
      if (chatContent.length > 0) {
        result.push({
          role: 'user',
          content:
            chatContent.length === 1 && chatContent[0].type === 'text'
              ? chatContent[0].text
              : chatContent,
        });
      }
    } else if (message.role === 'assistant') {
      // Process assistant message content blocks
      let textContent = '';
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
      const blockLevelGeminiThoughtSignature = content.find(
        (block): block is ThinkingBlock =>
          block.type === MessageContentBlockType.Thinking &&
          block.signatureProvider === ModelProvider.GOOGLE &&
          !!block.signature?.trim()
      )?.signature;

      for (const block of content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          const toolName = normalizeApplyPatchToolName(block.name);

          // Build tool call with optional signature extension
          const toolCall: OpenAI.Chat.ChatCompletionMessageToolCall & {
            extra_content?: { google?: { thought_signature?: string } };
          } = {
            id: toOpenAICallId(block.id),
            type: 'function',
            function: {
              name: sanitizeToolNameForProvider(
                toolName,
                PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
              ),
              arguments: JSON.stringify(block.input),
            },
          };

          // Include thought signature for Gemini (for maintaining context across turns)
          if (
            modelProvider === ModelProvider.GOOGLE &&
            block.thoughtSignature
          ) {
            toolCall.extra_content = {
              google: {
                thought_signature: block.thoughtSignature,
              },
            };
          }

          toolCalls.push(toolCall);
        }
      }

      // Build assistant message
      const assistantMessage: ExtendedChatCompletionAssistantMessage = {
        role: 'assistant',
        content: textContent || null,
      };

      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }

      // Include Gemini thought signature from the canonical thinking block.
      if (
        modelProvider === ModelProvider.GOOGLE &&
        blockLevelGeminiThoughtSignature
      ) {
        assistantMessage.extra_content = {
          google: {
            thought_signature: blockLevelGeminiThoughtSignature,
          },
        };
      }

      // Include Chat Completions reasoning only when the target model
      // explicitly accepts it.  Stripping by default prevents HTTP 400
      // from providers like Fireworks that reject unknown fields (FAC-16931).
      // Normalize the field name to the target's wire format so cross-provider
      // histories (e.g. `reasoning` captured from OpenAI, replayed to Kimi)
      // don't 400 on field-name mismatch.
      if (
        includeReasoning &&
        message.chatCompletionReasoningContent &&
        message.chatCompletionReasoningField
      ) {
        const fieldName = resolveReasoningFieldName(
          modelId,
          message.chatCompletionReasoningField
        );
        assistantMessage[fieldName] = message.chatCompletionReasoningContent;
      } else if (requiresReasoningOnReplay && toolCalls.length > 0) {
        // DeepSeek-class providers 400 if any assistant tool-call turn omits
        // reasoning_content on replay. Backfill a non-empty placeholder when
        // this turn captured no (or empty) reasoning so the strict per-turn
        // contract still holds.
        const fieldName = resolveReasoningFieldName(
          modelId,
          message.chatCompletionReasoningField ??
            ChatCompletionReasoningField.ReasoningContent
        );
        assistantMessage[fieldName] =
          message.chatCompletionReasoningContent || ' ';
      }

      result.push(
        assistantMessage as OpenAI.Chat.ChatCompletionAssistantMessageParam
      );
    } else if (message.role === 'system') {
      // Handle system messages (though they're typically part of the system prompt)
      const systemContent =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((c): c is TextBlock => c.type === 'text')
              .map((c) => c.text)
              .join('\n');

      result.push({
        role: 'system',
        content: systemContent,
      });
    }
  }

  sanitizeOrphanedToolCalls(result);

  return result;
}

// =============================================================================
// Gemini Converters
// =============================================================================

/** Gemini reserved keyword that bypasses thought-signature validation for tool calls without stored signatures */
const GEMINI_SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

function isFunctionResponsePart(part: Part): boolean {
  return !!part.functionResponse;
}

function isFunctionCallPart(part: Part): boolean {
  return !!part.functionCall;
}

function startsGeminiTurn(content: Content): boolean {
  return (
    content.role === 'user' &&
    !!content.parts?.some((part) => !isFunctionResponsePart(part))
  );
}

function findActiveGeminiTurnStartIndex(contents: Content[]): number {
  for (let i = contents.length - 1; i >= 0; i--) {
    if (startsGeminiTurn(contents[i])) {
      return i;
    }
  }

  return 0;
}

/**
 * Convert Anthropic tools to Gemini function declarations.
 * Uses parameters format (standard Vertex AI format).
 * Note: parametersJsonSchema is an alternative format but may not be supported by all endpoints.
 */
export function convertAnthropicToolsToGemini(
  anthropicTools: Anthropic.Tool[]
): FunctionDeclaration[] {
  return anthropicTools.map((tool) => ({
    name: sanitizeToolNameForProvider(
      tool.name,
      PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
    ),
    description: tool.description || '',
    parameters: tool.input_schema
      ? convertJsonSchemaToGeminiSchema(tool.input_schema)
      : undefined,
  }));
}

/**
 * Validate if a content part is valid (not empty).
 * Based on gemini-cli's isValidContent logic.
 */
function isValidGeminiPart(part: Part): boolean {
  if (!part || Object.keys(part).length === 0) {
    return false;
  }
  // Empty non-thought text is invalid
  if ('text' in part && part.text === '' && !part.thoughtSignature) {
    return false;
  }
  return true;
}

/**
 * Validate if all parts in a content entry are valid.
 */
function isValidGeminiContent(content: Content): boolean {
  if (!content.parts || content.parts.length === 0) {
    return false;
  }
  return content.parts.every(isValidGeminiPart);
}

/**
 * Extract curated history by removing invalid model turns.
 * This prevents API errors from empty or invalid content.
 */
export function extractCuratedGeminiHistory(contents: Content[]): Content[] {
  const curatedHistory: Content[] = [];
  let removedCount = 0;

  for (const content of contents) {
    // User turns are always included
    if (content.role === 'user') {
      curatedHistory.push(content);
    } else if (isValidGeminiContent(content)) {
      // Model turns are only included if valid
      curatedHistory.push(content);
    } else {
      removedCount++;
    }
  }

  if (removedCount > 0) {
    logInfo('[Gemini] Removed invalid model turns from history', {
      deletedCount: removedCount,
      count: contents.length,
    });
  }

  return curatedHistory;
}

/**
 * Ensure thought signatures are present for multi-turn function calling.
 * Gemini 3+ requires thought signatures when function calls are present
 * in the active turn. Only injects into the active turn (from the last
 * real user message onwards) to avoid polluting earlier history.
 */
export function ensureGeminiThoughtSignatures(contents: Content[]): Content[] {
  const activeTurnStartIndex = findActiveGeminiTurnStartIndex(contents);
  let injectedCount = 0;

  const updatedContents = contents.map((content, idx) => {
    if (idx < activeTurnStartIndex || content.role !== 'model') {
      return content;
    }

    let injectedForContent = false;
    const parts = content.parts?.map((part) => {
      if (isFunctionCallPart(part) && !part.thoughtSignature?.trim()) {
        injectedCount++;
        injectedForContent = true;
        return {
          ...part,
          thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE,
        };
      }

      return part;
    });

    if (!injectedForContent) {
      return content;
    }

    return {
      ...content,
      parts,
    };
  });

  if (injectedCount === 0) {
    return contents;
  }

  if (injectedCount > 0) {
    logInfo('[Gemini] Injected fallback function-call thought signatures', {
      count: injectedCount,
      index: activeTurnStartIndex,
    });
  }

  return updatedContents;
}

/**
 * Convert Industry Drool messages to Gemini contents format.
 */
export function convertDroolToGeminiContents(
  messages: IndustryDroolMessageWithCaching[]
): Content[] {
  const contents: Content[] = [];

  // Build a mapping from toolUseId -> sanitized toolName for looking up function names
  const toolIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === MessageContentBlockType.ToolUse) {
          toolIdToName.set(
            block.id,
            sanitizeToolNameForProvider(
              block.name,
              PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
            )
          );
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const parts: Part[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === MessageContentBlockType.Text) {
            parts.push({ text: block.text });
          } else if (block.type === MessageContentBlockType.Image) {
            parts.push({
              inlineData: {
                mimeType: block.source.mediaType,
                data: block.source.data,
              },
            });
          } else if (isContentBlockDocument(block)) {
            const src = block.source;
            if (
              src.type === DocumentSourceType.Base64 &&
              src.mediaType === 'application/pdf' &&
              src.data
            ) {
              parts.push({
                inlineData: {
                  mimeType: 'application/pdf',
                  data: src.data,
                },
              });
            } else {
              parts.push({
                text: convertDocumentBlockToText(block),
              });
            }
          } else if (block.type === MessageContentBlockType.ToolResult) {
            // Look up the actual function name from the mapping
            const toolName =
              toolIdToName.get(block.toolUseId) || block.toolUseId;

            // Process tool result content - extract text, images, and PDFs
            if (typeof block.content === 'string') {
              parts.push({
                functionResponse: {
                  name: toolName,
                  response: { result: block.content },
                },
              });
            } else if (Array.isArray(block.content)) {
              const textParts: string[] = [];
              const binaryParts: Part[] = [];

              for (const c of block.content) {
                if (c.type === MessageContentBlockType.Text && 'text' in c) {
                  textParts.push(c.text);
                } else if (
                  c.type === MessageContentBlockType.Image &&
                  'source' in c &&
                  c.source.type === 'base64'
                ) {
                  binaryParts.push({
                    inlineData: {
                      mimeType: c.source.mediaType,
                      data: c.source.data,
                    },
                  });
                } else if (
                  isContentBlockDocument(c) &&
                  isPdfDocumentWithData(c)
                ) {
                  binaryParts.push({
                    inlineData: {
                      mimeType: 'application/pdf',
                      data: c.source.data,
                    },
                  });
                }
              }

              const textContent =
                textParts.length > 0
                  ? textParts.join('\n')
                  : binaryParts.length > 0
                    ? `Binary content provided (${binaryParts.length} item(s)).`
                    : 'Tool execution succeeded.';

              parts.push({
                functionResponse: {
                  name: toolName,
                  response: { result: textContent },
                  parts: binaryParts.length > 0 ? binaryParts : undefined,
                },
              });
            } else {
              parts.push({
                functionResponse: {
                  name: toolName,
                  response: { result: JSON.stringify(block.content) },
                },
              });
            }
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'user', parts });
      }
    } else if (msg.role === 'assistant') {
      const parts: Part[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === MessageContentBlockType.Text) {
            parts.push({ text: block.text });
          } else if (block.type === MessageContentBlockType.Thinking) {
            parts.push({
              text: block.thinking,
              ...(block.signatureProvider === ModelProvider.GOOGLE &&
              block.signature?.trim()
                ? { thoughtSignature: block.signature }
                : {}),
            });
          } else if (block.type === MessageContentBlockType.ToolUse) {
            parts.push({
              functionCall: {
                name: sanitizeToolNameForProvider(
                  block.name,
                  PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
                ),
                args: block.input as Record<string, unknown>,
              },
              ...(block.thoughtSignature
                ? { thoughtSignature: block.thoughtSignature }
                : {}),
            });
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'model', parts });
      }
    } else if (msg.role === 'tool') {
      // Tool results are sent as user messages with functionResponse
      const parts: Part[] = [];

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === MessageContentBlockType.ToolResult) {
            const toolName =
              toolIdToName.get(block.toolUseId) || block.toolUseId;

            if (typeof block.content === 'string') {
              parts.push({
                functionResponse: {
                  name: toolName,
                  response: { result: block.content },
                },
              });
            } else if (Array.isArray(block.content)) {
              const textParts: string[] = [];
              const binaryParts: Part[] = [];

              for (const c of block.content) {
                if (c.type === MessageContentBlockType.Text && 'text' in c) {
                  textParts.push(c.text);
                } else if (
                  c.type === MessageContentBlockType.Image &&
                  'source' in c &&
                  c.source.type === 'base64'
                ) {
                  binaryParts.push({
                    inlineData: {
                      mimeType: c.source.mediaType,
                      data: c.source.data,
                    },
                  });
                } else if (
                  isContentBlockDocument(c) &&
                  isPdfDocumentWithData(c)
                ) {
                  binaryParts.push({
                    inlineData: {
                      mimeType: 'application/pdf',
                      data: c.source.data,
                    },
                  });
                }
              }

              const textContent =
                textParts.length > 0
                  ? textParts.join('\n')
                  : binaryParts.length > 0
                    ? `Binary content provided (${binaryParts.length} item(s)).`
                    : 'Tool execution succeeded.';

              parts.push({
                functionResponse: {
                  name: toolName,
                  response: { result: textContent },
                  parts: binaryParts.length > 0 ? binaryParts : undefined,
                },
              });
            } else {
              parts.push({
                functionResponse: {
                  name: toolName,
                  response: { result: JSON.stringify(block.content) },
                },
              });
            }
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'user', parts });
      }
    } else if (msg.role === 'system') {
      // Gemini does not support system messages. Map to user messages.
      const parts: Part[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === MessageContentBlockType.Text) {
            parts.push({ text: block.text });
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role: 'user', parts });
      }
    }
  }

  return contents;
}
