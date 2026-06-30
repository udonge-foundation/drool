import {
  ToolConfirmationOutcome,
  type ToolConfirmationListItem,
} from '@industry/drool-sdk-ext/protocol/drool';

import { mapOutcomeToKind } from '@/acp/tools/mapOutcomeToKind';

import type { PermissionOption } from '@agentclientprotocol/sdk';

/**
 * Get the appropriate quantifier for batch labels based on tool count
 */
function getBatchQuantifier(toolCount: number): string {
  if (toolCount === 1) return '';
  if (toolCount === 2) return ' both';
  return ' all';
}

/**
 * Convert ToolConfirmationListItem options to ACP PermissionOption format
 */
export function mapOptionsToAcp(
  options: ToolConfirmationListItem[],
  toolCount: number = 1
): PermissionOption[] {
  const quantifier = getBatchQuantifier(toolCount);

  return options.map((option) => {
    let label: string = option.label;
    // use shorter labels for options in ACP, since space is limited
    switch (option.value) {
      case ToolConfirmationOutcome.ProceedOnce:
        label = `Allow${quantifier}`;
        break;
      case ToolConfirmationOutcome.ProceedAlways:
        if (option.label.toLowerCase().includes('low impact')) {
          label = `Allow${quantifier} & auto-run low risk commands`;
          break;
        }
        if (option.label.toLowerCase().includes('medium impact')) {
          label = `Allow${quantifier} & auto-run medium risk commands`;
          break;
        }
        if (option.label.toLowerCase().includes('high impact')) {
          label = `Allow${quantifier} & auto-run high risk commands`;
          break;
        }
        label = `Allow${quantifier} always`;
        break;
      case ToolConfirmationOutcome.ProceedAutoRunLow:
        label = `Allow${quantifier} & auto-run (low risk)`;
        break;
      case ToolConfirmationOutcome.ProceedAutoRunMedium:
        label = `Allow${quantifier} & auto-run (medium risk)`;
        break;
      case ToolConfirmationOutcome.ProceedAutoRunHigh:
        label = `Allow${quantifier} & auto-run (high risk)`;
        break;
      case ToolConfirmationOutcome.ProceedAlwaysTools:
        label =
          toolCount === 1
            ? 'Always allow this tool'
            : `Always allow these ${toolCount} tools`;
        break;
      case ToolConfirmationOutcome.ProceedAlwaysServer:
        label = option.label || `Always allow${quantifier} server tools`;
        break;
      default:
        break;
    }
    return {
      optionId: option.value,
      name: label,
      kind: mapOutcomeToKind(option.value),
    };
  });
}
