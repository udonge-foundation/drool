import Anthropic from '@anthropic-ai/sdk';

import {
  IndustryDroolMessage,
  MessageContentBlockType,
  MessageRole,
  TextBlock,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';
import { logInfo, logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { approxTokensFromChars } from '@industry/utils/llm';

import { CompactionSummaryKind } from '@/hooks/compaction/enums';
import type {
  CompactAnchoredAtLastMessageParams,
  CompactParams,
  CompactResult,
} from '@/hooks/compaction/types';
import { HookEventName, PermissionMode } from '@/hooks/enums';
import { getHookService } from '@/services/HookService';
import { getSessionService } from '@/services/SessionService';
import { formatSystemReminder } from '@/utils/systemInfo';
import { SystemInfo } from '@/utils/types';

import type { TodoWriteToolParams } from '@industry/drool-core/tools/definitions/todo';

const SUMMARY_SOFT_CAP_DEFAULT = 2000;
/**
 * Output-token budget reserved for the compaction summary. Doubles as the
 * summarizer's max output tokens, so it must cover what models actually
 * produce: prod p90 summary length is ~4K tokens and p99 ~7K, so 8000
 * keeps the long tail intact instead of truncating it mid-sentence.
 */
const SUMMARY_RESERVE_DEFAULT = 8000;

/**
 * Safe JSON stringify with fallback length
 */
function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Estimates tokens for a single Anthropic message by counting characters in text-bearing fields.
 * - Counts: text, thinking, tool_result content (string or JSON length), tool_use name + JSON input
 * - Ignores: image blocks
 */
function estimateMessageTokens(message: IndustryDroolMessage): number {
  let charCount = 0;
  const content = message.content;

  for (const block of content) {
    if (typeof block === 'string') {
      charCount += (block as string).length;
    } else {
      switch (block.type) {
        case 'text':
          charCount += (block.text ?? '').length;
          break;
        case 'thinking':
          // thinking blocks use `thinking` field per Anthropic SDK types
          // Count raw thinking text length
          charCount += (block.thinking ?? '').length;
          break;
        case 'tool_result': {
          // tool_result may have content: string | Array<text/...>
          // Count string directly; otherwise fallback to JSON length
          const c: unknown = block.content !== undefined ? block.content : '';
          if (typeof c === 'string') {
            charCount += c.length;
          } else {
            charCount += safeJsonLength(c);
          }
          break;
        }
        case 'tool_use': {
          // Count tool name + JSON input
          // name is required, input is object
          const name = block.name ?? '';
          const input = block.input;
          charCount += name.length + safeJsonLength(input);
          break;
        }
        case 'image':
          // Ignore images for token estimation for now
          break;
        default:
          // Fallback: best effort stringify
          charCount += safeJsonLength(block);
          break;
      }
    }
  }
  return approxTokensFromChars(charCount);
}

/**
 * Estimates tokens for system prompt and selected tools.
 * - System: sum lengths of text blocks
 * - Tools: name + description + JSON length of input_schema
 */
function estimateSystemToolsTokens(
  system: TextBlock[],
  tools: Anthropic.Tool[]
): number {
  let charCount = 0;
  // System text blocks
  for (const block of system) {
    if (block.type === 'text') {
      charCount += (block.text ?? '').length;
    }
  }
  // Tools
  for (const tool of tools) {
    const nameLen = (tool.name ?? '').length;
    const descLen = (tool.description ?? '').length;
    const schemaLen = safeJsonLength(tool.input_schema);
    charCount += nameLen + descLen + schemaLen;
  }
  return approxTokensFromChars(charCount);
}

/**
 * Estimate tokens for a summary string
 */
function estimateSummaryTokens(text: string): number {
  return approxTokensFromChars(text.length);
}

/**
 * Creates an injected summary message
 * @param text Summary text to inject
 * @param systemInfo Optional system info from when summary was created
 * @returns Anthropic.MessageParam with the summary
 */
function injectedSummary(
  text: string,
  systemInfo?: SystemInfo,
  summaryKind: CompactionSummaryKind = CompactionSummaryKind.LlmSummary
): IndustryDroolMessage {
  if (summaryKind === CompactionSummaryKind.ProviderSwitchSerialization) {
    const backtickRuns = text.match(/`+/g) ?? [];
    const maxRun = backtickRuns.reduce(
      (acc, run) => Math.max(acc, run.length),
      0
    );
    const fence = '`'.repeat(Math.max(3, maxRun + 1));

    const transcript = `${fence}text\n${text}\n${fence}`;
    const toolCallReminder =
      'When making tool calls, always use your native tool calling schema — do not replicate the text format shown in the transcript above.';
    const base = systemInfo
      ? `${formatSystemReminder(systemInfo, undefined, getSessionService().getCurrentSessionTags(), getSessionService().getCurrentSessionOrigin())}\n\nThe following prefix of this conversation has been serialized to maintain compatibility across model providers.\n\n${transcript}\n\n${toolCallReminder}`
      : `The following prefix of this conversation has been serialized to maintain compatibility across model providers.\n\n${transcript}\n\n${toolCallReminder}`;
    const content = base;

    return {
      id: `injected-summary-${Date.now()}`,
      role: MessageRole.User,
      content: [
        {
          type: MessageContentBlockType.Text,
          text: content,
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // Note: visibility would be set by the caller if needed
    };
  }

  const base = `A previous instance of Drool has summarized the conversation thus far as follows:

<summary>
${text}
</summary>

IMPORTANT: This summary was created by a previous instance of Drool. Files referenced in the summary may not be available until you explicitly view them again.`;

  const content = systemInfo
    ? `${base}\n\n${formatSystemReminder(systemInfo, undefined, getSessionService().getCurrentSessionTags(), getSessionService().getCurrentSessionOrigin())}`
    : base;

  return {
    id: `injected-summary-${Date.now()}`,
    role: MessageRole.User,
    content: [
      {
        type: MessageContentBlockType.Text,
        text: content,
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // Note: visibility would be set by the caller if needed
  };
}

/**
 * Formats TODO list for inclusion in summary
 * @param todos TODO list to format
 * @returns Formatted TODO string
 */
export function formatTodoForSummary(todos: TodoWriteToolParams): string {
  const items = todos.todos || [];
  if (items.length === 0) return '';

  let result = 'Current TODO List:\n';
  items.forEach((item) => {
    result += `${item.status} [${item.priority}] ${item.content}\n`;
  });
  return result;
}

/**
 * Extracts the latest TodoWrite tool call from messages
 * @param messages Array of Anthropic messages to search
 * @returns TODO data with character count, or undefined if not found
 */
function extractLatestTodoFromMessages(
  messages: IndustryDroolMessage[]
): { todos: TodoWriteToolParams; charCount: number } | undefined {
  // Search backwards through messages for the latest TodoWrite tool_use
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;

    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        block.name === 'TodoWrite' &&
        block.input
      ) {
        const inputData = block.input as { todos?: unknown };
        if (inputData.todos && Array.isArray(inputData.todos)) {
          const todoParams: TodoWriteToolParams = {
            todos: inputData.todos as TodoWriteToolParams['todos'],
          };
          const todoText = formatTodoForSummary(todoParams);
          return {
            todos: todoParams,
            charCount: todoText.length,
          };
        }
      }
    }
  }
  return undefined;
}

interface LoadedSkill {
  name: string;
  content: string;
}

/**
 * Formats loaded skills for inclusion in summary
 */
export function formatSkillsForSummary(skills: LoadedSkill[]): string {
  if (skills.length === 0) return '';

  const skillNames = skills.map((s) => `"${s.name}"`).join(', ');
  let result = `The following skills were active before compaction: ${skillNames}.\nIf you are about to perform a task related to any of these skills, re-invoke the skill using the Skill tool first to reload its full instructions.\n`;
  for (const skill of skills) {
    result += `\nPreviously loaded skill: ${skill.name}\n`;
  }
  return result;
}

/**
 * Extracts skill name from a skill content block using the <skill> tag format.
 * Handles both Skill tool format (name= attribute) and slash command format (<name> element).
 */
function extractSkillNameFromContent(content: string): string | undefined {
  // Skill tool format: <skill name="..." filePath="...">
  const nameAttrMatch = content.match(/<skill\s[^>]*name="([^"]+)"/);
  if (nameAttrMatch) return nameAttrMatch[1];

  // Slash command format: <skill filePath="..."><name>...</name>
  const nameElementMatch = content.match(/<name>([^<]+)<\/name>/);
  if (nameElementMatch) return nameElementMatch[1];

  return undefined;
}

/**
 * Extracts all unique loaded skills from messages by finding Skill tool_use
 * blocks and their corresponding tool_result responses, as well as skills
 * loaded via slash commands (user messages with <skill> tags).
 * Returns the last invocation of each skill (by name) to get the latest content.
 */
export function extractLoadedSkillsFromMessages(
  messages: IndustryDroolMessage[]
): { skills: LoadedSkill[]; charCount: number } {
  // Map from skill name to its content (last invocation wins)
  const skillMap = new Map<string, string>();
  // Track tool_use IDs for Skill calls so we can find matching tool_results
  const skillToolUseMap = new Map<string, string>(); // tool_use id -> skill name

  for (const msg of messages) {
    const content = Array.isArray(msg.content) ? msg.content : [];

    if (msg.role === 'assistant') {
      for (const block of content) {
        if (
          block.type === 'tool_use' &&
          block.name === 'Skill' &&
          block.input
        ) {
          const inputData = block.input as { skill?: string };
          if (inputData.skill && block.id) {
            skillToolUseMap.set(block.id, inputData.skill);
          }
        }
      }
    }

    if (msg.role === 'tool') {
      for (const block of content) {
        if (block.type === 'tool_result' && block.toolUseId) {
          const skillName = skillToolUseMap.get(block.toolUseId);
          if (skillName) {
            const resultContent =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((b: { type: string }) => b.type === 'text')
                      .map((b: { type: string; text?: string }) => b.text ?? '')
                      .join('')
                  : '';

            if (resultContent && !block.isError) {
              skillMap.set(skillName, resultContent);
            }
          }
        }
      }
    }

    // Also check user messages for skills loaded via slash commands
    // These contain <skill filePath="..."><name>...</name> within system notification tags
    if (msg.role === 'user') {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = block.text;
          // Match <skill ...>...</skill> blocks in user messages
          const skillRegex = /<skill\s[^>]*>[\s\S]*?<\/skill>/g;
          const matches = text.matchAll(skillRegex);
          for (const m of matches) {
            const skillBlock = m[0];
            const name = extractSkillNameFromContent(skillBlock);
            if (name) {
              skillMap.set(name, skillBlock);
            }
          }
        }
      }
    }
  }

  const skills: LoadedSkill[] = Array.from(skillMap.entries()).map(
    ([name, content]) => ({ name, content })
  );
  const formattedText = formatSkillsForSummary(skills);
  return { skills, charCount: formattedText.length };
}

/**
 * Checks if a message is a tool result message
 * @param message The message to check
 * @returns True if the message is a tool result
 */
function isToolResultMessage(message: IndustryDroolMessage): boolean {
  if (message.role !== 'tool') return false;

  const content = message.content;
  if (!Array.isArray(content)) return false;

  return content.some((block) => block.type === 'tool_result');
}

/**
 * Compact conversation after a context-limit error by truncating head and attaching a fresh summary.
 * Always generates a new (delta) summary when possible.
 * @param params Compaction parameters
 * @returns Compaction result
 */
export async function compactAfterContextLimit(
  params: CompactParams
): Promise<CompactResult> {
  const {
    messages,
    system,
    tools,
    summarize,
    lastSummary,
    systemInfo,
    signal,
  } = params as CompactParams & { signal?: AbortSignal };

  // Default thresholds
  const thresholds = {
    postAbsolute: params.thresholds?.postAbsolute ?? 40_000,
    summarySoftCap:
      params.thresholds?.summarySoftCap ?? SUMMARY_SOFT_CAP_DEFAULT,
    summaryReserve:
      params.thresholds?.summaryReserve ?? SUMMARY_RESERVE_DEFAULT,
  };

  logInfo('[Compaction] Start (context limit)', {
    messageThreadLength: messages.length,
  });

  // Extract latest TODO list and calculate its token count
  const todoData = extractLatestTodoFromMessages(messages);
  const todoTokens = todoData ? approxTokensFromChars(todoData.charCount) : 0;

  if (todoData) {
    logInfo('[Compaction] Found TODO list', {
      count: todoData.todos.todos?.length ?? 0,
      tokens: todoTokens,
    });
  }

  // Extract loaded skills and calculate their token count
  const skillData = extractLoadedSkillsFromMessages(messages);
  const skillTokens =
    skillData.skills.length > 0
      ? approxTokensFromChars(skillData.charCount)
      : 0;

  if (skillData.skills.length > 0) {
    logInfo('[Compaction] Found loaded skills', {
      count: skillData.skills.length,
      skillNames: skillData.skills.map((s) => s.name),
      tokens: skillTokens,
    });
  }

  const postThreshold = thresholds.postAbsolute;
  // Estimate context tokens (system + tools)
  const contextTokens = estimateSystemToolsTokens(system, tools);

  // Estimate per-message tokens
  const msgTokens = messages.map(estimateMessageTokens);
  logInfo('[Compaction] Context & message tokens (approx)', {
    contextMaxTokens: contextTokens,
    messageTokens: Array.from(msgTokens),
    totalHistoryTokens: msgTokens.reduce((acc, count) => acc + count, 0),
  });

  // Subarray sum helper
  const sumRange = (start: number, end: number): number => {
    let s = 0;
    for (let i = start; i < end; i++) s += msgTokens[i] ?? 0;
    return s;
  };

  const N = messages.length;

  // Generate new summary
  // Find a good suffix start index using token budget
  // Adjust summaryReserve to include TODO and skill tokens
  const effectiveSummaryReserve =
    thresholds.summaryReserve + todoTokens + skillTokens;
  let suffixStart = N;
  let suffixTokens = 0; // tokens for messages[suffixStart..N-1]
  const targetSuffixTokens = Math.max(
    0,
    postThreshold - effectiveSummaryReserve - contextTokens
  );

  // Walk from the start to get the largest suffix that fits
  suffixTokens = sumRange(0, N);
  for (let i = 0; i < N; i++) {
    suffixTokens -= msgTokens[i] ?? 0;
    // Conditions for anchor / suffix selection:
    // 1. Suffix tokens must fit in target budget
    // 2. Our suffix cannot start with a tool result message
    if (
      suffixTokens <= targetSuffixTokens &&
      (i + 1 === N || !isToolResultMessage(messages[i + 1]))
    ) {
      suffixStart = i + 1;
      break;
    }
  }

  logInfo('[Compaction] Suffix selection', {
    maxTokensAfterCompaction: targetSuffixTokens,
    keptMessagesStartIndex: suffixStart,
    suffixTokens,
  });

  // This shouldn't happen
  try {
    if (suffixStart === 0) {
      throw new MetaError('[Compaction] No prefix messages to summarize');
    }
  } catch (e) {
    logException(e, '[Compaction] No prefix messages to summarize');
    return {
      compacted: messages,
      removedCount: 0,
      reusedSummary: false,
    };
  }

  let summaryText: string;

  const lastSummaryKind =
    lastSummary?.summaryKind ?? CompactionSummaryKind.LlmSummary;
  const usableLastSummary =
    lastSummary &&
    (lastSummaryKind === CompactionSummaryKind.LlmSummary ||
      lastSummaryKind === CompactionSummaryKind.ProviderSwitchSerialization)
      ? lastSummary
      : undefined;
  if (lastSummary && !usableLastSummary) {
    logInfo(
      '[Compaction] Ignoring non-LLM lastSummary for delta compaction (context limit)',
      {
        summaryKind: lastSummary.summaryKind,
      }
    );
  }

  if (usableLastSummary) {
    const deltaStart = Math.max(0, usableLastSummary.anchorIndex + 1);
    const segment = messages.slice(deltaStart);
    logInfo('[Compaction] Summarizing history (delta)', {
      usesConversationSummary: true,
      messagesToSummarizeCount: segment.length,
    });
    summaryText = await summarize({
      messages: segment,
      sessionId: params.sessionId,
      previousSummary: usableLastSummary.text,
      previousSummaryTokens: usableLastSummary.tokens,
      summarySoftCap: thresholds.summarySoftCap,
      summaryReserve: effectiveSummaryReserve,
      latestTodos: todoData?.todos,
      signal,
    });
  } else {
    logInfo('[Compaction] Summarizing history', {
      usesConversationSummary: false,
      messagesToSummarizeCount: messages.length,
    });
    summaryText = await summarize({
      messages,
      sessionId: params.sessionId,
      latestTodos: todoData?.todos,
      signal,
    });
  }

  // Append loaded skills to the summary so they survive compaction
  if (skillData.skills.length > 0) {
    const skillsText = formatSkillsForSummary(skillData.skills);
    if (skillsText) {
      summaryText += `\n\n${skillsText}`;
    }
  }

  const summaryMessage = injectedSummary(summaryText, systemInfo);
  const summaryTokens = estimateSummaryTokens(summaryText);

  // Success - return compacted result
  const suffix = messages.slice(suffixStart);
  const compactedHistory = [summaryMessage, ...suffix];

  const anchorIndex = suffixStart - 1;
  const anchorId = messages[anchorIndex].id;

  logInfo('[Compaction] New summary created', {
    summaryOutputTokens: summaryTokens,
    index: suffixStart - 1,
    messageId: anchorId,
    numMessagesRemoved: suffixStart,
  });
  return {
    compacted: compactedHistory,
    removedCount: suffixStart,
    reusedSummary: false,
    newSummaryText: summaryText,
    newSummaryAnchorIndex: anchorIndex,
    newSummaryAnchorId: anchorId,
    newSummaryTokens: summaryTokens,
  };
}

/**
 * Attach an existing summary to the conversation by injecting it and truncating the head.
 * If no lastSummary is provided, returns the messages unchanged.
 */
export function attachExistingSummary(params: {
  messages: IndustryDroolMessage[];
  lastSummary?: {
    text: string;
    anchorId?: string;
    anchorIndex: number;
    systemInfo?: SystemInfo;
    summaryKind?: CompactionSummaryKind;
  };
}): IndustryDroolMessage[] {
  const { messages, lastSummary } = params;
  if (!lastSummary) return messages;
  // Resolve anchor by id first (preferred), else fallback to index
  let resolvedIndex = -1;
  if (lastSummary.anchorId) {
    resolvedIndex = messages.findIndex((m) => m.id === lastSummary.anchorId);
    logInfo('[Compaction] Resolving summary anchor by ID', {
      messageId: lastSummary.anchorId,
      index: resolvedIndex,
    });
  }
  if (resolvedIndex < 0) {
    resolvedIndex = lastSummary.anchorIndex;
    logInfo('[Compaction] Resolving summary anchor by index', {
      index: resolvedIndex,
    });
  }
  let suffixStart = Math.max(0, (resolvedIndex ?? -1) + 1);

  // Harden against starting the suffix at a tool_result
  // This can happen if the conversation prefix changes since compaction occurred
  // It's not clear in what case this happens, so let's handle it gracefully for now and log
  // FAC-10581 is tracking investigation
  while (
    suffixStart < messages.length &&
    isToolResultMessage(messages[suffixStart])
  ) {
    logInfo('[Compaction] Adjusting suffix start to avoid tool_result', {
      index: lastSummary.anchorIndex + 1,
      adjustedIndex: suffixStart + 1,
    });
    suffixStart++;
  }

  const summaryMessage = injectedSummary(
    lastSummary.text,
    lastSummary.systemInfo,
    lastSummary.summaryKind ?? CompactionSummaryKind.LlmSummary
  );
  const suffix = messages.slice(suffixStart);
  logInfo('[Compaction] Attaching existing summary', {
    summary: lastSummary.text,
    index: resolvedIndex,
    messageId: lastSummary.anchorId,
    numMessagesRemoved: suffixStart,
  });
  return [summaryMessage, ...suffix];
}

/**
 * Force-compacts the entire conversation by summarizing up to the last message,
 * and uses that last message as the anchor. The resulting candidate contains only
 * the injected summary (no suffix), ensuring a clean provider switch point.
 */
export async function compactAnchoredAtLastMessage(
  params: CompactAnchoredAtLastMessageParams
): Promise<CompactResult> {
  const {
    messages,
    sessionId,
    summarize,
    lastSummary,
    signal,
    systemInfo,
    customInstructions,
  } = params;

  // Execute PreCompact hooks before starting compaction
  try {
    const currentMode = getSessionService().getCurrentAutonomyMode();
    const permissionMode =
      currentMode === AutonomyMode.Normal
        ? PermissionMode.Off
        : currentMode === AutonomyMode.Spec
          ? PermissionMode.Spec
          : currentMode === AutonomyMode.AutoLow
            ? PermissionMode.AutoLow
            : currentMode === AutonomyMode.AutoMedium
              ? PermissionMode.AutoMedium
              : PermissionMode.AutoHigh;

    // Estimate tokens for the messages
    let estimatedTokens = 0;
    for (const msg of messages) {
      estimatedTokens += estimateMessageTokens(msg);
    }

    const transcriptPath = getSessionService().getSessionTranscriptPath() || '';
    const hookResults = await getHookService().executeHooks({
      eventName: HookEventName.PreCompact,
      input: {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: process.cwd(),
        permission_mode: permissionMode,
        hook_event_name: HookEventName.PreCompact,
        trigger: customInstructions ? 'manual' : 'auto',
        custom_instructions: customInstructions,
        message_count: messages.length,
        estimated_tokens: estimatedTokens,
        message_id: undefined,
      },
    });

    // Check if any hook blocked the compaction
    for (const result of hookResults) {
      if (result.exitCode === 2 || result.exitCode === 3) {
        logInfo('[Compaction] PreCompact hook blocked compaction', {
          exitCode: result.exitCode,
          stderr: result.stderr,
        });
        // Return empty result - compaction blocked
        return {
          compacted: messages,
          removedCount: 0,
          reusedSummary: false,
        };
      }
    }
  } catch (error) {
    // Log but don't fail - hooks should never break compaction
    logException(error, '[Compaction] Error executing PreCompact hooks');
  }

  const N = messages.length;
  if (N === 0) {
    return {
      compacted: messages,
      removedCount: 0,
      reusedSummary: false,
    };
  }

  // Include latest TODO list in summary (like main compaction)
  const todoData = extractLatestTodoFromMessages(messages);

  // Extract loaded skills to preserve across compaction
  const skillData = extractLoadedSkillsFromMessages(messages);
  if (skillData.skills.length > 0) {
    logInfo('[Compaction] Found loaded skills for anchored compaction', {
      count: skillData.skills.length,
      skillNames: skillData.skills.map((s) => s.name),
    });
  }

  // Generate a new summary covering the entire conversation up to the last message.
  const usableLastSummary =
    lastSummary &&
    (lastSummary.summaryKind ?? CompactionSummaryKind.LlmSummary) ===
      CompactionSummaryKind.LlmSummary
      ? lastSummary
      : undefined;
  if (lastSummary && !usableLastSummary) {
    logInfo(
      '[Compaction] Ignoring non-LLM lastSummary for delta compaction (anchored)',
      {
        summaryKind: lastSummary.summaryKind,
      }
    );
  }

  const deltaStart = Math.max(0, (usableLastSummary?.anchorIndex ?? -1) + 1);
  const segment = messages.slice(deltaStart);
  let summaryText = await summarize({
    messages: segment,
    sessionId,
    previousSummary: usableLastSummary?.text,
    previousSummaryTokens: usableLastSummary?.tokens,
    summarySoftCap: SUMMARY_SOFT_CAP_DEFAULT,
    summaryReserve: SUMMARY_RESERVE_DEFAULT,
    latestTodos: todoData?.todos,
    signal,
    customInstructions,
  });

  // Append loaded skills to the summary so they survive compaction
  if (skillData.skills.length > 0) {
    const skillsText = formatSkillsForSummary(skillData.skills);
    if (skillsText) {
      summaryText += `\n\n${skillsText}`;
    }
  }

  const summaryTokens = estimateSummaryTokens(summaryText);
  const summaryMessage = injectedSummary(summaryText, systemInfo);

  const anchor = N - 1;
  const anchorId = anchor >= 0 ? messages[anchor].id : undefined;

  // Detailed anchor selection log for provider-switch compaction debugging
  if (anchor >= 0) {
    const anchorMsg = messages[anchor];
    logInfo('[Compaction] Provider switch anchor selected', {
      index: anchor,
      messageId: anchorMsg.id,
      role: anchorMsg.role,
    });
  }

  return {
    compacted: [summaryMessage],
    removedCount: N,
    reusedSummary: false,
    newSummaryText: summaryText,
    newSummaryAnchorIndex: anchor,
    newSummaryAnchorId: anchorId,
    newSummaryTokens: summaryTokens,
  };
}
