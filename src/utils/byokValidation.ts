import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { logWarn } from '@industry/logging';

import { getI18n } from '@/i18n';

import type { CustomModel } from '@industry/common/settings';

// Model name patterns that strongly suggest a specific provider should be used
const OPENAI_MODEL_PATTERNS = [/gpt-?5/i, /codex/i, /gpt-?4o/i, /o[1-9]-/i];

const ANTHROPIC_MODEL_PATTERNS = [/claude/i, /haiku/i, /sonnet/i, /opus/i];

/**
 * Validate BYOK custom model provider configuration and return a warning
 * message if the model name suggests a different provider should be used.
 */
export function validateByokProviderConfig(
  customModel: CustomModel
): string | undefined {
  const { model, provider } = customModel;

  // Check if model name looks like an OpenAI model but provider is not "openai"
  if (provider !== ModelProvider.OPENAI) {
    const matchesOpenAI = OPENAI_MODEL_PATTERNS.some((p) => p.test(model));
    if (matchesOpenAI) {
      logWarn('[BYOK] Model name suggests OpenAI but provider is different', {
        modelId: model,
        apiProvider: provider,
        correctedApiProvider: 'openai',
      });
      return getI18n().t('errors:agent.byokOpenAIMismatch', {
        model,
        provider,
      });
    }
  }

  // Check if model name looks like a Claude model but provider is not "anthropic"
  if (provider !== ModelProvider.ANTHROPIC) {
    const matchesAnthropic = ANTHROPIC_MODEL_PATTERNS.some((p) =>
      p.test(model)
    );
    if (matchesAnthropic) {
      logWarn(
        '[BYOK] Model name suggests Anthropic but provider is different',
        {
          modelId: model,
          apiProvider: provider,
          correctedApiProvider: 'anthropic',
        }
      );
      return getI18n().t('errors:agent.byokAnthropicMismatch', {
        model,
        provider,
      });
    }
  }

  return undefined;
}
