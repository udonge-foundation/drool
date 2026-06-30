import { DroolWorkingState } from './enums';

const seconds = (value: number) => value * 1_000;
const minutes = (value: number) => seconds(value * 60);
const hours = (value: number) => minutes(value * 60);

export const LOOP_INTERVAL_POLICY = {
  minMs: minutes(1),
  maxMs: hours(24),
  displayRange: '1m–24h',
  examples: '5m, 30m, 2h',
} as const;

/**
 * System reminder tag constants used for marking content as hidden from users
 */
export const SYSTEM_REMINDER_START = '<system-reminder>';
export const SYSTEM_REMINDER_END = '</system-reminder>';

/**
 * System notification tag constants used for marking notifications as hidden from users
 */
export const SYSTEM_NOTIFICATION_START = '<system-notification>';
export const SYSTEM_NOTIFICATION_END = '</system-notification>';

export const EXIT_SPEC_MODE_REJECTED_MESSAGE =
  'Plan not approved - remaining in Spec Mode. Provide feedback to refine the spec.';

const DROOL_RUNNING_STATES = [
  DroolWorkingState.Thinking,
  DroolWorkingState.StreamingAssistantMessage,
  DroolWorkingState.ExecutingTool,
  DroolWorkingState.CompactingConversation,
];
export const DROOL_IN_PROGRESS_STATES = [
  ...DROOL_RUNNING_STATES,
  DroolWorkingState.WaitingForToolConfirmation,
];
