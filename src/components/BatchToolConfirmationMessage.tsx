import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  SandboxViolationReason,
  SandboxViolationType,
  type ApplyPatchToolConfirmationDetails,
  type AskUserConfirmationDetails,
  type CreateToolConfirmationDetails,
  type EditToolConfirmationDetails,
  type ExecuteToolConfirmationDetails,
  type ExitSpecModeConfirmationDetails,
  type McpToolConfirmationDetails,
  type ProposeMissionConfirmationDetails,
  type SandboxViolationConfirmationDetails,
  type ToolConfirmationInfo,
} from '@industry/drool-sdk-ext/protocol/drool';
import { AutonomyLevel } from '@industry/drool-sdk-ext/protocol/shared';
import { logException } from '@industry/logging';

import { getBatchConfirmationOptions } from '@/agent/tool-confirmation';
import type { ApprovedSpecNewSessionPayload } from '@/agent/types';
import { AskUserConfirmation } from '@/components/AskUserConfirmation';
import { MAX_DIFF_LINES } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { DiffRenderer } from '@/components/DiffRenderer';
import { MissionProposalConfirmation } from '@/components/MissionProposalConfirmation';
import { SandboxViolationPrompt } from '@/components/SandboxViolationPrompt';
import { SpecModeConfirmation } from '@/components/SpecModeConfirmation';
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { getI18n } from '@/i18n';
import { getSandboxPromptOptions } from '@/sandbox/SandboxPermissionPrompt';
import { resolveAskUserAnswers } from '@/services/AskUserAnswerStore';
import { JetBrainsIdeClient } from '@/services/JetBrainsIdeClient';
import { sessionConfigService } from '@/services/SessionConfigService';
import { VSCodeIdeClient } from '@/services/VSCodeIdeClient';
import { MissionProposalAction, SpecModeAction } from '@/types/enums';
import type { BatchToolConfirmationDetails } from '@/types/types';
import {
  getDiffSummary,
  generateUnifiedDiff,
  smartTruncateDiff,
} from '@/utils/diff-utils';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';
import { truncateMiddle } from '@/utils/truncate';

interface BatchToolConfirmationMessageProps {
  confirmationDetails: BatchToolConfirmationDetails;
  ctrlCPressed?: boolean;
  isFocused?: boolean;
  width?: number;
  ideClient?: VSCodeIdeClient | JetBrainsIdeClient;
  lastTokenUsage?: number | null;
  onSpecNewSessionHandoff?: (payload: ApprovedSpecNewSessionPayload) => void;
  onEditorGuidance?: (message: string | null) => void;
  onReasoningCycle?: () => void;
  defaultAutonomyLevel?: AutonomyLevel;
  pendingPermissionCount: number;
  pendingPermissionTotal?: number;
}

function getExecuteRiskLabel(
  impactLevel: string | undefined,
  t: ReturnType<typeof getI18n>['t']
): string | undefined {
  if (impactLevel === 'low') {
    return t('common:batchConfirmation.commandRiskLow');
  }
  if (impactLevel === 'medium') {
    return t('common:batchConfirmation.commandRiskMedium');
  }
  if (impactLevel === 'high') {
    return t('common:batchConfirmation.commandRiskHigh');
  }
  return undefined;
}

function getExecuteRiskRank(impactLevel: string | undefined): number {
  if (impactLevel === 'high') return 3;
  if (impactLevel === 'medium') return 2;
  if (impactLevel === 'low') return 1;
  return 0;
}

function getMcpImpactLabel(
  impactLevel: string | undefined,
  t: ReturnType<typeof getI18n>['t']
): string | undefined {
  if (impactLevel === 'low') {
    return t('common:batchConfirmation.mcpImpactLow');
  }
  if (impactLevel === 'medium') {
    return t('common:batchConfirmation.mcpImpactMedium');
  }
  if (impactLevel === 'high') {
    return t('common:batchConfirmation.mcpImpactHigh');
  }
  return undefined;
}

function getSanitizedCommandPreview(command: string, width: number): string {
  const sanitized = sanitizeTerminalDisplayText(command, {
    stripSgr: true,
  }).trim();
  const singleLine = sanitized.replace(/\r\n|\r|\n/g, ' ⏎ ');
  return truncateMiddle(singleLine, Math.max(20, width));
}

function cleanupTemporaryDiffFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    logException(error, 'Failed to clean up temporary VS Code diff file');
  }
}

function getVSCodeCommand(): string {
  return process.platform === 'win32' ? 'code.cmd' : 'code';
}

// Helper function to show diff in VS Code
function showDiffInVSCode(
  oldContent: string,
  newContent: string,
  fileName: string,
  originalFilePath?: string
): { success: boolean; cleanup?: () => void } {
  try {
    // If we have the original file path and it exists, use it as the base
    if (originalFilePath && fs.existsSync(originalFilePath)) {
      // Create only one temp file for the new content in system temp dir
      const tmpDir = os.tmpdir();
      const timestamp = Date.now();
      const baseName = path.basename(originalFilePath);
      const newFile = path.join(
        tmpDir,
        `industry-cli-${timestamp}-proposed-${baseName}`
      );

      // Write new content to temporary file
      fs.writeFileSync(newFile, newContent);

      // Open diff comparing original file to proposed changes
      spawn(getVSCodeCommand(), ['--diff', originalFilePath, newFile], {
        stdio: 'inherit',
        shell: false,
        detached: false,
      });

      // Return cleanup function
      const cleanup = () => {
        cleanupTemporaryDiffFile(newFile);
      };

      // Also set a timeout as fallback
      setTimeout(cleanup, 60000); // Clean up after 60 seconds as fallback

      return { success: true, cleanup };
    }

    // Fallback: create both temp files in system temp dir
    const tmpDir = os.tmpdir();
    const timestamp = Date.now();
    const baseName = path.basename(fileName);
    const oldFile = path.join(
      tmpDir,
      `industry-cli-${timestamp}-old-${baseName}`
    );
    const newFile = path.join(
      tmpDir,
      `industry-cli-${timestamp}-new-${baseName}`
    );

    // Write content to temporary files
    fs.writeFileSync(oldFile, oldContent);
    fs.writeFileSync(newFile, newContent);

    // Open diff in VS Code
    spawn(getVSCodeCommand(), ['--diff', oldFile, newFile], {
      stdio: 'inherit',
      shell: false,
      detached: false,
    });

    // Return cleanup function
    const cleanup = () => {
      cleanupTemporaryDiffFile(oldFile);
      cleanupTemporaryDiffFile(newFile);
    };

    // Also set a timeout as fallback
    setTimeout(cleanup, 60000); // Clean up after 60 seconds as fallback

    return { success: true, cleanup };
  } catch (error) {
    logException(error, 'Failed to open diff in VS Code');
    return { success: false };
  }
}

interface DiffPreviewBlockProps {
  oldContent: string;
  newContent: string;
  filePath?: string;
  label: string;
  vscodeOpened: boolean;
  showExpandedDiff: boolean;
  width: number;
  vsCodeSuffix: string;
  moreLinesLabel: (count: number) => string;
}

function DiffPreviewBlock({
  oldContent,
  newContent,
  filePath,
  label,
  vscodeOpened,
  showExpandedDiff,
  width,
  vsCodeSuffix,
  moreLinesLabel,
}: DiffPreviewBlockProps) {
  const diffLines = generateUnifiedDiff(oldContent, newContent, 2);
  const summary = getDiffSummary(diffLines);

  if (vscodeOpened) {
    return (
      <Text wrap="wrap">
        {label}: {summary} {vsCodeSuffix}
      </Text>
    );
  }

  let displayDiff = showExpandedDiff
    ? diffLines
    : smartTruncateDiff(diffLines, 2, 4);
  let hiddenLines = 0;

  if (!showExpandedDiff && displayDiff.length > MAX_DIFF_LINES) {
    hiddenLines = displayDiff.length - MAX_DIFF_LINES;
    displayDiff = displayDiff.slice(0, MAX_DIFF_LINES);
  }

  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        {label}: {summary}
      </Text>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={0}
        marginTop={1}
      >
        <DiffRenderer
          diffLines={displayDiff}
          showLineNumbers
          maxWidth={width - 2}
          filePath={filePath}
        />
      </Box>
      {hiddenLines > 0 && (
        <Text color={COLORS.text.muted}>{moreLinesLabel(hiddenLines)}</Text>
      )}
    </Box>
  );
}

// Helper function to get display text for a tool
function getToolDisplayText(toolInfo: ToolConfirmationInfo): string {
  const { toolName, confirmationType, details } = toolInfo;

  const t = getI18n().t;

  switch (confirmationType) {
    case ToolConfirmationType.Edit: {
      const editDetails = details as EditToolConfirmationDetails;
      return t('common:batchConfirmation.editFile', {
        fileName: editDetails.fileName,
      });
    }
    case ToolConfirmationType.Create: {
      const createDetails = details as CreateToolConfirmationDetails;
      return t('common:batchConfirmation.createFile', {
        fileName: createDetails.fileName,
      });
    }
    case ToolConfirmationType.ExitSpecMode: {
      return t('common:batchConfirmation.exitSpecMode');
    }
    case ToolConfirmationType.ProposeMission: {
      return t('common:batchConfirmation.reviewMission');
    }

    case ToolConfirmationType.Execute: {
      const executeDetails = details as ExecuteToolConfirmationDetails;
      const isDenied = sessionConfigService.isCommandDenied(
        executeDetails.fullCommand
      );
      const isAllowed = sessionConfigService.isCommandAllowed(
        executeDetails.fullCommand
      );
      const prefix = isDenied
        ? t('common:batchConfirmation.runDenylisted')
        : isAllowed
          ? t('common:batchConfirmation.runAllowlisted')
          : t('common:batchConfirmation.run');
      return `${prefix} ${executeDetails.fullCommand}`;
    }
    case ToolConfirmationType.ApplyPatch: {
      const patchDetails = details as ApplyPatchToolConfirmationDetails;
      return t('common:batchConfirmation.applyPatch', {
        fileName: patchDetails.fileName,
      });
    }
    case ToolConfirmationType.SandboxViolation: {
      const sandboxDetails = details as SandboxViolationConfirmationDetails;
      return `${t('common:sandbox.label')}: ${sandboxDetails.operationType} → ${sandboxDetails.target}`;
    }
    default:
      return t('common:batchConfirmation.defaultOperation', { toolName });
  }
}

export function BatchToolConfirmationMessage({
  confirmationDetails,
  ctrlCPressed,
  isFocused = true,
  width = 60,
  ideClient,
  lastTokenUsage,
  onSpecNewSessionHandoff,
  onEditorGuidance,
  onReasoningCycle,
  defaultAutonomyLevel,
  pendingPermissionCount,
  pendingPermissionTotal,
}: BatchToolConfirmationMessageProps) {
  const { t } = useTranslation();
  const { tools, onConfirm, subagentSessionTitle } = confirmationDetails;
  const permissionQueueTotal = Math.max(
    pendingPermissionTotal ?? pendingPermissionCount,
    pendingPermissionCount
  );
  const permissionQueuePosition = Math.min(
    permissionQueueTotal,
    Math.max(1, permissionQueueTotal - pendingPermissionCount + 1)
  );
  const hasPermissionQueue = permissionQueueTotal > 1;
  const [openedDiffPaths, setOpenedDiffPaths] = useState<string[]>([]);
  const [showExpandedDiff, setShowExpandedDiff] = useState(false);
  const keypressProvider = useKeypressProvider();

  // Check if there are any tools with diffs that can be expanded
  const hasDiffTools = tools.some(
    (tool) =>
      tool.confirmationType === ToolConfirmationType.Edit ||
      tool.confirmationType === ToolConfirmationType.Create ||
      tool.confirmationType === ToolConfirmationType.ApplyPatch
  );

  const hasDeniedCommands = tools.some((tool) => {
    if (tool.confirmationType === ToolConfirmationType.Execute) {
      const details = tool.details as ExecuteToolConfirmationDetails;
      return sessionConfigService.isCommandDenied(details.fullCommand);
    }
    return false;
  });

  // Handle VS Code diff opening for edit, create, and apply patch tools
  const [vscodeOpened] = useState(() => {
    const editToolsVsc = tools.filter(
      (tool) => tool.confirmationType === ToolConfirmationType.Edit
    );
    const createToolsVsc = tools.filter(
      (tool) => tool.confirmationType === ToolConfirmationType.Create
    );
    const applyPatchToolsVsc = tools.filter(
      (tool) => tool.confirmationType === ToolConfirmationType.ApplyPatch
    );

    if (
      editToolsVsc.length === 0 &&
      createToolsVsc.length === 0 &&
      applyPatchToolsVsc.length === 0
    )
      return false;

    // Use MCP client if available and connected
    if (ideClient?.isConnected()) {
      // Handle edit tools
      editToolsVsc.forEach((tool) => {
        const editDetails = tool.details as EditToolConfirmationDetails;
        if (
          editDetails.oldContent !== undefined &&
          editDetails.newContent !== undefined &&
          editDetails.filePath
        ) {
          ideClient
            .openDiff(editDetails.filePath, editDetails.newContent)
            .then(() => {
              setOpenedDiffPaths((prev) => [...prev, editDetails.filePath!]);
            })
            .catch((error) => {
              logException(error, 'Failed to open diff via MCP');
            });
        }
      });

      // Handle create tools - open diff from empty to new content
      createToolsVsc.forEach((tool) => {
        const createDetails = tool.details as CreateToolConfirmationDetails;
        if (createDetails.content && createDetails.filePath) {
          ideClient
            .openDiff(createDetails.filePath, createDetails.content)
            .then(() => {
              setOpenedDiffPaths((prev) => [...prev, createDetails.filePath!]);
            })
            .catch((error) => {
              logException(error, 'Failed to open diff via MCP for create');
            });
        }
      });

      // Handle apply patch tools
      applyPatchToolsVsc.forEach((tool) => {
        const patchDetails = tool.details as ApplyPatchToolConfirmationDetails;
        if (
          patchDetails.oldContent !== undefined &&
          patchDetails.newContent !== undefined &&
          patchDetails.filePath
        ) {
          ideClient
            .openDiff(patchDetails.filePath, patchDetails.newContent)
            .then(() => {
              setOpenedDiffPaths((prev) => [...prev, patchDetails.filePath!]);
            })
            .catch((error) => {
              logException(
                error,
                'Failed to open diff via MCP for apply patch'
              );
            });
        }
      });

      return true;
    }

    // Fallback to old method if MCP not available
    if (process.env.INDUSTRY_VSCODE_MCP_PORT && !ideClient?.isConnected()) {
      // Handle edit tools
      editToolsVsc.forEach((tool) => {
        const editDetails = tool.details as EditToolConfirmationDetails;
        if (
          editDetails.oldContent !== undefined &&
          editDetails.newContent !== undefined
        ) {
          const { success } = showDiffInVSCode(
            editDetails.oldContent,
            editDetails.newContent,
            editDetails.fileName,
            editDetails.filePath
          );
          if (success && editDetails.filePath) {
            setOpenedDiffPaths((prev) => [...prev, editDetails.filePath!]);
          }
        }
      });

      // Handle create tools - show diff from empty to new content
      createToolsVsc.forEach((tool) => {
        const createDetails = tool.details as CreateToolConfirmationDetails;
        if (createDetails.content) {
          const { success } = showDiffInVSCode(
            '', // empty content for new file
            createDetails.content,
            createDetails.fileName,
            createDetails.filePath
          );
          if (success && createDetails.filePath) {
            setOpenedDiffPaths((prev) => [...prev, createDetails.filePath!]);
          }
        }
      });

      // Handle apply patch tools - show diff from old to new content
      applyPatchToolsVsc.forEach((tool) => {
        const patchDetails = tool.details as ApplyPatchToolConfirmationDetails;
        if (
          patchDetails.oldContent !== undefined &&
          patchDetails.newContent !== undefined
        ) {
          const { success } = showDiffInVSCode(
            patchDetails.oldContent,
            patchDetails.newContent,
            patchDetails.fileName,
            patchDetails.filePath
          );
          if (success && patchDetails.filePath) {
            setOpenedDiffPaths((prev) => [...prev, patchDetails.filePath!]);
          }
        }
      });

      return true;
    }

    return false;
  });

  // Check confirmation types for routing to specialized components
  const hasExitSpecMode = tools.some(
    (tool) => tool.confirmationType === ToolConfirmationType.ExitSpecMode
  );

  const hasProposeMission = tools.some(
    (tool) => tool.confirmationType === ToolConfirmationType.ProposeMission
  );

  const hasAskUser = tools.some(
    (tool) => tool.confirmationType === ToolConfirmationType.AskUser
  );

  const hasSandboxViolation = tools.some(
    (tool) => tool.confirmationType === ToolConfirmationType.SandboxViolation
  );

  // Whether this component delegates to a specialized sub-component (early return).
  // The useMenuNavigation hook must be called consistently regardless of early
  // returns to avoid React "fewer hooks" errors. We disable it when delegating.
  const isDelegated =
    (hasAskUser && tools.length === 1) ||
    (hasProposeMission && tools.length === 1) ||
    (hasExitSpecMode && tools.length === 1) ||
    (hasSandboxViolation && tools.length === 1);

  // Options and handler are computed here (before early returns) so the
  // useMenuNavigation hook is always called in the same order.
  const options = getBatchConfirmationOptions({
    hasExitSpecMode,
    toolCount: tools.length,
    toolConfirmationInfoInputs: tools,
    hasDeniedCommands,
  });

  const handleConfirm = async (outcome: ToolConfirmationOutcome) => {
    if (openedDiffPaths.length > 0 && ideClient?.isConnected()) {
      openedDiffPaths.forEach((filePath) => {
        ideClient.closeDiff(filePath).catch((error) => {
          logException(error, 'Failed to close diff via MCP');
        });
      });
    }

    if (outcome === ToolConfirmationOutcome.Cancel) {
      await onConfirm(outcome, []);
    } else {
      const allToolIds = tools.map((tool) => tool.toolUseId);
      await onConfirm(outcome, allToolIds);
    }
  };

  const toggleExpandedDiff = () => setShowExpandedDiff((prev) => !prev);
  const diffToggleKeys: Record<string, () => void> = hasDiffTools
    ? { '\x0f': toggleExpandedDiff, '[111;5u': toggleExpandedDiff }
    : {};

  const { selectedIndex } = useMenuNavigation({
    items: options,
    onSelect: (item) => {
      void handleConfirm(item.value as ToolConfirmationOutcome);
    },
    onCancel: () => {
      void handleConfirm(ToolConfirmationOutcome.Cancel);
    },
    additionalKeys: diffToggleKeys,
    isActive: !isDelegated && isFocused && keypressProvider.isEnabled,
    enableCharKeys: false,
  });

  if (hasAskUser && tools.length === 1) {
    const askTool = tools[0];
    if (askTool.confirmationType !== ToolConfirmationType.AskUser) {
      return null;
    }
    const askDetails = askTool.details as AskUserConfirmationDetails;

    const handleComplete = async (
      answers: Array<{ index: number; question: string; answer: string }>
    ) => {
      resolveAskUserAnswers(askTool.toolUseId, answers);
      await onConfirm(ToolConfirmationOutcome.ProceedOnce, [askTool.toolUseId]);
    };

    const handleCancel = async () => {
      await onConfirm(ToolConfirmationOutcome.Cancel, []);
    };

    return (
      <AskUserConfirmation
        questions={askDetails.parsed?.questions || []}
        parseError={
          askDetails.parseError ||
          (!askDetails.parsed?.questions?.length
            ? { message: 'No questions found' }
            : undefined)
        }
        onComplete={handleComplete}
        onCancel={handleCancel}
        isFocused={isFocused}
        width={width}
      />
    );
  }

  if (hasProposeMission && tools.length === 1) {
    const missionTool = tools[0];
    if (missionTool.confirmationType !== ToolConfirmationType.ProposeMission) {
      return null;
    }
    const missionDetails =
      missionTool.details as ProposeMissionConfirmationDetails;

    const handleMissionConfirm = async (
      action: MissionProposalAction,
      comment?: string
    ) => {
      let outcome: ToolConfirmationOutcome;

      switch (action) {
        case MissionProposalAction.Approve:
        case MissionProposalAction.ApproveWithComment:
          outcome = ToolConfirmationOutcome.ProceedOnce;
          break;
        case MissionProposalAction.Reject:
          outcome = ToolConfirmationOutcome.Cancel;
          break;
        default:
          outcome = ToolConfirmationOutcome.ProceedOnce;
      }

      await onConfirm(outcome, [missionTool.toolUseId], comment);
    };

    const handleMissionCancel = async () => {
      await onConfirm(ToolConfirmationOutcome.Cancel, []);
    };

    return (
      <MissionProposalConfirmation
        title={missionDetails.title}
        proposal={missionDetails.proposal}
        onConfirm={handleMissionConfirm}
        onCancel={handleMissionCancel}
        isFocused={isFocused}
        width={width}
      />
    );
  }

  // Handle ExitSpecMode with custom component
  if (hasExitSpecMode && tools.length === 1) {
    const specTool = tools[0];
    if (specTool.confirmationType !== ToolConfirmationType.ExitSpecMode) {
      // Should never happen, but handle gracefully
      return null;
    }
    const specDetails = specTool.details as ExitSpecModeConfirmationDetails;

    const handleSpecConfirm = async (
      action: SpecModeAction,
      comment?: string,
      autonomyLevel?: AutonomyLevel,
      editedSpecContent?: string
    ) => {
      // New-session handoff bypasses the normal ToolExecutor/AgentLoop path.
      // We don't call onConfirm() — instead stopAgentWithTimeout() in app.tsx
      // cancels the agent, which cleans up the pending confirmation promise
      // via ToolExecutor.dispose(). The spec is saved in app.tsx's handler.
      if (action === SpecModeAction.ApproveNewSession) {
        onSpecNewSessionHandoff?.({
          plan: specDetails.plan,
          title: specDetails.title,
          filePath: '',
          userComment: comment,
          autonomyLevel,
        });
        return;
      }

      // Map spec actions to tool confirmation outcomes
      let outcome: ToolConfirmationOutcome;

      switch (action) {
        case SpecModeAction.Approve:
          outcome = ToolConfirmationOutcome.ProceedOnce;
          break;
        case SpecModeAction.ApproveLow:
          outcome = ToolConfirmationOutcome.ProceedAutoRunLow;
          break;
        case SpecModeAction.ApproveMedium:
          outcome = ToolConfirmationOutcome.ProceedAutoRunMedium;
          break;
        case SpecModeAction.ApproveHigh:
          outcome = ToolConfirmationOutcome.ProceedAutoRunHigh;
          break;
        case SpecModeAction.Edit:
          outcome = ToolConfirmationOutcome.ProceedEdit;
          break;
        case SpecModeAction.Reject:
          outcome = ToolConfirmationOutcome.Cancel;
          break;
        default:
          outcome = ToolConfirmationOutcome.ProceedOnce;
      }

      await onConfirm(
        outcome,
        [specTool.toolUseId],
        comment,
        editedSpecContent
      );
    };

    const handleSpecCancel = async () => {
      await onConfirm(ToolConfirmationOutcome.Cancel, []);
    };

    return (
      <SpecModeConfirmation
        key={specTool.toolUseId}
        title={specDetails.title}
        plan={specDetails.plan}
        onConfirm={handleSpecConfirm}
        onCancel={handleSpecCancel}
        onEditorGuidance={onEditorGuidance}
        onReasoningCycle={onReasoningCycle}
        defaultAutonomyLevel={defaultAutonomyLevel}
        isFocused={isFocused}
        width={width}
        lastTokenUsage={lastTokenUsage}
        ctrlCPressed={ctrlCPressed}
      />
    );
  }

  // Handle SandboxViolation with custom prompt
  if (hasSandboxViolation && tools.length === 1) {
    const sandboxTool = tools[0];
    if (
      sandboxTool.confirmationType !== ToolConfirmationType.SandboxViolation
    ) {
      return null;
    }
    const sandboxDetails =
      sandboxTool.details as SandboxViolationConfirmationDetails;

    // Map confirmation details back to a SandboxViolation to compute dynamic options
    const violationTypeMap: Record<string, SandboxViolationType> = {
      'filesystem-write': SandboxViolationType.FilesystemWrite,
      'filesystem-read': SandboxViolationType.FilesystemRead,
      network: SandboxViolationType.Network,
    };
    const sandboxViolation = {
      type: violationTypeMap[sandboxDetails.violationType],
      path:
        sandboxDetails.violationType !== 'network'
          ? sandboxDetails.target
          : undefined,
      domain:
        sandboxDetails.violationType === 'network'
          ? sandboxDetails.target
          : undefined,
      operation: sandboxDetails.operationType,
      message: sandboxDetails.reason,
      timestamp: Date.now(),
      reason:
        sandboxDetails.violationReason ?? SandboxViolationReason.NotAllowed,
    };
    const sandboxOptions = getSandboxPromptOptions(sandboxViolation);

    return (
      <SandboxViolationPrompt
        details={sandboxDetails}
        options={sandboxOptions}
        toolUseId={sandboxTool.toolUseId}
        onConfirm={onConfirm}
        isFocused={isFocused}
        width={width}
      />
    );
  }

  // Group tools by type for better display
  const editTools = tools.filter(
    (tool) => tool.confirmationType === ToolConfirmationType.Edit
  );
  const createTools = tools.filter(
    (tool) => tool.confirmationType === ToolConfirmationType.Create
  );
  const applyPatchTools = tools.filter(
    (tool) => tool.confirmationType === ToolConfirmationType.ApplyPatch
  );
  const executeTools = tools.filter(
    (tool) => tool.confirmationType === ToolConfirmationType.Execute
  );
  const sandboxViolationTools = tools.filter(
    (tool) => tool.confirmationType === ToolConfirmationType.SandboxViolation
  );
  const mcpTools = tools.filter(
    (tool) => tool.confirmationType === ToolConfirmationType.McpTool
  );
  const maxExecuteRiskTool = executeTools.reduce<
    ExecuteToolConfirmationDetails | undefined
  >((max, tool) => {
    const details = tool.details as ExecuteToolConfirmationDetails;
    if (!max) return details;
    return getExecuteRiskRank(details.impactLevel) >
      getExecuteRiskRank(max.impactLevel)
      ? details
      : max;
  }, undefined);
  const maxExecuteRiskLabel = getExecuteRiskLabel(
    maxExecuteRiskTool?.impactLevel,
    t
  );
  const baseHelpText = showExpandedDiff
    ? t('common:batchConfirmation.helpExpanded')
    : hasDiffTools && !vscodeOpened
      ? t('common:batchConfirmation.helpWithDiff')
      : t('common:batchConfirmation.helpDefault');
  const approvalHelpText = `${baseHelpText} · ${t(
    'common:batchConfirmation.approvalDetailsHint'
  )}`;

  // const exitSpecModeTools = tools.filter(
  //   (tool) => tool.confirmationType === ToolConfirmationType.ExitSpecMode
  // );

  return (
    <Box flexDirection="column" width={width}>
      {/* Shows queue position and relayed subagent labels when present. */}
      {(hasPermissionQueue || subagentSessionTitle) && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          {hasPermissionQueue && (
            <Text color={COLORS.text.muted} wrap="wrap">
              {t('common:batchConfirmation.permissionQueuePosition', {
                current: permissionQueuePosition,
                total: permissionQueueTotal,
                defaultValue: 'Approval {{current}} of {{total}}',
              })}
            </Text>
          )}
          {subagentSessionTitle && (
            <Text color={COLORS.primary} bold wrap="wrap">
              {sanitizeTerminalDisplayText(subagentSessionTitle, {
                stripSgr: true,
              }).trim()}
            </Text>
          )}
        </Box>
      )}
      {/* Tool list - only add margin if there's content to show */}
      <Box
        flexDirection="column"
        marginBottom={
          editTools.length > 0 ||
          createTools.length > 0 ||
          applyPatchTools.length > 0
            ? 1
            : 0
        }
      >
        {executeTools.length > 0 && (
          <Box flexDirection="column">
            {/* Only show category header for multiple items */}
            {executeTools.length > 1 && (
              <Box marginLeft={2}>
                <Text color={COLORS.primary}>
                  {maxExecuteRiskLabel
                    ? t('common:batchConfirmation.commandsHeaderWithRisk', {
                        count: executeTools.length,
                        risk: maxExecuteRiskLabel,
                      })
                    : t('common:batchConfirmation.commandsHeader', {
                        count: executeTools.length,
                      })}
                </Text>
              </Box>
            )}
            {executeTools.map((tool, index) => {
              const executeDetails =
                tool.details as ExecuteToolConfirmationDetails;
              const isDenied = sessionConfigService.isCommandDenied(
                executeDetails.fullCommand
              );
              const isAllowed = sessionConfigService.isCommandAllowed(
                executeDetails.fullCommand
              );
              const baseTitle = isDenied
                ? t('common:batchConfirmation.commandToApproveDenylisted')
                : isAllowed
                  ? t('common:batchConfirmation.commandToApproveAllowlisted')
                  : t('common:batchConfirmation.commandToApprove');
              const riskLabel = getExecuteRiskLabel(
                executeDetails.impactLevel,
                t
              );
              const titleLabel = riskLabel
                ? `${baseTitle} · ${riskLabel}`
                : baseTitle;
              const riskReason =
                typeof executeDetails.riskLevelReason === 'string'
                  ? sanitizeTerminalDisplayText(
                      executeDetails.riskLevelReason,
                      {
                        stripSgr: true,
                      }
                    ).trim()
                  : '';
              return (
                <Box
                  key={tool.toolUseId}
                  flexDirection="column"
                  marginLeft={2}
                  marginTop={
                    (subagentSessionTitle || hasPermissionQueue) && index === 0
                      ? 0
                      : 1
                  }
                >
                  <Text
                    color={isDenied ? COLORS.error : COLORS.primary}
                    wrap="wrap"
                  >
                    {titleLabel}
                  </Text>
                  <Text color={COLORS.text.muted} wrap="wrap">
                    ↳{' '}
                    {getSanitizedCommandPreview(
                      executeDetails.fullCommand,
                      width - 4
                    )}
                  </Text>
                  {riskReason.length > 0 && (
                    <Text color={COLORS.text.muted} wrap="wrap">
                      {t('common:batchConfirmation.commandRiskReasonHeader')}{' '}
                      {riskReason}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
        {editTools.length > 0 && (
          <Box flexDirection="column">
            {/* Only show category header for multiple items */}
            {editTools.length > 1 && (
              <Text color={COLORS.primary}>
                {t('common:batchConfirmation.fileEditsHeader', {
                  count: editTools.length,
                })}
              </Text>
            )}
            {editTools.map((tool) => {
              const editDetails = tool.details as EditToolConfirmationDetails;

              return (
                <Box key={tool.toolUseId} flexDirection="column">
                  {typeof editDetails.oldContent !== 'string' ||
                  typeof editDetails.newContent !== 'string' ? (
                    <Text wrap="wrap" color={COLORS.text.muted}>
                      {getToolDisplayText(tool)} (
                      {t('common:batchConfirmation.previewUnavailable')})
                    </Text>
                  ) : (
                    <Box flexDirection="column">
                      <DiffPreviewBlock
                        oldContent={editDetails.oldContent}
                        newContent={editDetails.newContent}
                        filePath={editDetails.filePath}
                        label={getToolDisplayText(tool)}
                        vscodeOpened={vscodeOpened}
                        showExpandedDiff={showExpandedDiff}
                        width={width}
                        vsCodeSuffix={t(
                          'common:batchConfirmation.vsCodeSuffix'
                        )}
                        moreLinesLabel={(count) =>
                          t('common:batchConfirmation.moreLines', { count })
                        }
                      />
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        )}

        {createTools.length > 0 && (
          <Box flexDirection="column">
            {/* Only show category header for multiple items */}
            {createTools.length > 1 && (
              <Text color={COLORS.primary}>
                {t('common:batchConfirmation.fileCreationsHeader', {
                  count: createTools.length,
                })}
              </Text>
            )}
            {createTools.map((tool) => {
              const createDetails =
                tool.details as CreateToolConfirmationDetails;

              return (
                <Box key={tool.toolUseId} flexDirection="column">
                  {typeof createDetails.content === 'string' && (
                    <Box flexDirection="column">
                      <DiffPreviewBlock
                        oldContent=""
                        newContent={createDetails.content}
                        filePath={createDetails.filePath}
                        label={getToolDisplayText(tool)}
                        vscodeOpened={vscodeOpened}
                        showExpandedDiff={showExpandedDiff}
                        width={width}
                        vsCodeSuffix={t(
                          'common:batchConfirmation.vsCodeSuffix'
                        )}
                        moreLinesLabel={(count) =>
                          t('common:batchConfirmation.moreLines', { count })
                        }
                      />
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        )}

        {applyPatchTools.length > 0 && (
          <Box flexDirection="column">
            {/* Only show category header for multiple items */}
            {applyPatchTools.length > 1 && (
              <Text color={COLORS.primary}>
                {t('common:batchConfirmation.patchesHeader', {
                  count: applyPatchTools.length,
                })}
              </Text>
            )}
            {applyPatchTools.map((tool) => {
              const patchDetails =
                tool.details as ApplyPatchToolConfirmationDetails;

              return (
                <Box key={tool.toolUseId} flexDirection="column">
                  {typeof patchDetails.oldContent === 'string' &&
                    typeof patchDetails.newContent === 'string' && (
                      <Box flexDirection="column">
                        <DiffPreviewBlock
                          oldContent={patchDetails.oldContent}
                          newContent={patchDetails.newContent}
                          filePath={patchDetails.filePath}
                          label={getToolDisplayText(tool)}
                          vscodeOpened={vscodeOpened}
                          showExpandedDiff={showExpandedDiff}
                          width={width}
                          vsCodeSuffix={t(
                            'common:batchConfirmation.vsCodeSuffix'
                          )}
                          moreLinesLabel={(count) =>
                            t('common:batchConfirmation.moreLines', { count })
                          }
                        />
                      </Box>
                    )}
                  {/* If we couldn't compute the diff, just show the patch text */}
                  {(patchDetails.oldContent === undefined ||
                    patchDetails.newContent === undefined) && (
                    <Text wrap="wrap">{getToolDisplayText(tool)}</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        )}

        {sandboxViolationTools.length > 0 && (
          <Box flexDirection="column">
            {sandboxViolationTools.map((tool) => {
              const details =
                tool.details as SandboxViolationConfirmationDetails;
              return (
                <Box key={tool.toolUseId} flexDirection="column">
                  <Text wrap="wrap">
                    <Text color={COLORS.highlightDanger}>
                      {t('common:sandbox.label')}
                    </Text>{' '}
                    {details.violatingToolName}: {details.operationType} →{' '}
                    {details.target}
                  </Text>
                  <Text color={COLORS.text.muted} wrap="wrap">
                    {details.reason}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {mcpTools.length > 0 && (
          <Box flexDirection="column">
            {mcpTools.map((tool) => {
              const mcpDetails = tool.details as McpToolConfirmationDetails;
              const impactLabel = getMcpImpactLabel(mcpDetails.impactLevel, t);
              const displayToolName =
                mcpDetails.serverName && mcpDetails.actualToolName
                  ? `${mcpDetails.serverName}___${mcpDetails.actualToolName}`
                  : mcpDetails.toolName;
              const titleLabel = impactLabel
                ? `${t('common:batchConfirmation.mcpToolToApprove')} · ${impactLabel}`
                : t('common:batchConfirmation.mcpToolToApprove');
              return (
                <Box
                  key={tool.toolUseId}
                  flexDirection="column"
                  marginLeft={2}
                  marginTop={1}
                >
                  <Text color={COLORS.primary} wrap="wrap">
                    {titleLabel}
                  </Text>
                  <Text color={COLORS.text.muted} wrap="wrap">
                    ↳ {displayToolName}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Expanded diff hint */}
      {showExpandedDiff && (
        <Box marginBottom={1}>
          <Text color={COLORS.text.muted}>
            {t('common:batchConfirmation.collapseDiffHint')}
          </Text>
        </Box>
      )}

      {/* Options */}
      <MenuContainer
        title={
          hasDeniedCommands
            ? ` ${t('common:batchConfirmation.denylistTitle')}`
            : undefined
        }
        titleBold={false}
        titleColor={hasDeniedCommands ? COLORS.error : undefined}
        helpText={approvalHelpText}
        marginTop={0}
        showDefaultHelp={false}
        paddingX={0}
      >
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Text
              key={option.value}
              bold={isSelected}
              color={isSelected ? COLORS.text.primary : COLORS.text.muted}
            >
              {'  '}
              {option.label}
            </Text>
          );
        })}
      </MenuContainer>
    </Box>
  );
}
