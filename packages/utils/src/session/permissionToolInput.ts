import { ToolConfirmationType } from '@industry/drool-sdk-ext/protocol/drool';

interface PermissionToolInputSource {
  confirmationType: string;
  details?: Record<string, unknown>;
  toolInput: Record<string, unknown>;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasDetailsType(
  details: Record<string, unknown> | undefined,
  type: ToolConfirmationType
): boolean {
  return details?.type === type;
}

function mergeStringFallbacks(
  toolInput: Record<string, unknown>,
  fallbacks: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...toolInput };

  for (const [key, value] of Object.entries(fallbacks)) {
    if (hasNonEmptyString(value) && !hasNonEmptyString(merged[key])) {
      merged[key] = value;
    }
  }

  return merged;
}

export function getPermissionToolInputForDisplay(
  tool: PermissionToolInputSource
): Record<string, unknown> {
  if (
    tool.confirmationType === ToolConfirmationType.ExitSpecMode &&
    hasDetailsType(tool.details, ToolConfirmationType.ExitSpecMode)
  ) {
    return mergeStringFallbacks(tool.toolInput, {
      plan: tool.details?.plan,
      title: tool.details?.title,
    });
  }

  if (
    tool.confirmationType === ToolConfirmationType.ProposeMission &&
    hasDetailsType(tool.details, ToolConfirmationType.ProposeMission)
  ) {
    return mergeStringFallbacks(tool.toolInput, {
      proposal: tool.details?.proposal,
      title: tool.details?.title,
    });
  }

  return { ...tool.toolInput };
}
