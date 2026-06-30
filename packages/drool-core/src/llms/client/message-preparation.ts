import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import {
  type ContentBlock,
  type DocumentBlock,
  type IndustryDroolMessage,
  type IndustryDroolMessageWithCaching,
  type ImageBlock,
  MessageContentBlockType,
  MessageRole,
  type TextBlock,
  type ThinkingBlock,
  type ToolUseBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logInfo, logWarn } from '@industry/logging';
import { hasUsableTextContent } from '@industry/utils/messages';

import { parseSignatureErrorLocation } from '../errors';
import { ThinkingDowngradeReason } from './enums';
import { limitConversationImages, limitConversationPDFs } from './image-limits';

import type {
  PreparedMessagesWithCachingResult,
  PrepareMessagesWithCachingOptions,
  PrepareMessagesWithCachingReturn,
  ThinkingNormalizationContext,
} from './types';

// ---------------------------------------------------------------------------
// Thinking-block normalization
// ---------------------------------------------------------------------------

/**
 * Decide whether a thinking block should be downgraded to a text block
 * for the given provider context. Returns the downgrade reason, or `null`
 * when the block is compatible and can be kept as-is.
 *
 * The rules mirror the historical `prepareMessagesWithCaching` logic:
 *
 * 1. Blocks with empty signatures are incompatible unless the route accepts
 *    Anthropic-compat or unsigned thinking blocks.
 * 2. Blocks whose `signatureProvider` does not match the current provider
 *    are cross-provider and must be downgraded, except when the route
 *    explicitly accepts Anthropic-signed blocks.
 * 3. Legacy blocks without a `signatureProvider` whose signature begins
 *    with `{` look like serialized OpenAI items; downgrade unless the
 *    current provider is OpenAI.
 */
function getThinkingBlockDowngradeReason(
  block: ThinkingBlock,
  context: ThinkingNormalizationContext
): ThinkingDowngradeReason | null {
  const {
    currentProvider,
    acceptsAnthropicSignatures,
    acceptsUnsignedThinkingSignatures,
  } = context;

  if (
    !block.signature?.trim() &&
    !acceptsAnthropicSignatures &&
    !acceptsUnsignedThinkingSignatures
  ) {
    return ThinkingDowngradeReason.EmptySignature;
  }

  if (
    block.signatureProvider &&
    block.signatureProvider !== currentProvider &&
    !(
      acceptsAnthropicSignatures &&
      block.signatureProvider === ModelProvider.ANTHROPIC
    )
  ) {
    return ThinkingDowngradeReason.CrossProvider;
  }

  if (
    !block.signatureProvider &&
    block.signature?.startsWith('{') &&
    currentProvider !== ModelProvider.OPENAI
  ) {
    return ThinkingDowngradeReason.OpenAIHeuristic;
  }

  return null;
}

function isToolResultContentBlock(
  block: ContentBlock
): block is TextBlock | ImageBlock | DocumentBlock {
  return (
    block.type === MessageContentBlockType.Text ||
    block.type === MessageContentBlockType.Image ||
    block.type === MessageContentBlockType.Document
  );
}

interface NormalizeThinkingBlocksOptions {
  shouldDowngradeThinkingBlock?: (
    block: ThinkingBlock,
    index: number
  ) => boolean;
  forcedDowngradeReason?: ThinkingDowngradeReason;
}

/**
 * Normalize an assistant-message content array so thinking blocks that are
 * invalid for the current provider are downgraded to plain text blocks
 * (and dropped entirely when they have no reasoning text).
 *
 * Shared by request preparation and signature-error recovery.
 */
function normalizeThinkingBlocks(
  content: ContentBlock[],
  context: ThinkingNormalizationContext,
  options: NormalizeThinkingBlocksOptions = {}
): ContentBlock[] {
  return content.flatMap((block, index): ContentBlock[] => {
    if (
      block.type === MessageContentBlockType.ToolResult &&
      Array.isArray(block.content)
    ) {
      const normalizedContent = normalizeThinkingBlocks(
        block.content as ContentBlock[],
        context
      ).filter(isToolResultContentBlock);
      return [{ ...block, content: normalizedContent } as ContentBlock];
    }

    if (block.type !== MessageContentBlockType.Thinking) {
      return [block];
    }

    const thinkingBlock = block as ThinkingBlock;
    const downgradeReason = options.shouldDowngradeThinkingBlock?.(
      thinkingBlock,
      index
    )
      ? (options.forcedDowngradeReason ??
        ThinkingDowngradeReason.InvalidSignature)
      : getThinkingBlockDowngradeReason(thinkingBlock, context);

    if (!downgradeReason) {
      return [block];
    }

    const thinking = thinkingBlock.thinking?.trim();
    if (!thinking) {
      return [];
    }

    logInfo(
      '[prepareMessagesWithCaching] Downgrading thinking block to text (invalid signature)',
      {
        messageId: context.messageId,
        reason: downgradeReason,
      }
    );

    const textBlock: TextBlock = {
      type: MessageContentBlockType.Text,
      text: `<thinking>\n${thinking}\n</thinking>`,
    };
    return [textBlock];
  });
}

function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === MessageContentBlockType.Thinking;
}

function promoteLegacyGeminiThoughtSignature(
  msg: IndustryDroolMessage,
  context: ThinkingNormalizationContext
): IndustryDroolMessage {
  if (!('geminiThoughtSignature' in msg)) {
    return msg;
  }

  const { geminiThoughtSignature, ...messageWithoutLegacy } = msg;
  if (
    context.currentProvider !== ModelProvider.GOOGLE ||
    typeof geminiThoughtSignature !== 'string' ||
    !geminiThoughtSignature.trim() ||
    msg.role !== MessageRole.Assistant ||
    !Array.isArray(msg.content)
  ) {
    return messageWithoutLegacy;
  }

  const thinkingBlocks = msg.content.filter(isThinkingBlock);
  const nonGoogleSignatureProviders = [
    ...new Set(
      thinkingBlocks
        .map((block) => block.signatureProvider)
        .filter((provider) => provider && provider !== ModelProvider.GOOGLE)
    ),
  ];
  if (nonGoogleSignatureProviders.length > 0) {
    logWarn(
      '[prepareMessagesWithCaching] Ignoring legacy Gemini thought signature on mixed-provenance message',
      {
        messageId: msg.id,
        apiProviders: nonGoogleSignatureProviders.flatMap((p) =>
          p === undefined ? [] : [p]
        ),
      }
    );
    return messageWithoutLegacy;
  }

  if (thinkingBlocks.some((block) => block.signature?.trim())) {
    return messageWithoutLegacy;
  }

  let promoted = false;
  const content = msg.content.map((block) => {
    if (promoted || !isThinkingBlock(block)) {
      return block;
    }

    promoted = true;
    return {
      ...block,
      signature: geminiThoughtSignature,
      signatureProvider: ModelProvider.GOOGLE,
    };
  });

  return promoted ? { ...messageWithoutLegacy, content } : messageWithoutLegacy;
}

type StripResult = { content: ContentBlock[]; count: number };
type BlockStripper = (
  content: ContentBlock[],
  blockIndex?: number
) => StripResult;
type StripTarget = { messageIndex: number; blockIndex?: number };
interface StripProblematicThinkingBlocksResult {
  messages: IndustryDroolMessage[];
  strippedCount: number;
  lastStrippedMessageIndex?: number;
}

const EMPTY_TEXT_BLOCK: ContentBlock = {
  type: MessageContentBlockType.Text,
  text: '',
};

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === MessageContentBlockType.ToolUse;
}

function ensureNonEmpty(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.length > 0 ? blocks : [EMPTY_TEXT_BLOCK];
}

function clearGeminiSignatures(
  content: ContentBlock[],
  targetBlockIndex?: number
): StripResult {
  let count = 0;
  const cleaned = content.map((block, i) => {
    if (targetBlockIndex !== undefined && i !== targetBlockIndex) return block;

    if (isToolUseBlock(block) && block.thoughtSignature) {
      count++;
      const { thoughtSignature: _, ...rest } = block;
      return rest;
    }
    if (isThinkingBlock(block)) {
      count++;
      return { ...block, signature: '' };
    }
    return block;
  });
  return { content: cleaned, count };
}

function downgradeAnthropicThinkingBlocks(
  content: ContentBlock[],
  targetBlockIndex?: number
): StripResult {
  let count = 0;
  const cleaned = normalizeThinkingBlocks(
    content,
    {
      currentProvider: ModelProvider.ANTHROPIC,
      acceptsAnthropicSignatures: false,
    },
    {
      forcedDowngradeReason: ThinkingDowngradeReason.InvalidSignature,
      shouldDowngradeThinkingBlock: (_block, i) => {
        if (targetBlockIndex !== undefined && i !== targetBlockIndex) {
          return false;
        }
        count++;
        return true;
      },
    }
  );
  if (count === 0) return { content, count: 0 };
  return { content: ensureNonEmpty(cleaned), count };
}

function noopStripper(content: ContentBlock[]): StripResult {
  return { content, count: 0 };
}

function resolveSignatureErrorTarget(
  messages: IndustryDroolMessage[],
  location: ReturnType<typeof parseSignatureErrorLocation>,
  requestMessageCount?: number
): StripTarget | undefined {
  if (!location || location.messageIndex < 0) return undefined;
  if (requestMessageCount === undefined) return undefined;

  const fromEnd = requestMessageCount - 1 - location.messageIndex;
  if (fromEnd < 0) return undefined;

  const messageIndex = messages.length - 1 - fromEnd;
  if (messageIndex < 0 || messageIndex >= messages.length) return undefined;

  return {
    messageIndex,
    ...(location.blockIndex >= 0 ? { blockIndex: location.blockIndex } : {}),
  };
}

function stripFromMessages(
  messages: IndustryDroolMessage[],
  stripper: BlockStripper,
  target?: StripTarget,
  options: {
    clearGeminiThoughtSignature?: boolean;
    clearOpenAIReasoning?: boolean;
  } = {}
): StripProblematicThinkingBlocksResult {
  const clearGeminiThoughtSignature =
    options.clearGeminiThoughtSignature ?? false;
  const clearOpenAIReasoning = options.clearOpenAIReasoning ?? false;
  let strippedCount = 0;
  let lastStrippedMessageIndex: number | undefined;
  const cleaned = messages.map((msg, i) => {
    if (msg.role !== MessageRole.Assistant || !Array.isArray(msg.content)) {
      return msg;
    }
    if (target && i !== target.messageIndex) return msg;

    const { content, count } = stripper(msg.content, target?.blockIndex);
    const geminiCount =
      clearGeminiThoughtSignature && msg.geminiThoughtSignature ? 1 : 0;
    const openaiCount =
      clearOpenAIReasoning && msg.openaiEncryptedContent ? 1 : 0;
    const total = count + geminiCount + openaiCount;
    if (total === 0) return msg;

    strippedCount += total;
    lastStrippedMessageIndex = i;
    return {
      ...msg,
      content,
      ...(clearGeminiThoughtSignature
        ? { geminiThoughtSignature: undefined }
        : {}),
      ...(clearOpenAIReasoning
        ? {
            openaiEncryptedContent: undefined,
            openaiReasoningId: undefined,
            openaiReasoningSummary: undefined,
          }
        : {}),
    };
  });

  return { messages: cleaned, strippedCount, lastStrippedMessageIndex };
}

function stripProblematicThinkingBlocks(
  messages: IndustryDroolMessage[],
  error: unknown,
  requestMessageCount?: number
): StripProblematicThinkingBlocksResult {
  const location = parseSignatureErrorLocation(error);

  let stripper: BlockStripper;
  let clearGeminiThoughtSignature = false;
  let clearOpenAIReasoning = false;
  switch (location?.provider) {
    case 'gemini':
      stripper = clearGeminiSignatures;
      clearGeminiThoughtSignature = true;
      break;
    case 'openai':
      stripper = noopStripper;
      clearOpenAIReasoning = true;
      break;
    default:
      stripper = downgradeAnthropicThinkingBlocks;
  }
  let target = resolveSignatureErrorTarget(
    messages,
    location,
    requestMessageCount
  );
  let result = stripFromMessages(messages, stripper, target, {
    clearGeminiThoughtSignature,
    clearOpenAIReasoning,
  });

  if (target && result.strippedCount === 0) {
    logWarn(
      '[stripProblematicThinkingBlocks] Targeted strip missed (index mismatch between API request and conversation history), falling back to untargeted strip',
      { index: target.messageIndex }
    );
    target = undefined;
    result = stripFromMessages(messages, stripper, undefined, {
      clearGeminiThoughtSignature,
      clearOpenAIReasoning,
    });
  }

  logWarn('[stripProblematicThinkingBlocks] Stripped signature data', {
    count: result.strippedCount,
    found: target !== undefined,
    apiProvider: location?.provider,
  });
  return result;
}

export function resolveSignatureRecoveryRawAnchorIndex(params: {
  rawHistory: IndustryDroolMessage[];
  cleanedHistoryWithSummary: IndustryDroolMessage[];
  lastStrippedMessageIndex: number | undefined;
  lastSummary: { anchorId?: string; anchorIndex: number } | undefined;
}): number | undefined {
  const {
    rawHistory,
    cleanedHistoryWithSummary,
    lastStrippedMessageIndex,
    lastSummary,
  } = params;
  if (lastStrippedMessageIndex === undefined) return undefined;

  const lastStrippedMessage =
    cleanedHistoryWithSummary[lastStrippedMessageIndex];
  if (lastStrippedMessage?.id) {
    const idResolvedIndex = rawHistory.findIndex(
      (msg) => msg.id === lastStrippedMessage.id
    );
    if (idResolvedIndex >= 0) return idResolvedIndex;
  }

  let rawAnchorIndex: number | undefined;
  if (lastSummary) {
    if (lastStrippedMessageIndex > 0) {
      let summaryAnchorIndex = -1;
      if (lastSummary.anchorId) {
        summaryAnchorIndex = rawHistory.findIndex(
          (msg) => msg.id === lastSummary.anchorId
        );
      }
      if (summaryAnchorIndex < 0) {
        summaryAnchorIndex = lastSummary.anchorIndex;
      }
      rawAnchorIndex =
        Math.max(0, summaryAnchorIndex + 1) + lastStrippedMessageIndex - 1;
    }
  } else {
    rawAnchorIndex = lastStrippedMessageIndex;
  }

  if (
    rawAnchorIndex !== undefined &&
    (rawAnchorIndex < 0 || rawAnchorIndex >= rawHistory.length)
  ) {
    return undefined;
  }
  return rawAnchorIndex;
}

function hasToolResult(content: ContentBlock[]): boolean {
  return content.some(
    (block) => block.type === MessageContentBlockType.ToolResult
  );
}

function filterToolResultBlocks(
  content: ContentBlock[],
  msg: IndustryDroolMessage,
  validToolUseIds: Set<string>,
  seenToolIds: Set<string>
): ContentBlock[] {
  return content.filter((block) => {
    if (
      block.type === MessageContentBlockType.ToolResult &&
      'toolUseId' in block
    ) {
      if (seenToolIds.has(block.toolUseId)) {
        logWarn('[prepareMessagesWithCaching] Duplicate tool_result detected', {
          toolId: block.toolUseId,
          role: msg.role,
        });
        return false;
      }

      if (!validToolUseIds.has(block.toolUseId)) {
        logWarn(
          '[prepareMessagesWithCaching] Orphaned tool_result detected (no corresponding tool_use)',
          {
            toolId: block.toolUseId,
            role: msg.role,
          }
        );
        return false;
      }

      seenToolIds.add(block.toolUseId);
    }
    return true;
  });
}

/**
 * Prepare a conversation history for an outgoing LLM request by:
 *
 * 1. Trimming images/PDFs to within provider payload limits (oldest first).
 * 2. Downgrading thinking blocks whose signatures are invalid for the
 *    current provider to plain text.
 * 3. Dropping orphaned `tool_use` / `tool_result` pairs and duplicate
 *    `tool_result` blocks.
 * 4. Skipping messages whose content is empty after filtering.
 * 5. Stripping any pre-existing `cache_control` blocks and re-applying
 *    Anthropic prompt caching to at most two trailing messages.
 *
 * Extracted from `apps/cli/src/hooks/createLLMStreamingCore.ts` to share
 * with the forthcoming drool-core send-message engine. Behavior is intended
 * to match the CLI helper exactly.
 */
export function prepareMessagesWithCaching<
  TOptions extends PrepareMessagesWithCachingOptions | undefined = undefined,
>(
  conversationHistory: IndustryDroolMessage[],
  context: ThinkingNormalizationContext,
  options?: TOptions
): PrepareMessagesWithCachingReturn<TOptions> {
  const resolvedOptions: PrepareMessagesWithCachingOptions = options ?? {};
  const recovery = resolvedOptions.signatureRecovery
    ? stripProblematicThinkingBlocks(
        conversationHistory,
        resolvedOptions.signatureRecovery.error,
        resolvedOptions.signatureRecovery.requestMessageCount
      )
    : undefined;
  const sourceMessages = recovery?.messages ?? conversationHistory;
  const legacyNormalizedSourceMessages = sourceMessages.map((msg) =>
    promoteLegacyGeminiThoughtSignature(msg, context)
  );

  // Limit images and PDFs to avoid 413 errors - removes oldest first
  const imageLimitedHistory = limitConversationImages(
    legacyNormalizedSourceMessages
  );
  const mediaLimitedHistory = limitConversationPDFs(imageLimitedHistory);

  // First pass: collect all tool_use IDs from assistant messages and
  // tool_result IDs from user/tool messages. Older histories may store
  // Anthropic-shaped tool results on user messages, while newer histories use
  // role:tool.
  const validToolUseIds = new Set<string>();
  const validToolResultIds = new Set<string>();
  for (const msg of mediaLimitedHistory) {
    if (!Array.isArray(msg.content)) {
      continue;
    }

    if (msg.role === MessageRole.Assistant) {
      for (const block of msg.content) {
        if (block.type === MessageContentBlockType.ToolUse && block.id) {
          validToolUseIds.add(block.id);
        }
      }
    }
    for (const block of msg.content) {
      if (
        block.type === MessageContentBlockType.ToolResult &&
        'toolUseId' in block
      ) {
        validToolResultIds.add(block.toolUseId);
      }
    }
  }

  const seenToolIds = new Set<string>();
  const seenToolUseIds = new Set<string>();
  const filteredHistory: IndustryDroolMessage[] = [];

  for (const msg of mediaLimitedHistory) {
    if (msg.role === MessageRole.Assistant) {
      const filteredAssistantContent = msg.content.filter((block) => {
        if (block.type === MessageContentBlockType.ToolUse && block.id) {
          if (seenToolUseIds.has(block.id)) {
            logWarn(
              '[prepareMessagesWithCaching] Duplicate tool_use detected',
              {
                toolId: block.id,
                role: msg.role,
              }
            );
            return false;
          }

          if (!validToolResultIds.has(block.id)) {
            logWarn(
              '[prepareMessagesWithCaching] Orphaned tool_use detected (no corresponding tool_result)',
              {
                toolId: block.id,
                role: msg.role,
              }
            );
            return false;
          }

          seenToolUseIds.add(block.id);
        }
        return true;
      });

      const normalizedAssistantContent = normalizeThinkingBlocks(
        filteredAssistantContent,
        {
          ...context,
          messageId: msg.id,
        }
      );

      const hasTextContent = hasUsableTextContent(normalizedAssistantContent);
      const hasToolUse = normalizedAssistantContent.some(
        (block) => block.type === MessageContentBlockType.ToolUse
      );

      if (
        normalizedAssistantContent.length === 0 ||
        (!hasTextContent && !hasToolUse)
      ) {
        continue;
      }

      filteredHistory.push({
        ...msg,
        content: normalizedAssistantContent,
      });
      continue;
    }

    if (
      Array.isArray(msg.content) &&
      (msg.role === MessageRole.Tool || hasToolResult(msg.content))
    ) {
      const filteredContent = normalizeThinkingBlocks(
        filterToolResultBlocks(msg.content, msg, validToolUseIds, seenToolIds),
        {
          ...context,
          messageId: msg.id,
        }
      );

      const hasTextContent = hasUsableTextContent(filteredContent);
      const containsToolResult = hasToolResult(filteredContent);

      if (
        filteredContent.length === 0 ||
        (!hasTextContent && !containsToolResult)
      ) {
        continue;
      }

      filteredHistory.push({
        ...msg,
        content: filteredContent,
      });
      continue;
    }

    filteredHistory.push(msg);
  }

  // Strip any pre-existing cache_control blocks so we have full control.
  const messagesToUse: IndustryDroolMessageWithCaching[] = filteredHistory.map(
    (msg) => ({
      ...msg,
      content: Array.isArray(msg.content)
        ? msg.content.map((block) => {
            const { cache_control: _, ...blockWithoutCache } = block as {
              cache_control?: unknown;
            } & typeof block;
            return blockWithoutCache;
          })
        : msg.content,
    })
  );

  // Apply cache control to up to 2 conversation messages (reserves 2 of the
  // 4 Anthropic prompt-caching blocks for the system prompt).
  let cacheControlBlocksUsed = 0;
  const maxCacheControlBlocks = 2;

  const hasAssistantMessage = messagesToUse.some(
    (msg) => msg.role === MessageRole.Assistant
  );

  // Single-message first-request path: cache the very first text block, which
  // usually contains the system reminder. Multi-message first requests still
  // prioritize the final two messages below.
  if (!hasAssistantMessage && messagesToUse.length === 1) {
    const firstMessage = messagesToUse[0];
    if (
      firstMessage.role === MessageRole.User &&
      Array.isArray(firstMessage.content)
    ) {
      const firstTextIndex = firstMessage.content.findIndex(
        (block) => block.type === MessageContentBlockType.Text
      );
      if (firstTextIndex >= 0) {
        messagesToUse[0] = {
          ...firstMessage,
          content: firstMessage.content.map((block, index) => {
            if (
              index === firstTextIndex &&
              block.type === MessageContentBlockType.Text
            ) {
              return {
                ...block,
                cache_control: { type: 'ephemeral' as const },
              };
            }
            return block;
          }),
        };
        cacheControlBlocksUsed++;
      }
    }
  }

  if (messagesToUse.length >= 2) {
    const cacheIndex = messagesToUse.length - 2;
    const messageToCache = messagesToUse[cacheIndex];

    if (typeof messageToCache.content === 'string') {
      messagesToUse[cacheIndex] = {
        ...messageToCache,
        content: [
          {
            type: MessageContentBlockType.Text,
            text: messageToCache.content,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
      };
      cacheControlBlocksUsed++;
    } else if (Array.isArray(messageToCache.content)) {
      const lastCacheableIndex = messageToCache.content.findLastIndex(
        (block) =>
          block.type === MessageContentBlockType.Text ||
          block.type === MessageContentBlockType.ToolResult ||
          block.type === MessageContentBlockType.ToolUse
      );
      if (lastCacheableIndex >= 0) {
        messagesToUse[cacheIndex] = {
          ...messageToCache,
          content: messageToCache.content.map((block, index) => {
            if (
              index === lastCacheableIndex &&
              (block.type === MessageContentBlockType.Text ||
                block.type === MessageContentBlockType.ToolResult ||
                block.type === MessageContentBlockType.ToolUse)
            ) {
              return {
                ...block,
                cache_control: { type: 'ephemeral' as const },
              };
            }
            return block;
          }),
        };
        cacheControlBlocksUsed++;
      }
    }
  }

  if (
    cacheControlBlocksUsed < maxCacheControlBlocks &&
    messagesToUse.length >= 1
  ) {
    const lastIndex = messagesToUse.length - 1;
    const lastMessage = messagesToUse[lastIndex];

    if (
      [MessageRole.Assistant, MessageRole.User, MessageRole.Tool].includes(
        lastMessage.role
      )
    ) {
      if (typeof lastMessage.content === 'string') {
        messagesToUse[lastIndex] = {
          ...lastMessage,
          content: [
            {
              type: MessageContentBlockType.Text,
              text: lastMessage.content,
              cache_control: { type: 'ephemeral' as const },
            },
          ],
        };
      } else if (Array.isArray(lastMessage.content)) {
        const lastCacheableIndex = lastMessage.content.findLastIndex(
          (block) =>
            block.type === MessageContentBlockType.Text ||
            block.type === MessageContentBlockType.ToolResult ||
            block.type === MessageContentBlockType.ToolUse
        );
        if (lastCacheableIndex >= 0) {
          messagesToUse[lastIndex] = {
            ...lastMessage,
            content: lastMessage.content.map((block, index) => {
              if (
                index === lastCacheableIndex &&
                (block.type === 'text' ||
                  block.type === 'tool_result' ||
                  block.type === 'tool_use')
              ) {
                return {
                  ...block,
                  cache_control: { type: 'ephemeral' as const },
                };
              }
              return block;
            }),
          };
        }
      }
    }
  }

  if (resolvedOptions.returnMetadata) {
    const result: PreparedMessagesWithCachingResult = {
      messages: messagesToUse,
      sourceMessages: legacyNormalizedSourceMessages,
      strippedCount: recovery?.strippedCount ?? 0,
    };
    if (recovery?.lastStrippedMessageIndex !== undefined) {
      result.lastStrippedMessageIndex = recovery.lastStrippedMessageIndex;
    }
    return result as PrepareMessagesWithCachingReturn<TOptions>;
  }

  return messagesToUse as PrepareMessagesWithCachingReturn<TOptions>;
}
