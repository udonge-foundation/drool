/**
 * Shared autonomy and auto-approval logic used by both TUI and streaming exec runner
 */

import {
  ToolConfirmationType,
  type ToolConfirmationInfo,
  type ExecuteToolConfirmationDetails,
  type McpToolConfirmationDetails,
} from '@industry/drool-sdk-ext/protocol/drool';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';
import { RiskLevel } from '@industry/drool-sdk-ext/protocol/tools';

/**
 * Determine the required autonomy level for a batch of tools.
 * Used to determine what TuiMode is needed to auto-approve all tools in a batch.
 *
 * @param tools - Array of tool confirmation info
 * @returns The minimum TuiMode required to auto-approve all tools
 */
export function getRequiredAutonomyLevel(
  tools: ToolConfirmationInfo[]
): AutonomyMode {
  let maxRequiredLevel = AutonomyMode.AutoLow;

  for (const tool of tools) {
    if (
      tool.confirmationType === ToolConfirmationType.Execute ||
      tool.confirmationType === ToolConfirmationType.McpTool
    ) {
      const executeDetails = tool.details as
        | ExecuteToolConfirmationDetails
        | McpToolConfirmationDetails;
      const impactLevel = executeDetails.impactLevel;

      // Treat undefined/missing impactLevel as high for safety
      if (impactLevel === RiskLevel.HIGH || !impactLevel) {
        return AutonomyMode.AutoHigh; // High impact needs AutoHigh, return immediately
      }
      if (impactLevel === RiskLevel.MEDIUM) {
        maxRequiredLevel = AutonomyMode.AutoMedium; // Medium impact needs at least AutoMedium
      }
      // Only explicitly 'low' impact stays at AutoLow (no change needed)
    } else {
      // File operations (Create, Edit, ApplyPatch) are considered low impact
      // They stay at AutoLow level (no change needed)
    }
  }

  return maxRequiredLevel;
}
