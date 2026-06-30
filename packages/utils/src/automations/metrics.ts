import {
  AUTOMATION_RUN_FAILURE_REASONS,
  AUTOMATION_RUN_TRIGGER_SOURCES,
} from './constants';

import type {
  AutomationRunFailureReason,
  AutomationRunTriggerSource,
  BuildAutomationRunLabelsInput,
} from './types';

const AUTOMATION_RUN_TRIGGER_SOURCE_VALUES: ReadonlySet<string> = new Set(
  AUTOMATION_RUN_TRIGGER_SOURCES
);

const AUTOMATION_RUN_FAILURE_REASON_VALUES: ReadonlySet<string> = new Set(
  AUTOMATION_RUN_FAILURE_REASONS
);

export function isAutomationRunTriggerSource(
  value: string
): value is AutomationRunTriggerSource {
  return AUTOMATION_RUN_TRIGGER_SOURCE_VALUES.has(value);
}

export function isAutomationRunFailureReason(
  value: string
): value is AutomationRunFailureReason {
  return AUTOMATION_RUN_FAILURE_REASON_VALUES.has(value);
}

export function buildAutomationRunLabels(input: BuildAutomationRunLabelsInput) {
  const machineConnectionType =
    input.executionLocation === 'remote' ? 'computer' : 'tui';
  return {
    executionLocation: input.executionLocation,
    machineConnectionType,
    ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
  };
}

// Structural shape covering both MetaError (carries `metadata.failureReason` /
// `metadata.statusCode`) and ResponseError (carries `statusCode` directly).
// Typed structurally so this util does not depend on @industry/logging.
interface AutomationFailureLike {
  readonly statusCode?: number | string;
  readonly metadata?: {
    readonly failureReason?: string;
    readonly statusCode?: number | string;
  };
}

export function getAutomationRunFailureReason(
  error: unknown
): AutomationRunFailureReason {
  const candidate = (error as AutomationFailureLike | undefined)?.metadata
    ?.failureReason;
  if (
    typeof candidate === 'string' &&
    isAutomationRunFailureReason(candidate)
  ) {
    return candidate;
  }
  return 'workflow_failed';
}

// statusCode is only ever extracted from `ResponseError` instances (the
// HTTP error hierarchy in @industry/logging/errors), so the value space is
// bounded to the ~10 HTTP status codes thrown by Sandbox.connect / daemon
// connect / session creation. Do NOT widen this to accept arbitrary
// platform-specific error codes (HRESULT, libc errno, sandbox provider
// internal codes, …) — that would explode the metric cardinality.
function getStatusCode(error: unknown): number | string | undefined {
  const e = error as AutomationFailureLike | undefined;
  return e?.statusCode ?? e?.metadata?.statusCode;
}

export function buildAutomationRunFailureLabels(
  input: BuildAutomationRunLabelsInput & { error?: unknown }
) {
  const { error, ...labelsInput } = input;
  const statusCode = getStatusCode(error);
  return {
    ...buildAutomationRunLabels(labelsInput),
    reason: getAutomationRunFailureReason(error),
    ...(statusCode !== undefined ? { statusCode: String(statusCode) } : {}),
  };
}
