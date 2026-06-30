import { YOU_ARE_DROOL_SYSTEM_PROMPT } from '@industry/common/cli';
import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import {
  TextBlock,
  CacheLabel,
  MessageContentBlockType,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logWarn } from '@industry/logging';
import { getLLMConfig } from '@industry/utils/llm';

import { SYSTEM_PROMPT } from '@/hooks/constants';
import {
  riskLevelNudgeForGemini,
  specModeNudgeForGemini,
  toolPreferenceNudgeForGemini,
  todoToolNudgeForGemini,
} from '@/hooks/geminiSystemPrompt';
import {
  markdownSpecForGpt5,
  cliPreferenceSpecForGpt5,
  persistenceSpecForGpt51,
} from '@/hooks/gpt5SystemPrompt';
import { noCommentsSpecForOpus47 } from '@/hooks/opus47SystemPrompt';
import { BuildSystemMessageParams } from '@/hooks/types';

/**
 * Build system message blocks for LLM requests.
 * This is the core logic extracted from createSystemMessage for testability.
 */

export function buildSystemMessageBlocks({
  modelId,
  modelProvider,
  tools,
  systemPromptOverride,
}: BuildSystemMessageParams): (TextBlock & CacheLabel)[] {
  // Resolve registry config once for model-specific prompt additions
  let modelConfig: ReturnType<typeof getLLMConfig> | undefined;
  if (modelId) {
    try {
      modelConfig = getLLMConfig({ modelId });
    } catch (err) {
      logWarn(
        '[buildSystemMessageBlocks] No registry config for model, skipping prompt additions',
        { modelId, cause: err }
      );
    }
  }

  const systemMessageBlocks: (TextBlock & CacheLabel)[] = [
    {
      type: MessageContentBlockType.Text,
      text: YOU_ARE_DROOL_SYSTEM_PROMPT,
    },
    {
      type: MessageContentBlockType.Text,
      text: systemPromptOverride ?? SYSTEM_PROMPT,
    },
  ];

  if (modelConfig?.systemPromptAdditions?.noComments) {
    systemMessageBlocks.push({
      type: MessageContentBlockType.Text,
      text: noCommentsSpecForOpus47(),
    });
  }

  // Add GPT-5 specific instructions
  if (modelProvider === ModelProvider.OPENAI) {
    systemMessageBlocks.push({
      type: MessageContentBlockType.Text,
      text: markdownSpecForGpt5(),
    });

    const cliPreferenceSpec = cliPreferenceSpecForGpt5(tools);
    if (cliPreferenceSpec) {
      systemMessageBlocks.push({
        type: MessageContentBlockType.Text,
        text: cliPreferenceSpec,
      });
    }

    if (modelConfig?.systemPromptAdditions?.persistence) {
      systemMessageBlocks.push({
        type: MessageContentBlockType.Text,
        text: persistenceSpecForGpt51(),
      });
    }
  }

  // Add Gemini specific instructions
  if (modelProvider === ModelProvider.GOOGLE) {
    systemMessageBlocks.push({
      type: MessageContentBlockType.Text,
      text: riskLevelNudgeForGemini(),
    });
    systemMessageBlocks.push({
      type: MessageContentBlockType.Text,
      text: toolPreferenceNudgeForGemini(),
    });
    systemMessageBlocks.push({
      type: MessageContentBlockType.Text,
      text: specModeNudgeForGemini(),
    });
    systemMessageBlocks.push({
      type: MessageContentBlockType.Text,
      text: todoToolNudgeForGemini(),
    });
  }

  // Add cache_control to last block
  const lastIndex = systemMessageBlocks.length - 1;
  if (lastIndex >= 0) {
    systemMessageBlocks[lastIndex] = {
      ...systemMessageBlocks[lastIndex],
      cache_control: { type: 'ephemeral' as const },
    };
  }

  return systemMessageBlocks;
}
