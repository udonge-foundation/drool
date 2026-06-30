import { Box, Text } from 'ink';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { SessionPrivacyLevel } from '@industry/common/session';
import { logException } from '@industry/logging';
import { isFetchError } from '@industry/logging/errors';

import {
  enableSlackListeningChannel,
  updateSlackChannelSettings,
} from '@/api/slackChannels';
import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { ApplyingStep } from '@/components/SetupIncidentResponseFlow/ApplyingStep';
import { ChannelStep } from '@/components/SetupIncidentResponseFlow/ChannelStep';
import { ComputerStep } from '@/components/SetupIncidentResponseFlow/ComputerStep';
import { ConfirmStep } from '@/components/SetupIncidentResponseFlow/ConfirmStep';
import { WizardStep } from '@/components/SetupIncidentResponseFlow/enums';
import { PromptStep } from '@/components/SetupIncidentResponseFlow/PromptStep';
import { ResultStep } from '@/components/SetupIncidentResponseFlow/ResultStep';
import type { WizardSelections } from '@/components/SetupIncidentResponseFlow/types';
import { Spinner } from '@/components/Spinner';
import { useEscapeHandler } from '@/hooks/useEscapeHandler';
import type { IncidentResponseSetupData } from '@/services/slack/types';
import { loadIncidentResponseSetupData } from '@/services/slack/wizardData';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

interface SetupIncidentResponseFlowProps {
  onClose: () => void;
  /** Test seam: skip the loader and seed the data directly. */
  preloadedData?: IncidentResponseSetupData;
}

interface FlowState {
  step: WizardStep;
  data: IncidentResponseSetupData | null;
  selections: WizardSelections;
  loadError: string | null;
  applyError: string | null;
  /** True when channel-enable succeeded but settings PATCH failed. */
  partialEnable: boolean;
}

type FlowAction =
  | { type: 'data_loaded'; data: IncidentResponseSetupData }
  | { type: 'load_failed'; error: string }
  | { type: 'set_channel'; channel: WizardSelections['channel'] }
  | { type: 'set_computer'; computer: WizardSelections['computer'] }
  | { type: 'set_prompt'; prompt: string }
  | { type: 'apply_started' }
  | { type: 'apply_succeeded' }
  | { type: 'apply_failed'; error: string; partialEnable: boolean };

function initialSelections(): WizardSelections {
  return {
    channel: null,
    computer: null,
    prompt: '',
  };
}

function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'data_loaded':
      return {
        ...state,
        data: action.data,
        step: WizardStep.Channel,
        selections: {
          channel: null,
          computer: null,
          prompt: action.data.defaultPrompt,
        },
      };
    case 'load_failed':
      return { ...state, step: WizardStep.LoadFailed, loadError: action.error };
    case 'set_channel':
      return {
        ...state,
        step: WizardStep.Computer,
        selections: { ...state.selections, channel: action.channel },
      };
    case 'set_computer':
      return {
        ...state,
        step: WizardStep.Prompt,
        selections: { ...state.selections, computer: action.computer },
      };
    case 'set_prompt':
      return {
        ...state,
        step: WizardStep.Confirm,
        selections: { ...state.selections, prompt: action.prompt },
      };
    case 'apply_started':
      return { ...state, step: WizardStep.Applying };
    case 'apply_succeeded':
      return { ...state, step: WizardStep.Success };
    case 'apply_failed':
      return {
        ...state,
        step: WizardStep.Failed,
        applyError: action.error,
        partialEnable: action.partialEnable,
      };
    default:
      return state;
  }
}

/**
 * The server-supplied portion of `FetchError.message` comes from
 * `response.text()` and is therefore untrusted -- pass it through
 * `sanitizeTerminalDisplayText({ stripSgr: true })` before rendering into Ink
 * so a crafted body cannot inject SGR/CSI/OSC sequences into the terminal.
 */
function describeFetchError(
  error: unknown,
  t: (key: string) => string
): string {
  if (isFetchError(error)) {
    if (error.response.status === 403) {
      return t('slashMessages.setupIncidentResponse.permissionDenied');
    }
    return sanitizeTerminalDisplayText(error.message, { stripSgr: true });
  }
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalDisplayText(raw, { stripSgr: true });
}

export function SetupIncidentResponseFlow({
  onClose,
  preloadedData,
}: SetupIncidentResponseFlowProps) {
  const { t } = useTranslation('commands');
  const [state, dispatch] = useReducer(flowReducer, {
    step: preloadedData ? WizardStep.Channel : WizardStep.Loading,
    data: preloadedData ?? null,
    selections: preloadedData
      ? {
          channel: null,
          computer: null,
          prompt: preloadedData.defaultPrompt,
        }
      : initialSelections(),
    loadError: null,
    applyError: null,
    partialEnable: false,
  });

  const isAlive = useRef(true);
  useEffect(
    () => () => {
      isAlive.current = false;
    },
    []
  );

  // Initial data load (skipped when preloadedData is provided for tests).
  useEffect(() => {
    if (preloadedData) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadIncidentResponseSetupData();
        if (cancelled || !isAlive.current) return;
        dispatch({ type: 'data_loaded', data });
      } catch (error) {
        logException(error, 'Failed to load incident-response setup data');
        if (cancelled || !isAlive.current) return;
        dispatch({ type: 'load_failed', error: describeFetchError(error, t) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preloadedData, t]);

  // Esc cancels at any non-applying step.
  useEscapeHandler(onClose, {
    isActive:
      state.step !== WizardStep.Applying && state.step !== WizardStep.Success,
  });

  const applySettings = useCallback(async () => {
    const { data, selections } = state;
    if (!data || !selections.channel || !selections.computer) {
      dispatch({
        type: 'apply_failed',
        error: t(
          'slashMessages.setupIncidentResponse.resultStep.failureFallback'
        ),
        partialEnable: false,
      });
      return;
    }
    dispatch({ type: 'apply_started' });
    let enableSucceeded = false;
    try {
      await enableSlackListeningChannel(selections.channel.id);
      enableSucceeded = true;
      await updateSlackChannelSettings(selections.channel.id, {
        autoRun: true,
        enabled: true,
        defaultComputerId: selections.computer.id,
        defaultWorkspaceId: null,
        sessionOwnerId: data.viewer.userId,
        customPrompt: selections.prompt,
        sessionPrivacy: SessionPrivacyLevel.Private,
      });
      if (!isAlive.current) return;
      dispatch({ type: 'apply_succeeded' });
    } catch (error) {
      logException(error, 'Failed to apply incident-response setup');
      if (!isAlive.current) return;
      dispatch({
        type: 'apply_failed',
        error: describeFetchError(error, t),
        partialEnable: enableSucceeded,
      });
    }
  }, [state, t]);

  // --- Render ---

  if (state.step === WizardStep.Loading) {
    return (
      <MenuContainer
        title={t('slashMessages.setupIncidentResponse.loading.title')}
        showDefaultHelp={false}
      >
        <Box>
          <Spinner />
          <Text color={COLORS.text.muted}>
            {' '}
            {t('slashMessages.setupIncidentResponse.loading.message')}
          </Text>
        </Box>
      </MenuContainer>
    );
  }

  if (state.step === WizardStep.LoadFailed) {
    return (
      <ResultStep
        variant="failure"
        channelName=""
        errorMessage={
          state.loadError ??
          t('slashMessages.setupIncidentResponse.loading.failed')
        }
        onDismiss={onClose}
      />
    );
  }

  if (!state.data) return null;

  const listeningChannelIds = new Set(
    state.data.listeningChannels.map((c) => c.id)
  );

  switch (state.step) {
    case WizardStep.Channel:
      return (
        <ChannelStep
          channels={state.data.channels}
          listeningChannelIds={listeningChannelIds}
          onSelect={(channel) => dispatch({ type: 'set_channel', channel })}
        />
      );
    case WizardStep.Computer:
      return (
        <ComputerStep
          computers={state.data.computers}
          onSelect={(computer) => dispatch({ type: 'set_computer', computer })}
        />
      );
    case WizardStep.Prompt:
      return (
        <PromptStep
          defaultPrompt={state.data.defaultPrompt}
          initialValue={state.selections.prompt}
          onSubmit={(prompt) => dispatch({ type: 'set_prompt', prompt })}
        />
      );
    case WizardStep.Confirm:
      return (
        <ConfirmStep selections={state.selections} onConfirm={applySettings} />
      );
    case WizardStep.Applying:
      return (
        <ApplyingStep channelName={state.selections.channel?.name ?? ''} />
      );
    case WizardStep.Success:
      return (
        <ResultStep
          variant="success"
          channelName={state.selections.channel?.name ?? ''}
          onDismiss={onClose}
        />
      );
    case WizardStep.Failed:
      return (
        <ResultStep
          variant="failure"
          channelName={state.selections.channel?.name ?? ''}
          errorMessage={state.applyError ?? undefined}
          partialEnable={state.partialEnable}
          onDismiss={onClose}
        />
      );
    default:
      return null;
  }
}
