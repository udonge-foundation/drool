import { AgentStatusState } from '@/hooks/enums';
import { TuiSpinnerPresetName } from '@/utils/tuiSpinner/enums';
import type {
  TuiSpinnerStatusBannerConfig,
  TuiSpinnerStatusBannerInput,
} from '@/utils/tuiSpinner/types';

// Single knob for the banner animation pace: every banner spinner advances at
// this cadence regardless of preset, so state transitions never change the
// perceived speed.
const STATUS_BANNER_INTERVAL_MS = 60;
const STATUS_BANNER_DEFAULT_PRESET = TuiSpinnerPresetName.DotsClockwise;

function statusBannerConfig(
  text: string,
  preset: TuiSpinnerPresetName = STATUS_BANNER_DEFAULT_PRESET
): TuiSpinnerStatusBannerConfig {
  return {
    text,
    preset,
    intervalMs: STATUS_BANNER_INTERVAL_MS,
  };
}

const STATUS_BANNER_BY_AGENT_STATE = {
  [AgentStatusState.Idle]: undefined,
  [AgentStatusState.Thinking]: statusBannerConfig(' Thinking... '),
  [AgentStatusState.Compressing]: statusBannerConfig(
    ' Compressing history... '
  ),
  [AgentStatusState.Streaming]: statusBannerConfig(' Streaming... '),
  [AgentStatusState.PendingTool]: statusBannerConfig(' Invoking tools... '),
  [AgentStatusState.ToolConfirmation]: statusBannerConfig(
    ' Waiting for tool confirmation... '
  ),
  [AgentStatusState.ExecutingTool]: statusBannerConfig(' Executing... '),
} as const satisfies Record<
  AgentStatusState,
  TuiSpinnerStatusBannerConfig | undefined
>;

export function resolveTuiSpinnerStatusBanner({
  isRewindProcessing,
  isCancelling,
  sessionStatus,
  isPendingSpecEditConfirmation,
  isInvokingTools,
  isReviewingSpecChanges,
}: TuiSpinnerStatusBannerInput): TuiSpinnerStatusBannerConfig | undefined {
  if (isRewindProcessing) {
    return statusBannerConfig(' Rewinding conversation... ');
  }

  if (isCancelling) {
    return statusBannerConfig(' Cancelling tools... ');
  }

  if (sessionStatus === AgentStatusState.Compressing) {
    return STATUS_BANNER_BY_AGENT_STATE[AgentStatusState.Compressing];
  }

  if (isPendingSpecEditConfirmation) {
    return statusBannerConfig(' Pending confirmation... ');
  }

  if (isInvokingTools) {
    return statusBannerConfig(' Invoking tools... ');
  }

  if (isReviewingSpecChanges) {
    return statusBannerConfig(' Reviewing changes... ');
  }

  return STATUS_BANNER_BY_AGENT_STATE[sessionStatus];
}
