import { ToolConfirmationOutcome } from '@industry/drool-sdk-ext/protocol/drool';

import type { PermissionOption } from '@agentclientprotocol/sdk';

// ACP permission option kind type (extracted from PermissionOption)
type PermissionOptionKind = PermissionOption['kind'];

/**
 * Map ToolConfirmationOutcome to ACP PermissionOptionKind
 *
 * ACP only supports: allow_once, allow_always, reject_once, reject_always
 * We map our outcomes to the closest semantic match, defaulting to allow_once
 */
export function mapOutcomeToKind(
  outcome: ToolConfirmationOutcome
): PermissionOptionKind {
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedOnce:
    case ToolConfirmationOutcome.ProceedEdit:
      return 'allow_once';
    case ToolConfirmationOutcome.ProceedAutoRunLow:
    case ToolConfirmationOutcome.ProceedAutoRunMedium:
    case ToolConfirmationOutcome.ProceedAutoRunHigh:
    case ToolConfirmationOutcome.ProceedAutoRun:
    case ToolConfirmationOutcome.ProceedAlways:
    case ToolConfirmationOutcome.ProceedAlwaysTools:
    case ToolConfirmationOutcome.ProceedAlwaysServer:
      return 'allow_always';
    case ToolConfirmationOutcome.Cancel:
      return 'reject_once';
    default:
      return 'allow_once';
  }
}
