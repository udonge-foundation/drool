import { Box, Text } from 'ink';
import { useState } from 'react';

import type { CustomModel } from '@industry/common/settings';
import { ModelProvider } from '@industry/drool-sdk-ext/protocol/llm';
import { ManagedCustomModelSchema } from '@industry/drool-sdk-ext/protocol/settings';
import { buildCustomModelId, isCustomModelBaseUrlAllowed } from '@industry/utils/models';

import { COLORS } from '@/components/chat/themedColors';
import { TextInput } from '@/components/common/TextInput';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getSettingsService } from '@/services/SettingsService';
import { validateByokProviderConfig } from '@/utils/byokValidation';

type ProviderOption = {
  label: string;
  provider: ModelProvider;
};

type FieldKey = 'displayName' | 'model' | 'baseUrl' | 'apiKey';

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    label: 'OpenAI-compatible',
    provider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
  },
  {
    label: 'OpenAI-compatible (Responses API)',
    provider: ModelProvider.OPENAI,
  },
  {
    label: 'Anthropic-compatible',
    provider: ModelProvider.ANTHROPIC,
  },
];

const FIELD_KEYS: FieldKey[] = ['displayName', 'model', 'baseUrl', 'apiKey'];

const FIELD_LABELS: Record<FieldKey, string> = {
  displayName: 'Display name',
  model: 'Model id',
  baseUrl: 'Base URL',
  apiKey: 'API key',
};

interface ByokProviderWizardProps {
  onCancel: () => void;
  onSaved: (displayName: string, warning?: string) => void;
}

export function ByokProviderWizard({
  onCancel,
  onSaved,
}: ByokProviderWizardProps) {
  const [step, setStep] = useState<'provider' | 'form'>('provider');
  const [providerIndex, setProviderIndex] = useState(0);
  const [activeFieldIndex, setActiveFieldIndex] = useState(0);
  const [values, setValues] = useState<Record<FieldKey, string>>({
    displayName: '',
    model: '',
    baseUrl: '',
    apiKey: '',
  });
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const selectedProvider = PROVIDER_OPTIONS[providerIndex];

  const save = async () => {
    if (isSaving) return;

    const model = values.model.trim();
    const baseUrl = values.baseUrl.trim();
    const apiKey = values.apiKey.trim();
    const displayName = values.displayName.trim() || model;

    if (!model) {
      setError('Model id is required.');
      setActiveFieldIndex(FIELD_KEYS.indexOf('model'));
      return;
    }
    if (!baseUrl) {
      setError('Base URL is required.');
      setActiveFieldIndex(FIELD_KEYS.indexOf('baseUrl'));
      return;
    }
    if (!apiKey) {
      setError('API key is required.');
      setActiveFieldIndex(FIELD_KEYS.indexOf('apiKey'));
      return;
    }

    try {
      new URL(baseUrl);
    } catch {
      setError('Base URL must be a valid URL.');
      setActiveFieldIndex(FIELD_KEYS.indexOf('baseUrl'));
      return;
    }

    const settingsService = getSettingsService();
    const policy = settingsService.getModelPolicy();
    if (policy.allowCustomModels === false) {
      setError('Custom models are not allowed by your organization policy.');
      return;
    }
    if (
      policy.allowedBaseUrls &&
      policy.allowedBaseUrls.length > 0 &&
      !isCustomModelBaseUrlAllowed(baseUrl, policy.allowedBaseUrls)
    ) {
      setError('This Base URL is not allowed by your organization policy.');
      return;
    }

    const index = settingsService.getCustomModels().length;
    const customModel: CustomModel = {
      model,
      provider: selectedProvider.provider,
      baseUrl,
      apiKey,
      displayName,
      index,
      id: buildCustomModelId(displayName, index),
    };

    const parsed = ManagedCustomModelSchema.safeParse(customModel);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid custom model.');
      return;
    }

    setIsSaving(true);
    try {
      const warning = validateByokProviderConfig(customModel);
      await settingsService.addCustomModel(customModel);
      onSaved(displayName, warning);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'Failed to save custom provider.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const submitField = () => {
    if (activeFieldIndex < FIELD_KEYS.length - 1) {
      setActiveFieldIndex((index) => index + 1);
      setError('');
      return;
    }
    void save();
  };

  useKeypressHandler(
    (_input, key) => {
      if (key.escape) {
        if (step === 'form') {
          setStep('provider');
          setError('');
        } else {
          onCancel();
        }
        return true;
      }

      if (step === 'provider') {
        if (key.upArrow) {
          setProviderIndex((index) => Math.max(0, index - 1));
          return true;
        }
        if (key.downArrow) {
          setProviderIndex((index) =>
            Math.min(PROVIDER_OPTIONS.length - 1, index + 1)
          );
          return true;
        }
        if (key.return) {
          setStep('form');
          setError('');
          return true;
        }
        return false;
      }

      if (key.upArrow) {
        setActiveFieldIndex((index) => Math.max(0, index - 1));
        setError('');
        return true;
      }
      if (key.downArrow || key.tab) {
        setActiveFieldIndex((index) =>
          Math.min(FIELD_KEYS.length - 1, index + 1)
        );
        setError('');
        return true;
      }
      return false;
    },
    { isActive: true }
  );

  return (
    <Box flexDirection="column">
      <Text>
        Add Custom/BYOK provider
        {step === 'form' ? ` · ${selectedProvider.label}` : ''}
      </Text>

      {step === 'provider' ? (
        <>
          <Box height={1} />
          <Text>Choose the API your endpoint is compatible with:</Text>
          <Box height={1} />
          {PROVIDER_OPTIONS.map((option, index) => (
            <Text
              key={option.label}
              color={index === providerIndex ? COLORS.primary : undefined}
            >
              {index === providerIndex ? '> ' : '  '}
              {option.label}
            </Text>
          ))}
        </>
      ) : (
        <>
          <Box height={1} />
          {FIELD_KEYS.map((fieldKey, index) => {
            const isActive = index === activeFieldIndex;
            const value = values[fieldKey];
            const shownValue =
              fieldKey === 'apiKey' && value ? '*'.repeat(value.length) : value;

            return (
              <Box key={fieldKey}>
                <Text color={isActive ? COLORS.primary : undefined}>
                  {isActive ? '> ' : '  '}
                  {FIELD_LABELS[fieldKey]}:{' '}
                </Text>
                {isActive ? (
                  <TextInput
                    value={value}
                    onChange={(nextValue) => {
                      setValues((current) => ({
                        ...current,
                        [fieldKey]: nextValue,
                      }));
                      setError('');
                    }}
                    onSubmit={submitField}
                    placeholder={
                      fieldKey === 'displayName' ? '(optional)' : ''
                    }
                    mask={fieldKey === 'apiKey' ? '*' : undefined}
                    focus
                  />
                ) : (
                  <Text color={value ? undefined : COLORS.text.muted}>
                    {shownValue ||
                      (fieldKey === 'displayName' ? '(optional)' : '')}
                  </Text>
                )}
              </Box>
            );
          })}
          {error && (
            <Box marginTop={1}>
              <Text color={COLORS.error}>{error}</Text>
            </Box>
          )}
          {isSaving && (
            <Box marginTop={1}>
              <Text color={COLORS.text.muted}>Saving custom provider...</Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
