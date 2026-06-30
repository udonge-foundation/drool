import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type ExecuteToolConfirmationDetails,
  type ToolConfirmationListItem,
  type ToolConfirmationInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  AutonomyLevel,
  AutonomyMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { getFlag } from '@industry/runtime/feature-flags';
import {
  autonomyLevelToModeForAutoApproval,
  autonomyModeToLevelForAutoApproval,
  isAutonomyLevelAllowed,
  isNewSessionOutcome,
} from '@industry/utils';

import { getRequiredAutonomyLevel } from '@/agent/autonomy';
import { shouldConfirmExecution } from '@/agent/shouldConfirmExecution';
import { getThemedColors } from '@/components/chat/themedColors';
import { getSessionController } from '@/controllers/SessionController';
import { getI18n } from '@/i18n';
import { sessionConfigService } from '@/services/SessionConfigService';
import { getSettingsService } from '@/services/SettingsService';
import { formatAutonomyLevelName } from '@/utils/format';

export function getSystemExitSpecModeMessage(): string {
  return `<system-reminder>\nThe user has approved your implementation plan. Spec mode has been exited and all tools are now enabled. You may proceed with the implementation using any necessary tools including file modifications, executions, and other system-modifying operations.\n</system-reminder>`;
}

export function getSystemExitSpecModeEditMessage(
  specSaveSucceeded = true
): string {
  if (!specSaveSucceeded) {
    return `<system-reminder>\nThe user has manually edited and approved the specification, but it could not be saved. Use the edited specification content from the ExitSpecMode result before proceeding.\n</system-reminder>`;
  }

  return `<system-reminder>\nThe user has manually edited and approved the specification. Make sure to read the updated version before proceeding.\n</system-reminder>`;
}

type ConfirmationOption = ToolConfirmationListItem & {
  selectedColor: string;
  selectedPrefix?: string;
};

/**
 * Push autonomy-tiered options into an options array, respecting maxAutonomyLevel.
 */
function pushAutonomyTierOptions(
  options: ConfirmationOption[],
  tiers: {
    level: AutonomyLevel;
    label: string;
    value: ToolConfirmationOutcome;
    dangerColor?: boolean;
  }[],
  maxAutonomyLevel: AutonomyLevel | undefined,
  colors: { highlight: string; highlightDanger: string }
): void {
  for (const tier of tiers) {
    if (isAutonomyLevelAllowed(tier.level, maxAutonomyLevel)) {
      options.push({
        label: tier.label,
        value: tier.value,
        selectedColor: tier.dangerColor
          ? colors.highlightDanger
          : colors.highlight,
      });
    }
  }
}

function getManagedMaxAutonomyLevel(): AutonomyLevel | undefined {
  const settingsService = getSettingsService() as {
    getMaxAutonomyLevel?: () => AutonomyLevel | undefined;
  };
  if (typeof settingsService.getMaxAutonomyLevel !== 'function') {
    return undefined;
  }

  return settingsService.getMaxAutonomyLevel();
}

/**
 * Tool confirmation info without selectable options (used as input to generate options)
 */
type ToolConfirmationInfoInput = Omit<ToolConfirmationInfo, 'options'>;

/**
 * Map a persisted/UI-string impact level into the same 1..3 numeric scale
 * used by `riskLevelToNumber` for risk levels. `none` and unknowns map to
 * 0 so they never falsely satisfy a ceiling that allows >= LOW (1+).
 */
function persistedImpactLevelToNumber(level: string): number {
  switch (level.toLowerCase()) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    default:
      return 0;
  }
}

/**
 * Map an `AutonomyLevel` to the same 1..3 numeric scale used for impact
 * level comparisons. `Off` is below any risk (so any non-zero impact is
 * forbidden), `Low/Medium/High` correspond directly, `Auto` is a UI mode
 * that never bounds persistence options so we treat it as the ceiling.
 */
function autonomyLevelToImpactNumber(level: AutonomyLevel): number {
  switch (level) {
    case AutonomyLevel.Off:
      return 0;
    case AutonomyLevel.Low:
      return 1;
    case AutonomyLevel.Medium:
      return 2;
    case AutonomyLevel.High:
      return 3;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * Generate batch confirmation options for multiple tools
 *
 * This function matches the exact logic from getBatchConfirmationOptions
 * in BatchToolConfirmationMessage.tsx to ensure 1:1 parity.
 *
 * @param params - Batch confirmation parameters
 * @param params.hasExitSpecMode - Whether any tool is ExitSpecMode
 * @param params.toolCount - Number of tools requiring confirmation
 * @param params.tools - Array of tool confirmation info
 * @param params.hasDeniedCommands - Whether any tool has denied commands
 * @returns Array of selectable list items for the confirmation prompt
 */
export function getBatchConfirmationOptions({
  hasExitSpecMode,
  toolCount,
  toolConfirmationInfoInputs: tools,
  hasDeniedCommands,
}: {
  hasExitSpecMode: boolean;
  toolCount: number;
  toolConfirmationInfoInputs: ToolConfirmationInfoInput[];
  hasDeniedCommands: boolean;
}): (ToolConfirmationListItem & {
  selectedColor: string;
  selectedPrefix?: string;
})[] {
  const maxAutonomyLevel = getManagedMaxAutonomyLevel();
  const colors = getThemedColors();

  if (hasExitSpecMode) {
    const t = getI18n().t;
    const options: ConfirmationOption[] = [
      {
        label: t('common:confirmation.proceedWithImplementation'),
        value: ToolConfirmationOutcome.ProceedOnce,
        selectedColor: colors.highlight,
      },
    ];

    pushAutonomyTierOptions(
      options,
      [
        {
          level: AutonomyLevel.Low,
          label: t('common:confirmation.proceedAllowLow'),
          value: ToolConfirmationOutcome.ProceedAutoRunLow,
        },
        {
          level: AutonomyLevel.Medium,
          label: t('common:confirmation.proceedAllowMedium'),
          value: ToolConfirmationOutcome.ProceedAutoRunMedium,
        },
        {
          level: AutonomyLevel.High,
          label: t('common:confirmation.proceedAllowHigh'),
          value: ToolConfirmationOutcome.ProceedAutoRunHigh,
          dangerColor: true,
        },
      ],
      maxAutonomyLevel,
      colors
    );

    const isNewSessionHandoffEnabled = getFlag(
      IndustryFeatureFlags.SpecNewSessionHandoff
    );
    if (isNewSessionHandoffEnabled) {
      options.push({
        label: t('common:confirmation.proceedInNewSession'),
        value: ToolConfirmationOutcome.ProceedNewSession,
        selectedColor: colors.highlight,
      });
      pushAutonomyTierOptions(
        options,
        [
          {
            level: AutonomyLevel.Low,
            label: t('common:confirmation.proceedInNewSessionLow'),
            value: ToolConfirmationOutcome.ProceedNewSessionLow,
          },
          {
            level: AutonomyLevel.Medium,
            label: t('common:confirmation.proceedInNewSessionMedium'),
            value: ToolConfirmationOutcome.ProceedNewSessionMedium,
          },
          {
            level: AutonomyLevel.High,
            label: t('common:confirmation.proceedInNewSessionHigh'),
            value: ToolConfirmationOutcome.ProceedNewSessionHigh,
            dangerColor: true,
          },
        ],
        maxAutonomyLevel,
        colors
      );
    }

    options.push({
      label: t('common:confirmation.noKeepIterating'),
      value: ToolConfirmationOutcome.Cancel,
      selectedColor: colors.highlightDanger,
      selectedPrefix: '✕ ',
    });

    return options;
  }

  // Determine required autonomy level and build the label
  const requiredAutonomyMode = getRequiredAutonomyLevel(
    tools.map((t) => ({ ...t, options: [] }))
  );
  const requiredAutonomyLevel =
    autonomyModeToLevelForAutoApproval(requiredAutonomyMode);
  const isAboveManagedMax = !isAutonomyLevelAllowed(
    requiredAutonomyLevel,
    maxAutonomyLevel
  );
  const effectiveAutonomyMode =
    maxAutonomyLevel && maxAutonomyLevel !== AutonomyLevel.Off
      ? autonomyLevelToModeForAutoApproval(maxAutonomyLevel)
      : requiredAutonomyMode;
  const t = getI18n().t;
  const autonomyLevelName = formatAutonomyLevelName(
    isAboveManagedMax ? effectiveAutonomyMode : requiredAutonomyMode
  );
  const rememberLabel = t('common:confirmation.yesAndAlwaysAllow', {
    level: autonomyLevelName,
  });

  if (hasDeniedCommands) {
    // For denied commands, only show basic yes/no options
    if (toolCount === 1) {
      return [
        {
          label: t('common:confirmation.yesAllow'),
          value: ToolConfirmationOutcome.ProceedOnce,
          selectedColor: colors.highlight,
        },
        {
          label: t('common:confirmation.noCancel'),
          value: ToolConfirmationOutcome.Cancel,
          selectedColor: colors.highlightDanger,
          selectedPrefix: '✕ ',
        },
      ];
    }

    return [
      {
        label: t('common:confirmation.yesAllowAll'),
        value: ToolConfirmationOutcome.ProceedOnce,
        selectedColor: colors.highlight,
      },
      {
        label: t('common:confirmation.noCancelAll'),
        value: ToolConfirmationOutcome.Cancel,
        selectedColor: colors.highlightDanger,
        selectedPrefix: '✕ ',
      },
    ];
  }

  // Check if all tools are MCP tools
  const mcpTools = tools.filter(
    (tool) => tool.confirmationType === ToolConfirmationType.McpTool
  );
  const allMcpTools = mcpTools.length === toolCount && mcpTools.length > 0;

  if (allMcpTools) {
    // MCP-specific options with "Allow always" for tools/servers.
    // We've already filtered to McpTool confirmations above; cast through to
    // read serverName since `Omit<...>` flattens the union discriminator.
    const uniqueServers = new Set(
      mcpTools
        .map((tool) => (tool.details as { serverName?: string }).serverName)
        .filter((name): name is string => name !== undefined)
    );
    const singleServer = uniqueServers.size === 1;

    // Honor the org-managed autonomy ceiling: persistent allow-always
    // options auto-approve future calls at the persisted impact level,
    // which would silently bypass `maxAutonomyLevel` enforcement once
    // saved. Compute the highest impact in this batch and hide the
    // persistence options when the ceiling forbids that level.
    const batchMaxImpactNumber = mcpTools.reduce((max, tool) => {
      const lvl = (tool.details as { impactLevel?: string }).impactLevel;
      const num = lvl ? persistedImpactLevelToNumber(lvl) : 0;
      return Math.max(max, num);
    }, 0);
    const managedMaxNumber =
      maxAutonomyLevel !== undefined
        ? autonomyLevelToImpactNumber(maxAutonomyLevel)
        : Number.POSITIVE_INFINITY;
    const persistenceAllowedByCeiling =
      batchMaxImpactNumber <= managedMaxNumber;

    const options: ConfirmationOption[] = [
      {
        label:
          toolCount === 1
            ? t('common:confirmation.yesAllow')
            : t('common:confirmation.yesAllowAll'),
        value: ToolConfirmationOutcome.ProceedOnce,
        selectedColor: colors.highlight,
      },
    ];

    if (persistenceAllowedByCeiling) {
      options.push({
        label:
          toolCount === 1
            ? 'Always allow this tool'
            : `Always allow these ${toolCount} tools`,
        value: ToolConfirmationOutcome.ProceedAlwaysTools,
        selectedColor: colors.highlight,
      });

      if (singleServer) {
        const serverName = Array.from(uniqueServers)[0];
        options.push({
          label: `Always allow all "${serverName}" tools`,
          value: ToolConfirmationOutcome.ProceedAlwaysServer,
          selectedColor: colors.highlight,
        });
      }
    }

    options.push({
      label:
        toolCount === 1
          ? t('common:confirmation.noCancel')
          : t('common:confirmation.noCancelAll'),
      value: ToolConfirmationOutcome.Cancel,
      selectedColor: colors.highlightDanger,
      selectedPrefix: '✕ ',
    });

    return options;
  }

  // Adjust labels based on whether there's a single tool or multiple
  if (toolCount === 1) {
    const options: (ToolConfirmationListItem & {
      selectedColor: string;
      selectedPrefix?: string;
    })[] = [
      {
        label: t('common:confirmation.yesAllow'),
        value: ToolConfirmationOutcome.ProceedOnce,
        selectedColor: colors.highlight,
      },
    ];

    if (maxAutonomyLevel !== AutonomyLevel.Off && !isAboveManagedMax) {
      options.push({
        label: rememberLabel,
        value: ToolConfirmationOutcome.ProceedAlways,
        selectedColor: colors.highlight,
      });
    }

    options.push({
      label: t('common:confirmation.noCancel'),
      value: ToolConfirmationOutcome.Cancel,
      selectedColor: colors.highlightDanger,
      selectedPrefix: '✕ ',
    });

    return options;
  }

  const options: (ToolConfirmationListItem & {
    selectedColor: string;
    selectedPrefix?: string;
  })[] = [
    {
      label: t('common:confirmation.yesAllowAll'),
      value: ToolConfirmationOutcome.ProceedOnce,
      selectedColor: colors.highlight,
    },
  ];

  if (maxAutonomyLevel !== AutonomyLevel.Off && !isAboveManagedMax) {
    options.push({
      label: rememberLabel,
      value: ToolConfirmationOutcome.ProceedAlways,
      selectedColor: colors.highlight,
    });
  }

  options.push({
    label: t('common:confirmation.noCancelAll'),
    value: ToolConfirmationOutcome.Cancel,
    selectedColor: colors.highlightDanger,
    selectedPrefix: '✕ ',
  });

  return options;
}

/**
 * Check which tools need confirmation for batch execution
 */
export async function getToolConfirmationInfo(
  toolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>
): Promise<{
  toolUses: ToolConfirmationInfo[];
  options: ToolConfirmationListItem[];
}> {
  // First pass: collect all tools that need confirmation
  const confirmationInfos: ToolConfirmationInfo[] = [];

  for (const toolUse of toolUses) {
    const confirmationDetails = await shouldConfirmExecution(
      toolUse.name,
      toolUse.input
    );

    if (confirmationDetails) {
      confirmationInfos.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        toolInput: toolUse.input,
        confirmationType: confirmationDetails.type,
        details: confirmationDetails,
      });
    }
  }

  // Check if any tools have ExitSpecMode
  const hasExitSpecMode = confirmationInfos.some(
    (info) => info.confirmationType === ToolConfirmationType.ExitSpecMode
  );

  // Check if any tools have denied commands
  const hasDeniedCommands = confirmationInfos.some((info) => {
    if (info.confirmationType === ToolConfirmationType.Execute) {
      const details = info.details as ExecuteToolConfirmationDetails;
      return sessionConfigService.isCommandDenied(details.fullCommand);
    }
    return false;
  });

  // Generate options once for the entire batch (not per tool)
  const options = getBatchConfirmationOptions({
    hasExitSpecMode,
    toolCount: confirmationInfos.length,
    toolConfirmationInfoInputs: confirmationInfos,
    hasDeniedCommands,
  });

  return {
    toolUses: confirmationInfos,
    options,
  };
}

interface ProcessConfirmationOutcomeParams {
  outcome: ToolConfirmationOutcome;
  tools: ToolConfirmationInfo[];
  approvedToolIds?: string[];
}

/**
 * Process confirmation outcome and apply autonomy mode changes.
 * Pure business logic extracted from handleConfirmation for reuse.
 *
 * @param outcome - The confirmation outcome
 * @param tools - Array of tools being confirmed
 * @param approvedToolIds - Optional array of specific tool IDs approved (for ProceedOnce)
 * @returns Array of approved tool IDs
 */
export function processConfirmationOutcome({
  outcome,
  tools,
  approvedToolIds,
}: ProcessConfirmationOutcomeParams): string[] {
  if (outcome === ToolConfirmationOutcome.Cancel) {
    return [];
  }

  if (
    outcome === ToolConfirmationOutcome.ProceedAlways ||
    outcome === ToolConfirmationOutcome.ProceedAlwaysForExactPath
  ) {
    // Skip autonomy upgrade for sandbox violation prompts — "Allow always"
    // on a sandbox prompt adds the path/domain to the settings allow list
    // instead of upgrading the autonomy mode.
    const isSandboxOnly = tools.every(
      (t) => t.confirmationType === ToolConfirmationType.SandboxViolation
    );
    if (!isSandboxOnly) {
      // Determine the required autonomy level based on tools
      const requiredAutonomyMode = getRequiredAutonomyLevel(tools);
      getSessionController().setAutonomyLevel(
        autonomyModeToLevelForAutoApproval(requiredAutonomyMode)
      );
    }

    return tools.map((tool) => tool.toolUseId);
  }

  if (
    outcome === ToolConfirmationOutcome.ProceedAlwaysTools ||
    outcome === ToolConfirmationOutcome.ProceedAlwaysServer
  ) {
    // MCP persistent permissions - approve all tools
    // Actual persistence will be handled by ToolExecutor after execution
    return tools.map((tool) => tool.toolUseId);
  }

  if (outcome === ToolConfirmationOutcome.ProceedEdit) {
    // Handle edit action for ExitSpecMode
    tools.forEach((toolInfo) => {
      if (toolInfo.confirmationType === ToolConfirmationType.ExitSpecMode) {
        // Exit spec mode when user chooses to edit - default to normal mode
        getSessionController().setAutonomyMode(AutonomyMode.Normal);
      }
    });
    return tools.map((tool) => tool.toolUseId);
  }

  // For ProceedNewSession variants, approve all tools so ExitSpecMode runs and saves the spec.
  // The ToolExecutor will set shouldStopAfterTools so the AgentLoop breaks
  // and the caller (sharedAgentRunner / app.tsx) handles the session transition.
  if (isNewSessionOutcome(outcome)) {
    tools.forEach((toolInfo) => {
      if (toolInfo.confirmationType === ToolConfirmationType.ExitSpecMode) {
        getSessionController().setAutonomyMode(AutonomyMode.Normal);
      }
    });
    return tools.map((tool) => tool.toolUseId);
  }

  if (
    [
      ToolConfirmationOutcome.ProceedAutoRunLow,
      ToolConfirmationOutcome.ProceedAutoRunMedium,
      ToolConfirmationOutcome.ProceedAutoRunHigh,
    ].includes(outcome)
  ) {
    let newMode: AutonomyMode = AutonomyMode.AutoLow;
    if (outcome === ToolConfirmationOutcome.ProceedAutoRunLow) {
      newMode = AutonomyMode.AutoLow;
    } else if (outcome === ToolConfirmationOutcome.ProceedAutoRunMedium) {
      newMode = AutonomyMode.AutoMedium;
    } else {
      newMode = AutonomyMode.AutoHigh;
    }

    tools.forEach((toolInfo) => {
      if (toolInfo.confirmationType === ToolConfirmationType.ExitSpecMode) {
        // Exit spec mode with specified mode
        getSessionController().setAutonomyMode(newMode);
      }
    });
    return tools.map((tool) => tool.toolUseId);
  }

  // ProceedOnce - proceed with selected tools (or all if no selection provided)
  const approvedIds = approvedToolIds || tools.map((tool) => tool.toolUseId);
  tools.forEach((toolInfo) => {
    if (
      approvedIds.includes(toolInfo.toolUseId) &&
      toolInfo.confirmationType === ToolConfirmationType.ExitSpecMode
    ) {
      // Exit spec mode when plan is approved - default to normal mode
      getSessionController().setAutonomyMode(AutonomyMode.Normal);
    }
  });
  return approvedIds;
}
