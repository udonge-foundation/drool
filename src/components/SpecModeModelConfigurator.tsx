import { Box, Text } from 'ink';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  hasReasoningEnabled,
  isAnthropicModel,
  parseConcreteModelID,
} from '@industry/utils/llm';

import { COLORS } from '@/components/chat/themedColors';
import { SpecModeConfiguratorState } from '@/components/enums';
import { ModelSelector } from '@/components/ModelSelector';
import { ReasoningEffortSelector } from '@/components/ReasoningEffortSelector';
import type {
  SpecModeModelConfiguratorProps,
  SpecModeModelConfiguratorRef,
} from '@/components/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getTuiModelConfig } from '@/models/config';

import type { UserModelSelection } from '@industry/common/llm';

function isAnthropicModelById(rawId: string): boolean {
  const concrete = parseConcreteModelID(rawId);
  return concrete !== undefined && isAnthropicModel(concrete);
}

export const SpecModeModelConfigurator = forwardRef<
  SpecModeModelConfiguratorRef,
  SpecModeModelConfiguratorProps
>(function SpecModeModelConfigurator(
  {
    onClose,
    onBack,
    onStateChange,
    currentMainModel,
    currentSpecModel,
    currentMainReasoningEffort,
    currentSpecReasoningEffort,
    onSetSpecModel,
    onClearSpecModel,
  },
  ref
) {
  const { t } = useTranslation();
  const [state, setState] = useState<SpecModeConfiguratorState>(
    SpecModeConfiguratorState.Asking
  );
  const [selectedOption, setSelectedOption] = useState<'yes' | 'no' | 'clear'>(
    'no'
  );
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const specModelConfig = currentSpecModel
    ? getTuiModelConfig(currentSpecModel)
    : null;

  // Expose handleEsc method to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      handleEsc: () => {
        switch (state) {
          case SpecModeConfiguratorState.Asking:
            // At top level - go back to model selector
            if (onBack) {
              onBack();
            } else {
              onClose();
            }
            return true;
          case SpecModeConfiguratorState.SelectingModel:
            // In model selector - go back to asking
            setState(SpecModeConfiguratorState.Asking);
            return true;
          case SpecModeConfiguratorState.SelectingReasoning:
            // In reasoning selector - go back to model selector
            setState(SpecModeConfiguratorState.SelectingModel);
            return true;
          case SpecModeConfiguratorState.ClearConfirm:
            // Cancel clear - go back to asking
            setState(SpecModeConfiguratorState.Asking);
            return true;
          case SpecModeConfiguratorState.Error:
            // Dismiss error - go back to model selection
            setErrorMessage(null);
            setPendingModel(null);
            setState(SpecModeConfiguratorState.SelectingModel);
            return true;
          default:
            return false;
        }
      },
    }),
    [state, onBack, onClose]
  );

  // Notify parent when state changes to control global ESC handler
  useEffect(() => {
    if (onStateChange) {
      onStateChange(state);
    }
  }, [state, onStateChange]);

  useKeypressHandler(
    (input, key) => {
      if (state === SpecModeConfiguratorState.Error) {
        // Any key press returns to model selection
        setErrorMessage(null);
        setPendingModel(null); // Clear stale pending model
        setState(SpecModeConfiguratorState.SelectingModel);
        return;
      }

      if (state === SpecModeConfiguratorState.Asking) {
        if (key.escape || input === 'q') {
          // Use onBack if provided, otherwise onClose
          if (onBack) {
            onBack();
          } else {
            onClose();
          }
          return;
        }

        if (key.upArrow || key.downArrow) {
          if (currentSpecModel) {
            // If spec model exists, cycle through yes/no/clear
            setSelectedOption((prev) => {
              if (prev === 'yes') return key.upArrow ? 'clear' : 'no';
              if (prev === 'no') return key.upArrow ? 'yes' : 'clear';
              return key.upArrow ? 'no' : 'yes';
            });
          } else {
            // If no spec model, toggle between yes/no
            setSelectedOption((prev) => (prev === 'yes' ? 'no' : 'yes'));
          }
          return;
        }

        if (key.return) {
          if (selectedOption === 'yes') {
            setState(SpecModeConfiguratorState.SelectingModel);
          } else if (selectedOption === 'clear') {
            setState(SpecModeConfiguratorState.ClearConfirm);
          } else {
            onClose();
          }
          return;
        }
      }

      if (state === SpecModeConfiguratorState.ClearConfirm) {
        if (key.escape || input === 'q') {
          // Cancel - go back to asking
          setState(SpecModeConfiguratorState.Asking);
          return;
        }
        if (key.return) {
          void (async () => {
            await onClearSpecModel();
            onClose();
          })();
        }
      }
    },
    {
      isActive:
        state === SpecModeConfiguratorState.Asking ||
        state === SpecModeConfiguratorState.ClearConfirm ||
        state === SpecModeConfiguratorState.Error,
    }
  );

  const handleModelSelect = async (model: UserModelSelection) => {
    const { supportedReasoningEfforts } = getTuiModelConfig(model);

    // Check if we should show reasoning selector
    // Only show if:
    // 1. The spec model supports multiple reasoning efforts
    // 2. Either the main model is also Anthropic, or main model doesn't have reasoning enabled
    const shouldShowReasoningSelector =
      supportedReasoningEfforts.length > 1 &&
      (isAnthropicModelById(currentMainModel) ||
        !hasReasoningEnabled(currentMainReasoningEffort));

    if (shouldShowReasoningSelector) {
      // For non-Anthropic main models, we should only allow 'off' reasoning
      // to maintain compatibility
      if (
        !isAnthropicModelById(currentMainModel) &&
        isAnthropicModelById(model)
      ) {
        // Set to 'off' directly without showing selector
        try {
          await onSetSpecModel(model, ReasoningEffort.Off);
          onClose();
        } catch (error) {
          setErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
          setState(SpecModeConfiguratorState.Error);
        }
      } else {
        setPendingModel(model);
        setState(SpecModeConfiguratorState.SelectingReasoning);
      }
    } else {
      // No reasoning effort selection needed
      try {
        await onSetSpecModel(model);
        onClose();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setState(SpecModeConfiguratorState.Error);
      }
    }
  };

  const handleReasoningSelect = async (effort: ReasoningEffort) => {
    if (pendingModel) {
      try {
        await onSetSpecModel(pendingModel, effort);
        onClose();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setState(SpecModeConfiguratorState.Error);
      }
    } else {
      // Handle unexpected case where pendingModel is null
      onClose(); // Close dialog as fallback
    }
  };

  if (state === SpecModeConfiguratorState.SelectingModel) {
    return (
      <ModelSelector
        currentModel={currentSpecModel || currentMainModel}
        currentReasoningEffort={currentSpecReasoningEffort}
        mainReasoningEffort={currentMainReasoningEffort}
        specModeModel={currentSpecModel}
        specModeReasoningEffort={currentSpecReasoningEffort}
        onSelect={handleModelSelect}
        onCancel={() => setState(SpecModeConfiguratorState.Asking)}
      />
    );
  }

  if (state === SpecModeConfiguratorState.SelectingReasoning && pendingModel) {
    const modelConfig = getTuiModelConfig(pendingModel);

    // Filter supported efforts based on main model compatibility
    let availableEfforts = modelConfig.supportedReasoningEfforts;
    if (
      !isAnthropicModelById(currentMainModel) &&
      isAnthropicModelById(pendingModel)
    ) {
      // For non-Anthropic main models, only allow 'off' for Anthropic spec models
      availableEfforts = availableEfforts.filter(
        (effort) =>
          effort === ReasoningEffort.Off || effort === ReasoningEffort.None
      );
    }

    return (
      <ReasoningEffortSelector
        currentEffort={currentSpecReasoningEffort}
        supportedEfforts={availableEfforts}
        onSelect={handleReasoningSelect}
        onCancel={() => setState(SpecModeConfiguratorState.SelectingModel)}
      />
    );
  }

  if (state === SpecModeConfiguratorState.ClearConfirm) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={COLORS.border}
      >
        <Box paddingX={1} paddingY={1}>
          <Text>{t('common:specModelConfigurator.clearConfirm')}</Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>{t('common:specModelConfigurator.clearHint')}</Text>
        </Box>
      </Box>
    );
  }

  if (state === SpecModeConfiguratorState.Error && errorMessage) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={COLORS.error}
        paddingX={1}
        paddingY={1}
      >
        <Box paddingBottom={1}>
          <Text bold color={COLORS.error}>
            ⚠{' '}
            {errorMessage?.toLowerCase().includes('compatibility')
              ? t('common:specModelConfigurator.errorCompatibility')
              : t('common:specModelConfigurator.errorConfiguration')}
          </Text>
        </Box>
        <Box>
          <Text wrap="wrap">{errorMessage}</Text>
        </Box>
        <Box paddingTop={1}>
          <Text dimColor>
            {t('common:specModelConfigurator.errorDismissHint')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Default: asking state
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.border}>
      <Box paddingX={1} paddingTop={1}>
        <Text bold>{t('common:specModelConfigurator.title')}</Text>
      </Box>

      <Box paddingX={1} paddingTop={1}>
        <Text dimColor>{t('common:specModelConfigurator.description')}</Text>
      </Box>

      {currentSpecModel && (
        <Box paddingX={1} paddingTop={1}>
          <Text dimColor>
            {t('common:specModelConfigurator.currentModel')}{' '}
            <Text color={COLORS.primary}>{specModelConfig?.displayName}</Text>
          </Text>
        </Box>
      )}

      <Box paddingX={1} paddingTop={1}>
        <Text>{t('common:specModelConfigurator.selectPrompt')}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1}>
        <Box>
          <Text
            color={
              selectedOption === 'yes' ? COLORS.text.primary : COLORS.text.muted
            }
            bold={selectedOption === 'yes'}
          >
            {t('common:specModelConfigurator.optionYes')}
          </Text>
        </Box>
        <Box>
          <Text
            color={
              selectedOption === 'no' ? COLORS.text.primary : COLORS.text.muted
            }
            bold={selectedOption === 'no'}
          >
            {currentSpecModel
              ? t('common:specModelConfigurator.optionNoKeepCurrent')
              : t('common:specModelConfigurator.optionNoKeepMain')}
          </Text>
        </Box>
        {currentSpecModel && (
          <Box>
            <Text
              color={
                selectedOption === 'clear'
                  ? COLORS.text.primary
                  : COLORS.text.muted
              }
              bold={selectedOption === 'clear'}
            >
              {t('common:specModelConfigurator.optionClear')}
            </Text>
          </Box>
        )}
      </Box>

      <Box paddingX={1}>
        <Text dimColor>{t('common:specModelConfigurator.navigationHint')}</Text>
      </Box>
    </Box>
  );
});
