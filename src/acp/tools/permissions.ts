import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type ToolConfirmationInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import { isNewSessionOutcome } from '@industry/utils';

import { generateToolTitle } from '@/acp/protocol/translator';
import { mapOptionsToAcp } from '@/acp/tools/permissionMappers';
import { inferToolKind } from '@/acp/tools/utils';
import { getBatchConfirmationOptions } from '@/agent/tool-confirmation';

import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';

function isToolOutcome(value: string): value is ToolConfirmationOutcome {
  return Object.values(ToolConfirmationOutcome).includes(
    value as ToolConfirmationOutcome
  );
}

/**
 * Build the ACP payload for a tool-permission request.
 *
 * `info` is the tool used as the *toolCall* descriptor in the ACP request
 * (typically the last tool in the batch, since ACP only displays one
 * tool card). `batch`, when provided, is the full set of tools requiring
 * permission — it is fed into `getBatchConfirmationOptions` so the option
 * list (e.g. "Always allow this tool" vs "Always allow all <server>
 * tools") reflects the entire batch, not just the displayed tool.
 *
 * Passing only `info` (no `batch`) preserves the original single-tool
 * behavior and is retained for callers that genuinely have only one
 * tool to confirm.
 */
export function buildPermissionRequestPayload(
  info: ToolConfirmationInfo,
  toolCount?: number,
  batch?: ToolConfirmationInfo[]
) {
  const fullBatch = batch && batch.length > 0 ? batch : [info];
  const effectiveCount = batch ? batch.length : (toolCount ?? 1);

  // Check if any tool in the batch is ExitSpecMode
  const hasExitSpecMode = fullBatch.some(
    (t) => t.confirmationType === ToolConfirmationType.ExitSpecMode
  );

  // Generate options using the same logic as CLI tool confirmation.
  // CRITICAL: pass the full batch so `allMcpTools` is computed against
  // every tool, not just the displayed one. Building from `[info]` while
  // passing the full toolCount caused MCP persistence options to be
  // suppressed for multi-tool all-MCP batches (ain3sh review feedback).
  const cliOptions = getBatchConfirmationOptions({
    hasExitSpecMode,
    toolCount: effectiveCount,
    toolConfirmationInfoInputs: fullBatch,
    hasDeniedCommands: false,
  });

  // New-session handoff is TUI-only; filter it out for ACP clients
  const filteredOptions = cliOptions.filter(
    (o) => !isNewSessionOutcome(o.value)
  );

  const acpOptions = mapOptionsToAcp(filteredOptions, effectiveCount);

  return {
    options: acpOptions,
    toolCall: {
      toolCallId: info.toolUseId,
      title: generateToolTitle(info.toolName, info.toolInput ?? {}),
      rawInput: info.toolInput,
      kind: inferToolKind(info.toolName),
    },
  };
}

export function permissionResponseToOutcome(
  response: RequestPermissionResponse
): ToolConfirmationOutcome {
  if (response.outcome.outcome === 'cancelled') {
    return ToolConfirmationOutcome.Cancel;
  }

  const optionId = response.outcome.optionId;
  const isValidOutcome = isToolOutcome(optionId);

  if (isValidOutcome) {
    // New-session handoff is TUI-only; reject it from ACP clients
    if (isNewSessionOutcome(optionId)) {
      return ToolConfirmationOutcome.Cancel;
    }
    return optionId;
  }

  return ToolConfirmationOutcome.Cancel;
}
