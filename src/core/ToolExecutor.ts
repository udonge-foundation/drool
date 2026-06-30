import { isDeepStrictEqual } from 'node:util';
import path from 'path';

import { DroolRuntime } from '@industry/drool-core/core/enums';
import { riskLevelToNumber } from '@industry/drool-core/messages/utils';
import { parseRiskLevel } from '@industry/drool-core/tools/utils';
import {
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type ExecuteToolConfirmationDetails,
  type ToolConfirmationInfo,
  type ToolConfirmationListItem,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';
import {
  MessageContentBlockType,
  MessageVisibility,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyLevel,
  AutonomyMode,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logInfo, logWarn, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';
import {
  isNewSessionOutcome,
  newSessionOutcomeToAutonomyLevel,
} from '@industry/utils';

import {
  getSystemExitSpecModeEditMessage,
  getSystemExitSpecModeMessage,
  getToolConfirmationInfo,
  processConfirmationOutcome,
} from '@/agent/tool-confirmation';
import { executeTool } from '@/agent/tools';
import type {
  ApprovedSpecNewSessionPayload,
  ExitSpecModeResult,
} from '@/agent/types';
import {
  SPEC_MODE_FULL_ERROR_WITH_PREFIX,
  EXIT_SPEC_MODE_REJECTED,
  ERROR_PREFIX,
} from '@/constants/constants';
import type { KeypressCallbacks, ToolExecutorParams } from '@/core/types';
import {
  AgentEvent,
  agentEventBus,
  subscribeToAgentEvents,
} from '@/events/AgentEventBus';
import {
  ToolCallStatus,
  HookEventName,
  MessageRole,
  MessageType,
} from '@/hooks/enums';
import { AgentAbortError, HookStopError } from '@/hooks/errors';
import {
  segmentToolUsesByConcurrency,
  segmentToolUsesForExecution,
  buildLlmidToIdMap,
  FILE_MOD_TOOL_IDS,
} from '@/hooks/segmentToolUsesByConcurrency';
import {
  HookExecutionResult,
  ToolExecutionResult,
  ToolResultContent,
} from '@/hooks/types';
import { getI18n } from '@/i18n';
import { handleAllowAlways } from '@/sandbox/allowAlwaysPersistence';
import { SandboxPromptResult } from '@/sandbox/enums';
import {
  setSandboxDomainRequestFn,
  requestSandboxPermission,
} from '@/sandbox/SandboxPermissionPrompt';
import { checkSandboxViolationsForTool } from '@/sandbox/sandboxPreCheck';
import { backgroundTaskManager } from '@/services/BackgroundTaskManager';
import {
  isDelegatedAutoRejectSession,
  isNoApproverDelegatedSession,
} from '@/services/delegatedSession/detection';
import { buildDelegatedDenialMessage } from '@/services/delegatedSession/permissionGate';
import { getDroolRuntimeService } from '@/services/DroolRuntimeService';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getGitAiService } from '@/services/GitAiService';
import { executeHooksWithDisplay } from '@/services/hook-utils';
import { getMcpPermissionService } from '@/services/mcp/McpPermissionService';
import { getMissionApprovalReminder } from '@/services/mission/prompts';
import { processTracker } from '@/services/ProcessTracker';
import {
  getPermissionModeString,
  getSessionService,
} from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { getTerminalService } from '@/services/TerminalService';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';
import { getTUIToolRegistry } from '@/tools/registry';
import type { BatchToolConfirmationDetails } from '@/types/types';
import { isDroolGitAiCheckpointHookCommand } from '@/utils/gitAiHookCommand';
import { playCompletionSound } from '@/utils/soundPlayer';
import { getTextContent } from '@/utils/tool-result-helpers';
import { getToolCategory } from '@/utils/toolCatalog';
import { ToolCategory } from '@/utils/toolCatalog/enums';

function isStreamingUpdate(update: unknown): update is ToolStreamingUpdate {
  return (
    typeof update === 'object' &&
    update !== null &&
    'type' in update &&
    typeof (update as { type?: unknown }).type === 'string'
  );
}

type ProposeMissionResult = {
  accepted?: boolean;
  missionDir?: string;
  isEdited?: boolean;
  llmGuidance?: string;
};

function parseProposeMissionResult(
  result: ToolResultContent
): ProposeMissionResult | null {
  const text = getTextContent(result);
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as ProposeMissionResult;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
  } catch (error) {
    logWarn('[ToolExecutor] Failed to parse ProposeMission result', {
      cause: error,
    });
    return null;
  }

  return null;
}

type ToolUseItem = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolBatchExecutionResult = {
  results: ToolExecutionResult[];
  wasCancelled: boolean;
  permissionRejected: boolean;
  shouldStopAfterTools: boolean;
  specHandoffPayload?: ApprovedSpecNewSessionPayload;
};

export class ToolExecutor {
  // Dependencies
  private updateToolResult: ToolExecutorParams['updateToolResult'];

  private setToolError: ToolExecutorParams['setToolError'];

  private updateToolStatus: ToolExecutorParams['updateToolStatus'];

  private updateToolCallInput: ToolExecutorParams['updateToolCallInput'];

  private context: ToolExecutorParams['context'];

  private updateAction: ToolExecutorParams['updateAction'];

  private getToolExecutions: ToolExecutorParams['getToolExecutions'];

  private onToolStreamingUpdate: ToolExecutorParams['onToolStreamingUpdate'];

  private keypressCallbacks: KeypressCallbacks | null;

  private onPendingConfirmationChange: ToolExecutorParams['onPendingConfirmationChange'];

  // State (replaces useRef)
  private _pendingConfirmation: {
    details: BatchToolConfirmationDetails;
    resolve: (result: {
      approvedToolIds: string[];
      outcome: ToolConfirmationOutcome;
      comment?: string;
      editedSpecContent?: string;
    }) => void;
    requestId: string;
    unsubscribe?: () => void;
  } | null = null;

  private _runningTools = new Set<string>();

  private _cancelledTools = new Set<string>();

  private _batchAbortController: AbortController | null = null;

  private _immediateExit = false;

  // Set when an approver-backed subagent's forwarded permission was rejected
  // and subagents_v2 is enabled, so the turn ends with PermissionRejected.
  private _permissionRejectionEndedTurn = false;

  // One-shot suppression for auto-resumed permission prompts.
  private _suppressNextAwaitingSound = false;

  private _modifiedInputs = new Map<string, Record<string, unknown>>();

  private _exitSpecModeComment: string | undefined = undefined;

  private _exitSpecModeEditedContent: string | undefined = undefined;

  private _exitSpecModeConfirmationOutcome:
    | ToolConfirmationOutcome
    | undefined = undefined;

  private _missionProposalComment: string | undefined = undefined;

  private _permissionRequestFailureMessage: string | undefined = undefined;

  private _permissionRequestFailedToolIds = new Set<string>();

  private _deniedConfirmationInfoByToolId = new Map<
    string,
    ToolConfirmationInfo
  >();

  /**
   * Tool IDs that were cancelled by an auto-reject from a delegated
   * session (mission worker or subagent). Tracked separately from
   * regular user cancellations so we can surface a more instructive
   * tool-level error that matches the <system-reminder> injected by
   * the gate.
   */
  private _delegatedAutoDeniedToolIds = new Set<string>();

  private _sandboxDenialMessages = new Map<string, string>();

  constructor(params: ToolExecutorParams) {
    this.updateToolResult = params.updateToolResult;
    this.setToolError = params.setToolError;
    this.updateToolStatus = params.updateToolStatus;
    this.updateToolCallInput = params.updateToolCallInput;
    this.context = params.context;
    this.updateAction = params.updateAction;
    this.getToolExecutions = params.getToolExecutions;
    this.onToolStreamingUpdate = params.onToolStreamingUpdate;
    this.keypressCallbacks = params.keypressCallbacks ?? null;
    this.onPendingConfirmationChange = params.onPendingConfirmationChange;
  }

  /**
   * Update mutable dependencies. Called by the React hook on each render
   * to keep callbacks in sync without recreating the ToolExecutor.
   */
  updateParams(params: Partial<ToolExecutorParams>): void {
    // Unconditionally assign all fields so explicit `undefined` clears them
    if ('updateToolResult' in params)
      this.updateToolResult = params.updateToolResult!;
    if ('setToolError' in params) this.setToolError = params.setToolError!;
    if ('updateToolStatus' in params)
      this.updateToolStatus = params.updateToolStatus;
    if ('updateToolCallInput' in params)
      this.updateToolCallInput = params.updateToolCallInput;
    if ('context' in params) this.context = params.context;
    if ('updateAction' in params) this.updateAction = params.updateAction;
    if ('getToolExecutions' in params)
      this.getToolExecutions = params.getToolExecutions;
    if ('onToolStreamingUpdate' in params)
      this.onToolStreamingUpdate = params.onToolStreamingUpdate;
    if ('keypressCallbacks' in params)
      this.keypressCallbacks = params.keypressCallbacks ?? null;
    if ('onPendingConfirmationChange' in params)
      this.onPendingConfirmationChange = params.onPendingConfirmationChange;
  }

  /**
   * Cleanup resources (replaces useEffect cleanup).
   */
  dispose(): void {
    // Clear the SRT domain-request delegate so the stale session's
    // requestPermissionFn is not called from a detached sandbox callback.
    setSandboxDomainRequestFn(null);

    const pending = this._pendingConfirmation;
    if (pending) {
      // Resolve the in-flight confirmation promise with empty approvals
      // to unblock any awaiting executeTools call.
      const sessionId =
        this.context?.sessionId ||
        getSessionService().getCurrentSessionId() ||
        'unknown';
      agentEventBus.emit(AgentEvent.PermissionResponse, {
        requestId: pending.requestId,
        approvedToolIds: [],
        sessionId,
      });
      pending.unsubscribe?.();
      this._pendingConfirmation = null;
      this.onPendingConfirmationChange?.(null);
    }
  }

  /**
   * Get the current pending confirmation details for UI rendering.
   */
  getPendingConfirmation(): BatchToolConfirmationDetails | null {
    return this._pendingConfirmation?.details ?? null;
  }

  setSuppressNextAwaitingSound(value: boolean): void {
    this._suppressNextAwaitingSound = value;
  }

  private getCancellableToolIds(): string[] {
    const toolIds = new Set<string>();

    // Streamed tool calls are registered in conversation state as Pending
    // before confirmation/execution, so this also covers approved tools that
    // have not started running yet.
    this.getToolExecutions?.().forEach((execution, toolId) => {
      if (
        execution.status === ToolCallStatus.Pending ||
        execution.status === ToolCallStatus.Executing
      ) {
        toolIds.add(toolId);
      }
    });

    this._pendingConfirmation?.details.tools.forEach((tool) => {
      toolIds.add(tool.toolUseId);
    });

    this._runningTools.forEach((toolId) => {
      toolIds.add(toolId);
    });

    return Array.from(toolIds);
  }

  private applyPermissionResponseMetadata(
    tools: ToolConfirmationInfo[],
    outcome: ToolConfirmationOutcome,
    comment?: string,
    editedSpecContent?: string
  ): void {
    const hasExitSpecMode = tools.some(
      (tool) => tool.confirmationType === ToolConfirmationType.ExitSpecMode
    );
    if (hasExitSpecMode) {
      this._exitSpecModeConfirmationOutcome = outcome;
      this._exitSpecModeComment = comment;
      this._exitSpecModeEditedContent = editedSpecContent;
      logInfo('[ToolExecutor] applyPermissionResponseMetadata ExitSpecMode', {
        outcome,
        hasInput: !!comment,
      });
    }

    const hasProposeMission = tools.some(
      (tool) => tool.confirmationType === ToolConfirmationType.ProposeMission
    );
    if (hasProposeMission) {
      this._missionProposalComment = comment;
    }
  }

  /**
   * Persist MCP permissions when the user picks ProceedAlwaysTools or
   * ProceedAlwaysServer. Call from every confirmation flow (TUI event-bus,
   * requestPermissionFn / JSON-RPC, etc.) so all paths reach the persistence
   * service. Failures are logged and swallowed so execution keeps going.
   */
  private async persistMcpPermissionsIfApplicable(
    outcome: ToolConfirmationOutcome,
    approvedToolIds: string[],
    toolUses: ToolConfirmationInfo[]
  ): Promise<void> {
    if (
      outcome !== ToolConfirmationOutcome.ProceedAlwaysTools &&
      outcome !== ToolConfirmationOutcome.ProceedAlwaysServer
    ) {
      return;
    }

    try {
      const mcpPermissionService = getMcpPermissionService();

      const approvedMcpTools = toolUses.filter(
        (tool) =>
          approvedToolIds.includes(tool.toolUseId) &&
          tool.confirmationType === ToolConfirmationType.McpTool
      );

      if (approvedMcpTools.length === 0) {
        return;
      }

      if (outcome === ToolConfirmationOutcome.ProceedAlwaysServer) {
        const serverNames = new Set(
          approvedMcpTools
            .map((t) => (t.details as { serverName?: string }).serverName)
            .filter((name): name is string => name !== undefined)
        );

        if (serverNames.size === 1) {
          const serverName = Array.from(serverNames)[0];
          const maxImpactLevel = approvedMcpTools.reduce(
            (max, tool) => {
              const currentLevel = (tool.details as { impactLevel?: string })
                .impactLevel;
              const currentNumber = riskLevelToNumber(
                parseRiskLevel(currentLevel)
              );
              const maxNumber = riskLevelToNumber(parseRiskLevel(max));
              return currentNumber > maxNumber ? currentLevel : max;
            },
            (approvedMcpTools[0].details as { impactLevel?: string })
              .impactLevel
          );

          const { resolveCurrentMcpServerIdentity } = await import(
            '@/services/mcp/mcpServerIdentity'
          );
          const serverIdentity =
            await resolveCurrentMcpServerIdentity(serverName);

          await mcpPermissionService.persistServerPermission(
            serverName,
            parseRiskLevel(maxImpactLevel),
            serverIdentity
          );

          logInfo('[ToolExecutor] Persisted server-level MCP permission', {
            // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission persistence context consumed as a unit
            value: {
              serverName,
              impactLevel: maxImpactLevel,
              toolCount: approvedMcpTools.length,
              hasIdentity: !!serverIdentity,
            },
          });
        }
      } else {
        const { resolveCurrentMcpServerIdentity } = await import(
          '@/services/mcp/mcpServerIdentity'
        );
        const identityCache = new Map<string, string | undefined>();
        for (const tool of approvedMcpTools) {
          const { serverName, actualToolName, impactLevel } = tool.details as {
            serverName?: string;
            actualToolName?: string;
            impactLevel?: string;
          };
          if (serverName && actualToolName) {
            if (!identityCache.has(serverName)) {
              identityCache.set(
                serverName,
                await resolveCurrentMcpServerIdentity(serverName)
              );
            }
            const serverIdentity = identityCache.get(serverName);
            await mcpPermissionService.persistToolPermission(
              serverName,
              actualToolName,
              parseRiskLevel(impactLevel),
              serverIdentity
            );

            logInfo('[ToolExecutor] Persisted tool-level MCP permission', {
              // eslint-disable-next-line industry/no-nested-log-metadata -- MCP permission persistence context consumed as a unit
              value: {
                serverName,
                toolName: actualToolName,
                impactLevel,
              },
            });
          }
        }
      }
    } catch (error) {
      logWarn('[ToolExecutor] Failed to persist MCP permissions', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleConfirmation(
    outcome: ToolConfirmationOutcome,
    approvedToolIds?: string[],
    comment?: string,
    editedSpecContent?: string
  ): void {
    const pending = this._pendingConfirmation;
    if (!pending) {
      return;
    }

    const { details } = pending;

    // Only set edit-mode for the specific tool type present in this confirmation
    const hasExitSpecMode = details.tools.some(
      (t) => t.confirmationType === ToolConfirmationType.ExitSpecMode
    );

    const hasProposeMission = details.tools.some(
      (t) => t.confirmationType === ToolConfirmationType.ProposeMission
    );

    this._exitSpecModeConfirmationOutcome = hasExitSpecMode
      ? outcome
      : undefined;

    // Use comment from onConfirm directly, falling back to keypressCallbacks
    if (comment && hasExitSpecMode) {
      this._exitSpecModeComment = comment;
    } else {
      this._exitSpecModeComment =
        this.keypressCallbacks?.getExitSpecModeComment();
    }
    if (hasExitSpecMode) {
      this._exitSpecModeEditedContent = editedSpecContent;
    }

    if (comment && hasProposeMission) {
      this._missionProposalComment = comment;
    } else {
      this._missionProposalComment =
        this.keypressCallbacks?.getMissionProposalComment();
    }

    // Use shared business logic to process outcome
    const approvedIds = processConfirmationOutcome({
      outcome,
      tools: details.tools,
      approvedToolIds,
    });

    // Emit permission-response event to AgentEventBus
    // The centralized listener will resolve the promise and clean up state
    const sessionId =
      this.context?.sessionId ||
      getSessionService().getCurrentSessionId() ||
      'unknown';
    agentEventBus.emit(AgentEvent.PermissionResponse, {
      requestId: pending.requestId || `local-${Date.now()}`,
      approvedToolIds: approvedIds,
      outcome,
      comment: this._exitSpecModeComment ?? this._missionProposalComment,
      editedSpecContent: this._exitSpecModeEditedContent,
      sessionId,
    });
  }

  private async prepareToolUsesForConfirmation(
    toolUses: ToolUseItem[],
    messageId: string
  ): Promise<ToolUseItem[]> {
    const isNonInteractiveExec =
      getDroolRuntimeService().isNonInteractiveCLIMode();

    // Auto-approve ExitSpecMode in non-interactive exec mode without permission capabilities
    let isSpecMode = getSessionService().isSpecMode();
    let isReadOnlyMode = isSpecMode;
    if (
      isSpecMode &&
      isNonInteractiveExec &&
      !this.context?.requestPermissionFn
    ) {
      const hasExitSpecMode = toolUses.some(
        (tool) => tool.name === 'ExitSpecMode'
      );
      if (hasExitSpecMode) {
        const targetModeStr = process.env.INDUSTRY_EXEC_TARGET_AUTONOMY;
        let targetMode = AutonomyMode.AutoLow;
        if (targetModeStr) {
          targetMode = targetModeStr as AutonomyMode;
        }

        getSessionService().setAutonomyMode(targetMode);

        isSpecMode = false;
        isReadOnlyMode = false;
      }
    }

    let filteredToolUses = toolUses;

    if (isReadOnlyMode) {
      const llmToId = buildLlmidToIdMap();
      const allowedTools = filteredToolUses.filter((tool) => {
        const toolId = llmToId[tool.name] || tool.name;
        if (!FILE_MOD_TOOL_IDS.has(toolId)) {
          return true;
        }
        const filePath =
          typeof tool.input.file_path === 'string'
            ? tool.input.file_path
            : undefined;
        if (filePath) {
          const resolved = path.resolve(filePath);
          const parentDir = path.dirname(resolved);
          if (
            path.basename(parentDir) === 'specs' &&
            (path.basename(path.dirname(parentDir)) === '.industry' ||
              path.basename(path.dirname(parentDir)) === '.industry-dev')
          ) {
            return true;
          }
        }
        return false;
      });

      if (allowedTools.length === 0) {
        return [];
      }

      filteredToolUses = allowedTools;
    }

    const sandboxDeniedToolIds = new Set<string>();

    for (const toolUse of filteredToolUses) {
      const sandboxAllowed = await this.requestSandboxAccessForToolUse(
        toolUse,
        messageId
      );
      if (!sandboxAllowed) {
        sandboxDeniedToolIds.add(toolUse.id);
      }
    }

    if (sandboxDeniedToolIds.size === 0) {
      return filteredToolUses;
    }

    return filteredToolUses.filter(
      (toolUse) => !sandboxDeniedToolIds.has(toolUse.id)
    );
  }

  private async requestSandboxAccessForToolUse(
    toolUse: ToolUseItem,
    messageId: string
  ): Promise<boolean> {
    const isNonInteractiveExec =
      getDroolRuntimeService().isNonInteractiveCLIMode();
    const sandboxRequestFn = isNonInteractiveExec
      ? this.context?.requestPermissionFn
      : (this.context?.requestPermissionFn ??
        this.createTuiRequestPermissionFn(messageId));
    const registry = getTUIToolRegistry();
    const toolDefinition =
      registry.getToolByLlmId(toolUse.name) ?? registry.getTool(toolUse.name);
    const violations = checkSandboxViolationsForTool(
      toolUse.name,
      toolUse.input,
      toolDefinition,
      { cwd: process.cwd() }
    );
    if (violations.length === 0) return true;

    for (const violation of violations) {
      const result = await requestSandboxPermission(
        toolUse.id,
        toolUse.name,
        toolUse.input,
        violation,
        sandboxRequestFn
      );

      if (
        result === SandboxPromptResult.AllowOnce ||
        result === SandboxPromptResult.AllowAlways ||
        result === SandboxPromptResult.AllowAlwaysForExactPath
      ) {
        if (result === SandboxPromptResult.AllowAlways) {
          await handleAllowAlways(violation);
        } else if (result === SandboxPromptResult.AllowAlwaysForExactPath) {
          await handleAllowAlways(violation, true);
        }
        continue;
      }

      const target = violation.path ?? violation.domain ?? 'unknown';
      const denialMessage =
        violation.type === 'tool' || violation.promptable === false
          ? violation.message
          : violation.domain
            ? `Sandbox: network access denied to ${target}`
            : `Sandbox: ${violation.operation} denied to ${target}`;
      this._sandboxDenialMessages.set(toolUse.id, denialMessage);
      return false;
    }

    return true;
  }

  private async requestConfirmationForToolUses(
    filteredToolUses: ToolUseItem[],
    messageId: string
  ): Promise<string[]> {
    const isNonInteractiveExec =
      getDroolRuntimeService().isNonInteractiveCLIMode();
    const hasRequestPermissionFn = !!this.context?.requestPermissionFn;
    if (!hasRequestPermissionFn && this._batchAbortController?.signal.aborted) {
      return [];
    }

    const confirmationBatch = await getToolConfirmationInfo(filteredToolUses);

    if (getExecRuntimeConfig().getSkipAllConfirmations()) {
      return filteredToolUses.map((tool) => tool.id);
    }

    const confirmationToolIds = new Set(
      confirmationBatch.toolUses.map((info) => info.toolUseId)
    );
    const nonConfirmationToolIds = filteredToolUses
      .filter((tool) => !confirmationToolIds.has(tool.id))
      .map((tool) => tool.id);

    if (confirmationBatch.toolUses.length === 0) {
      return filteredToolUses.map((tool) => tool.id);
    }

    if (isNonInteractiveExec && !hasRequestPermissionFn) {
      confirmationBatch.toolUses.forEach((info) => {
        this._deniedConfirmationInfoByToolId.set(info.toolUseId, info);
      });

      const hasExecPermissionDenial = confirmationBatch.toolUses.some(
        (info) =>
          info.confirmationType === ToolConfirmationType.Execute ||
          info.confirmationType === ToolConfirmationType.McpTool
      );
      if (
        hasExecPermissionDenial &&
        !getExecRuntimeConfig().getSkipAllConfirmations()
      ) {
        this._immediateExit = true;
      }
      return nonConfirmationToolIds;
    }

    try {
      const currentMode = getSessionService().getCurrentAutonomyMode();
      const sessionId =
        this.context?.sessionId ||
        getSessionService().getCurrentSessionId() ||
        'unknown';
      const transcriptPath =
        getSessionService().getSessionTranscriptPath() || '';
      await executeHooksWithDisplay(
        HookEventName.Notification,
        {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: process.cwd(),
          permission_mode: getPermissionModeString(currentMode),
          hook_event_name: HookEventName.Notification,
          message: `Industry CLI needs permission to execute ${confirmationBatch.toolUses.length} tool(s)`,
          notification_type: 'permission_prompt',
        },
        undefined,
        { updateAction: this.updateAction, sessionId }
      );
    } catch {
      // Hooks should never block UI - error already logged by HookService
    }

    if (hasRequestPermissionFn) {
      try {
        const abortPromise = new Promise<never>((_, reject) => {
          const signal = this._batchAbortController?.signal;
          if (signal?.aborted) {
            reject(new Error('Batch cancelled'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(new Error('Batch cancelled')),
            { once: true }
          );
        });
        const result = await Promise.race([
          this.context!.requestPermissionFn!(confirmationBatch),
          abortPromise,
        ]);
        this.applyPermissionResponseMetadata(
          confirmationBatch.toolUses,
          result.outcome,
          result.comment,
          result.editedSpecContent
        );

        await this.persistMcpPermissionsIfApplicable(
          result.outcome,
          result.approvedToolIds,
          confirmationBatch.toolUses
        );

        if (
          isDelegatedAutoRejectSession() &&
          result.outcome === ToolConfirmationOutcome.Cancel
        ) {
          // Approver-backed subagents (parent reachable over JSON-RPC/ACP)
          // forward their prompts to a real user. With subagents_v2 a user
          // rejection should end the subagent turn so the caller/TaskOutput
          // stops waiting, rather than auto-denying and nudging it onward.
          // No-approver workers (and v2-off subagents) keep the auto-deny path.
          const isApproverBackedSubagent = !isNoApproverDelegatedSession();
          const terminateSubagentOnReject =
            isApproverBackedSubagent &&
            getExecRuntimeConfig().isSubAgentsV2Enabled();

          if (terminateSubagentOnReject) {
            this._permissionRejectionEndedTurn = true;
          } else {
            confirmationBatch.toolUses.forEach((info) => {
              if (result.approvedToolIds.includes(info.toolUseId)) {
                return;
              }

              this._delegatedAutoDeniedToolIds.add(info.toolUseId);
              this._deniedConfirmationInfoByToolId.set(info.toolUseId, info);
            });
          }
        }

        return [...result.approvedToolIds, ...nonConfirmationToolIds];
      } catch (error) {
        const failureMessage =
          error instanceof Error ? error.message : String(error);
        this._permissionRequestFailureMessage = failureMessage;
        this._permissionRequestFailedToolIds = new Set(
          confirmationBatch.toolUses.map((info) => info.toolUseId)
        );

        logWarn('[ToolExecutor] Batch permission request failed', {
          cause: error,
        });
        return nonConfirmationToolIds;
      }
    }

    const batchDetails: BatchToolConfirmationDetails = {
      tools: confirmationBatch.toolUses,
      onConfirm: (
        outcome: ToolConfirmationOutcome,
        approvedToolIds?: string[],
        comment?: string,
        editedSpecContent?: string
      ) =>
        this.handleConfirmation(
          outcome,
          approvedToolIds,
          comment,
          editedSpecContent
        ),
    };

    const requestId = messageId;
    const sessionId =
      this.context?.sessionId ||
      getSessionService().getCurrentSessionId() ||
      'unknown';

    const confirmationResult = await new Promise<{
      approvedToolIds: string[];
      outcome: ToolConfirmationOutcome;
      comment?: string;
      editedSpecContent?: string;
    }>((resolve) => {
      this._pendingConfirmation?.unsubscribe?.();

      const confirmationData = {
        details: batchDetails,
        resolve,
        requestId,
        unsubscribe: undefined as undefined | (() => void),
      };
      this._pendingConfirmation = confirmationData;
      this.onPendingConfirmationChange?.(batchDetails);

      const handlePermissionResponse = (payload: {
        requestId: string;
        approvedToolIds: string[];
        outcome?: ToolConfirmationOutcome;
        comment?: string;
        editedSpecContent?: string;
        sessionId: string;
        failure?: unknown;
      }) => {
        if (payload.requestId === requestId) {
          if (this._pendingConfirmation?.requestId === requestId) {
            this._pendingConfirmation?.unsubscribe?.();
            this._pendingConfirmation = null;
            this.onPendingConfirmationChange?.(null);
            resolve({
              approvedToolIds: payload.approvedToolIds,
              outcome: payload.outcome ?? ToolConfirmationOutcome.ProceedOnce,
              comment: payload.comment,
              editedSpecContent: payload.editedSpecContent,
            });
          }
        }
      };

      confirmationData.unsubscribe = subscribeToAgentEvents(
        AgentEvent.PermissionResponse,
        handlePermissionResponse
      );

      agentEventBus.emit(AgentEvent.PermissionRequest, {
        requestId,
        toolUses: confirmationBatch.toolUses,
        options: confirmationBatch.options,
        sessionId,
      });

      if (this._suppressNextAwaitingSound) {
        this._suppressNextAwaitingSound = false;
      } else {
        const awaitingSound = getSettingsService().getAwaitingInputSound();
        if (awaitingSound !== 'off') {
          const focusMode = getSettingsService().getSoundFocusMode();
          playCompletionSound(awaitingSound, {}, focusMode).catch(() => {});
        }
      }
    });

    this.applyPermissionResponseMetadata(
      confirmationBatch.toolUses,
      confirmationResult.outcome,
      confirmationResult.comment,
      confirmationResult.editedSpecContent
    );

    await this.persistMcpPermissionsIfApplicable(
      confirmationResult.outcome,
      confirmationResult.approvedToolIds,
      confirmationBatch.toolUses
    );

    // Return both approved confirmation tools AND all non-confirmation tools
    return [...confirmationResult.approvedToolIds, ...nonConfirmationToolIds];
  }

  private static getExecModeGuidance(): string {
    const sessionService = getSessionService();
    const interactionMode = sessionService.getInteractionMode();
    const autonomyLevel = sessionService.getAutonomyLevel();
    const t = getI18n().t;

    if (interactionMode === DroolInteractionMode.Spec) {
      return t('common:execMode.guidanceSpec');
    }

    if (
      interactionMode === DroolInteractionMode.Mission ||
      autonomyLevel === AutonomyLevel.High
    ) {
      return t('common:execMode.guidanceHigh');
    }

    if (autonomyLevel === AutonomyLevel.Medium) {
      return t('common:execMode.guidanceMedium');
    }

    if (autonomyLevel === AutonomyLevel.Low) {
      return t('common:execMode.guidanceLow');
    }

    return t('common:execMode.guidanceDefault');
  }

  private getExecModeCancellationMessage(toolUse: ToolUseItem): string | null {
    if (!this._immediateExit) {
      return null;
    }

    const deniedInfo = this._deniedConfirmationInfoByToolId.get(toolUse.id);
    if (!deniedInfo) {
      return null;
    }

    const t = getI18n().t;
    const guidance = ToolExecutor.getExecModeGuidance();

    if (deniedInfo.confirmationType === ToolConfirmationType.McpTool) {
      return `${ERROR_PREFIX} ${t('common:execMode.mcpToolInsufficientPermission', { toolName: deniedInfo.toolName, guidance })}`;
    }

    if (deniedInfo.confirmationType === ToolConfirmationType.Execute) {
      return `${ERROR_PREFIX} ${t('common:execMode.insufficientPermission', { guidance })}`;
    }

    return null;
  }

  /**
   * Create a requestPermissionFn for TUI mode that uses the same
   * pendingConfirmation mechanism as standard tool confirmations.
   * This allows sandbox prompts to display in the TUI.
   */
  private createTuiRequestPermissionFn(messageId: string): (batch: {
    toolUses: ToolConfirmationInfo[];
    options: ToolConfirmationListItem[];
  }) => Promise<{
    approvedToolIds: string[];
    outcome: ToolConfirmationOutcome;
  }> {
    return (batch) => {
      const requestId = `sandbox-${messageId}-${crypto.randomUUID()}`;
      const sessionId =
        this.context?.sessionId ||
        getSessionService().getCurrentSessionId() ||
        'unknown';

      return new Promise<{
        approvedToolIds: string[];
        outcome: ToolConfirmationOutcome;
      }>((resolve) => {
        this._pendingConfirmation?.unsubscribe?.();

        const onConfirm = (
          outcome: ToolConfirmationOutcome,
          approvedToolIds?: string[],
          comment?: string,
          editedSpecContent?: string
        ) =>
          this.handleConfirmation(
            outcome,
            approvedToolIds,
            comment,
            editedSpecContent
          );

        const batchDetails: BatchToolConfirmationDetails = {
          tools: batch.toolUses,
          onConfirm,
        };

        const confirmationData = {
          details: batchDetails,
          resolve,
          requestId,
          unsubscribe: undefined as undefined | (() => void),
        };
        this._pendingConfirmation = confirmationData;
        this.onPendingConfirmationChange?.(batchDetails);

        const handlePermissionResponse = (payload: {
          requestId: string;
          approvedToolIds: string[];
          outcome?: ToolConfirmationOutcome;
          sessionId: string;
          failure?: unknown;
        }) => {
          if (payload.requestId === requestId) {
            if (this._pendingConfirmation?.requestId === requestId) {
              this._pendingConfirmation?.unsubscribe?.();
              this._pendingConfirmation = null;
              this.onPendingConfirmationChange?.(null);
              resolve({
                approvedToolIds: payload.approvedToolIds,
                outcome: payload.outcome ?? ToolConfirmationOutcome.ProceedOnce,
              });
            }
          }
        };

        confirmationData.unsubscribe = subscribeToAgentEvents(
          AgentEvent.PermissionResponse,
          handlePermissionResponse
        );

        agentEventBus.emit(AgentEvent.PermissionRequest, {
          requestId,
          toolUses: batch.toolUses,
          options: batch.options,
          sessionId,
        });
      });
    };
  }

  private resetBatchExecutionState(): void {
    this._modifiedInputs.clear();
    this._immediateExit = false;
    this._permissionRejectionEndedTurn = false;
    this._exitSpecModeConfirmationOutcome = undefined;
    this._exitSpecModeComment = undefined;
    this._exitSpecModeEditedContent = undefined;
    this._missionProposalComment = undefined;
    this.keypressCallbacks?.setExitSpecModeComment(undefined);
    this.keypressCallbacks?.setMissionProposalComment(undefined);
    this._batchAbortController = new AbortController();
    this._permissionRequestFailureMessage = undefined;
    this._permissionRequestFailedToolIds.clear();
    this._deniedConfirmationInfoByToolId.clear();
    this._delegatedAutoDeniedToolIds.clear();
    this._sandboxDenialMessages.clear();
  }

  private cleanupBatchExecutionState(batchToolIds: string[]): void {
    batchToolIds.forEach((toolId) => {
      this._cancelledTools.delete(toolId);
      this._modifiedInputs.delete(toolId);
    });
  }

  private async executeToolBatch(
    toolUses: ToolUseItem[],
    messageId: string,
    batchToolIds: string[]
  ): Promise<ToolBatchExecutionResult> {
    const toolResultsMap = new Map<string, ToolExecutionResult>();
    let wasCancelled = false;
    let shouldStopAfterTools = false;
    let specHandoffPayload: ApprovedSpecNewSessionPayload | undefined;

    const filteredToolUses = await this.prepareToolUsesForConfirmation(
      toolUses,
      messageId
    );
    const filteredToolUseIds = new Set(filteredToolUses.map((tool) => tool.id));
    const approvedToolIds: string[] = [];

    const recordCancelledTools = (cancelledToolIds: string[]): void => {
      const nonAutoDeniedCancelledToolIds = cancelledToolIds.filter(
        (id) => !this._delegatedAutoDeniedToolIds.has(id)
      );
      const isExec = getDroolRuntimeService().isNonInteractiveCLIMode();

      const isReadOnlyMode = getSessionService().isSpecMode();
      const llmToId = buildLlmidToIdMap();
      const allCancelledDueToReadOnlyMode =
        isReadOnlyMode &&
        nonAutoDeniedCancelledToolIds.length > 0 &&
        nonAutoDeniedCancelledToolIds.every((id) => {
          const toolUse = toolUses.find((tool) => tool.id === id);
          if (!toolUse) {
            return false;
          }
          const toolId = llmToId[toolUse.name] || toolUse.name;
          return FILE_MOD_TOOL_IDS.has(toolId);
        });

      wasCancelled =
        wasCancelled ||
        (nonAutoDeniedCancelledToolIds.length > 0 &&
          !allCancelledDueToReadOnlyMode &&
          (!isExec || this._immediateExit));

      const cancelledTools = toolUses.filter((toolUse) =>
        cancelledToolIds.includes(toolUse.id)
      );

      cancelledTools.forEach((toolUse) => {
        if (toolResultsMap.has(toolUse.id)) {
          logWarn(
            '[ToolExecutor] Tool result already exists, skipping update (cancelled)',
            {
              toolId: toolUse.id,
              toolName: toolUse.name,
            }
          );
          return;
        }

        if (this._delegatedAutoDeniedToolIds.has(toolUse.id)) {
          const blockedMessage = buildDelegatedDenialMessage(toolUse);
          this.setToolError(toolUse.id, blockedMessage);
          toolResultsMap.set(toolUse.id, {
            type: MessageContentBlockType.ToolResult,
            toolUseId: toolUse.id,
            content: `${ERROR_PREFIX} ${blockedMessage}`,
            isError: true,
          });
          return;
        }

        const sandboxDenial = this._sandboxDenialMessages.get(toolUse.id);
        if (sandboxDenial) {
          this.setToolError(toolUse.id, sandboxDenial);
          toolResultsMap.set(toolUse.id, {
            type: MessageContentBlockType.ToolResult,
            toolUseId: toolUse.id,
            content: sandboxDenial,
            isError: true,
          });
          return;
        }

        const permissionFailureMessage =
          this._permissionRequestFailedToolIds.has(toolUse.id)
            ? this._permissionRequestFailureMessage
            : undefined;
        const execModeCancellationMessage =
          this.getExecModeCancellationMessage(toolUse);

        const toolId = llmToId[toolUse.name] || toolUse.name;

        if (isReadOnlyMode && FILE_MOD_TOOL_IDS.has(toolId)) {
          const cancelMessage = SPEC_MODE_FULL_ERROR_WITH_PREFIX;
          this.setToolError(toolUse.id, cancelMessage);

          toolResultsMap.set(toolUse.id, {
            type: MessageContentBlockType.ToolResult,
            toolUseId: toolUse.id,
            content: cancelMessage,
            isError: true,
          });
        } else if (toolUse.name === 'ExitSpecMode') {
          const cancelMessage = EXIT_SPEC_MODE_REJECTED;
          this.setToolError(toolUse.id, cancelMessage);

          toolResultsMap.set(toolUse.id, {
            type: MessageContentBlockType.ToolResult,
            toolUseId: toolUse.id,
            content: cancelMessage,
            isError: true,
          });

          if (this.updateAction) {
            this.updateAction({
              type: 'ADD_MESSAGE',
              role: MessageRole.System,
              content: cancelMessage,
              options: {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              },
            });
          }
        } else if (getDroolRuntimeService().isNonInteractiveCLIMode()) {
          const cancelMessage = permissionFailureMessage
            ? `${ERROR_PREFIX} ${getI18n().t('common:toolExecution.cancelledWithReasonShort', { reason: permissionFailureMessage })}`
            : execModeCancellationMessage ||
              `${ERROR_PREFIX} ${getI18n().t('common:toolExecution.cancelledByUserShort')}`;
          this.setToolError(toolUse.id, cancelMessage);

          toolResultsMap.set(toolUse.id, {
            type: MessageContentBlockType.ToolResult,
            toolUseId: toolUse.id,
            content: cancelMessage,
            isError: true,
          });
        } else {
          const cancelMessage = permissionFailureMessage
            ? getI18n().t('common:toolExecution.cancelledWithReason', {
                reason: permissionFailureMessage,
              })
            : getI18n().t('common:toolExecution.cancelledByUser');
          this.setToolError(toolUse.id, cancelMessage);

          toolResultsMap.set(toolUse.id, {
            type: MessageContentBlockType.ToolResult,
            toolUseId: toolUse.id,
            content: cancelMessage,
            isError: true,
          });
        }
      });
    };

    // Record sandbox denials before ordinary confirmations so fail-closed
    // policy results are emitted first.
    const sandboxDeniedTools = toolUses.filter((toolUse) =>
      this._sandboxDenialMessages.has(toolUse.id)
    );
    if (sandboxDeniedTools.length > 0) {
      const isExec = getDroolRuntimeService().isNonInteractiveCLIMode();
      wasCancelled = wasCancelled || !isExec || this._immediateExit;

      sandboxDeniedTools.forEach((toolUse) => {
        const sandboxDenial = this._sandboxDenialMessages.get(toolUse.id);
        if (!sandboxDenial || toolResultsMap.has(toolUse.id)) {
          return;
        }

        this.setToolError(toolUse.id, sandboxDenial);
        toolResultsMap.set(toolUse.id, {
          type: MessageContentBlockType.ToolResult,
          toolUseId: toolUse.id,
          content: sandboxDenial,
          isError: true,
        });
      });
    }

    type ExecOneResult = {
      id: string;
      name: string;
      input: Record<string, unknown>;
      result: ToolResultContent | null;
      error: string | null;
    } | null;

    const executeOne = async (toolUse: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }): Promise<ExecOneResult> => {
      if (toolResultsMap.has(toolUse.id)) {
        logWarn('[ToolExecutor] Tool result already exists', {
          toolId: toolUse.id,
          toolName: toolUse.name,
        });
        return null;
      }

      // Check if tool was cancelled before starting execution
      if (this._batchAbortController?.signal.aborted) {
        this._cancelledTools.add(toolUse.id);
      }

      if (this._cancelledTools.has(toolUse.id)) {
        logWarn('[ToolExecutor] Tool was cancelled, skipping execution', {
          toolId: toolUse.id,
          toolName: toolUse.name,
        });
        wasCancelled = true;

        this.setToolError(
          toolUse.id,
          getI18n().t('common:toolExecution.cancelledByUser')
        );

        return {
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
          result: null,
          error: getI18n().t('common:toolExecution.cancelledByUser'),
        };
      }

      let succeeded = false;
      let errorMessage: string | undefined;
      let toolResult: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        result: ToolResultContent | null;
        error: string | null;
      };
      const toolStartTime = Date.now();

      try {
        this._runningTools.add(toolUse.id);
        if (!toolResultsMap.has(toolUse.id)) {
          this.updateToolStatus?.(toolUse.id, ToolCallStatus.Executing);
        }

        const handleToolUpdate = (update: unknown) => {
          if (!isStreamingUpdate(update)) {
            return;
          }

          if (this._cancelledTools.has(toolUse.id)) {
            return;
          }

          const normalizedUpdate: ToolStreamingUpdate = {
            ...update,
            timestamp: update.timestamp ?? Date.now(),
          };

          if (this.updateAction) {
            this.updateAction({
              type: 'UPDATE_TOOL_PROGRESS',
              id: toolUse.id,
              update: normalizedUpdate,
            });
          }

          this.onToolStreamingUpdate?.({
            toolId: toolUse.id,
            toolName: toolUse.name,
            update: normalizedUpdate,
          });
        };

        const handleInputModified = (
          modifiedInput: Record<string, unknown>
        ) => {
          this._modifiedInputs.set(toolUse.id, modifiedInput);
          this.updateToolCallInput?.(toolUse.id, modifiedInput);
          logInfo('[ToolExecutor] Tool input modified by hook', {
            toolId: toolUse.id,
            toolName: toolUse.name,
          });
        };

        // Get the potentially updated input from ConversationStateManager
        let toolInput = toolUse.input;
        if (this.getToolExecutions) {
          const toolExecutions = this.getToolExecutions();
          const toolExecution = toolExecutions.get(toolUse.id);
          if (toolExecution && toolExecution.input) {
            toolInput = { ...toolUse.input, ...toolExecution.input };
            logInfo('[ToolExecutor] Using updated tool input', {
              toolName: toolUse.name,
              toolId: toolUse.id,
            });
          }
        }

        if (!isDeepStrictEqual(toolInput, toolUse.input)) {
          const sandboxAllowed = await this.requestSandboxAccessForToolUse(
            { ...toolUse, input: toolInput },
            messageId
          );
          if (!sandboxAllowed) {
            const sandboxDenial = this._sandboxDenialMessages.get(toolUse.id);
            const error = sandboxDenial ?? 'Sandbox denied modified tool input';
            this.setToolError(toolUse.id, error);
            return {
              id: toolUse.id,
              name: toolUse.name,
              input: toolInput,
              result: null,
              error,
            };
          }

          // Risk/confirmation was computed from the original input. If the
          // modified input newly requires confirmation (or changes what the
          // prior approval covered) fail closed, so a hook cannot escalate an
          // approved low-risk call into a higher-risk one and run it under the
          // stale approval. We compare a confirmation "signature" rather than
          // just the type, because an Execute call keeps the same type while
          // its fullCommand (e.g. `ls` -> `rm -rf /`) changes.
          if (!getExecRuntimeConfig().getSkipAllConfirmations()) {
            const [originalConfirm, modifiedConfirm] = await Promise.all([
              getToolConfirmationInfo([
                { id: toolUse.id, name: toolUse.name, input: toolUse.input },
              ]),
              getToolConfirmationInfo([
                { id: toolUse.id, name: toolUse.name, input: toolInput },
              ]),
            ]);
            const originalInfo = originalConfirm.toolUses.find(
              (info) => info.toolUseId === toolUse.id
            );
            const modifiedInfo = modifiedConfirm.toolUses.find(
              (info) => info.toolUseId === toolUse.id
            );
            const confirmationSignature = (
              info: ToolConfirmationInfo | undefined
            ): string | null => {
              if (!info) {
                return null;
              }
              if (info.confirmationType === ToolConfirmationType.Execute) {
                const details = info.details as ExecuteToolConfirmationDetails;
                return `${info.confirmationType}:${details.fullCommand}`;
              }
              return info.confirmationType;
            };
            const confirmationEscalated =
              !!modifiedInfo &&
              confirmationSignature(originalInfo) !==
                confirmationSignature(modifiedInfo);
            if (confirmationEscalated) {
              const error =
                'Tool input was modified after approval and now requires re-confirmation; aborting under the stale approval.';
              this.setToolError(toolUse.id, error);
              return {
                id: toolUse.id,
                name: toolUse.name,
                input: toolInput,
                result: null,
                error,
              };
            }
          }
        }

        // Provide requestPermissionFn for sandbox prompts in TUI mode.
        // Always inject regardless of autonomy mode — sandbox violations
        // must always show an interactive prompt, even at Auto High.
        // In non-interactive (exec) mode, do NOT synthesize a TUI callback:
        // the sandbox guard auto-denies when requestPermissionFn is undefined.
        const isNonInteractive =
          getDroolRuntimeService().isNonInteractiveCLIMode();
        const requestPermissionFn = isNonInteractive
          ? this.context?.requestPermissionFn
          : (this.context?.requestPermissionFn ??
            this.createTuiRequestPermissionFn(messageId));

        // Update SRT's domain prompt delegate so Execute tool's network
        // requests can trigger interactive prompts through the proxy.
        setSandboxDomainRequestFn(requestPermissionFn ?? null);

        const result = await executeTool(toolUse.name, toolInput, {
          ...this.context,
          requestPermissionFn,
          toolCallId: toolUse.id,
          abortSignal: this._batchAbortController?.signal,
          updateAction: this.updateAction,
          onToolUpdate: handleToolUpdate,
          onInputModified: handleInputModified,
          confirmationOutcome:
            toolUse.name === 'ExitSpecMode'
              ? this._exitSpecModeConfirmationOutcome
              : toolUse.name === 'ProposeMission'
                ? ToolConfirmationOutcome.ProceedOnce
                : undefined,
          exitSpecModeComment:
            toolUse.name === 'ExitSpecMode'
              ? this._exitSpecModeComment
              : undefined,
          editedSpecContent:
            toolUse.name === 'ExitSpecMode'
              ? this._exitSpecModeEditedContent
              : undefined,
          missionProposalComment:
            toolUse.name === 'ProposeMission'
              ? this._missionProposalComment
              : undefined,
        });

        // Reset state after ExitSpecMode execution
        if (toolUse.name === 'ExitSpecMode') {
          this._exitSpecModeComment = undefined;
          this._exitSpecModeEditedContent = undefined;
          this.keypressCallbacks?.setExitSpecModeComment(undefined);
        }

        // Reset edit mode flag after ProposeMission execution
        if (toolUse.name === 'ProposeMission') {
          this._missionProposalComment = undefined;
          this.keypressCallbacks?.setMissionProposalComment(undefined);
        }

        const toolExecutionLatency = Date.now() - toolStartTime;
        Metrics.recordHistogram(
          Metric.DROOL_MODE_TOOL_EXECUTION_LATENCY,
          toolExecutionLatency / 1000,
          {
            toolId: toolUse.name,
            runtime: DroolRuntime.Local,
            isError: false,
          }
        );
        const customerMetricAttrs = {
          [AttributeName.TOOL_NAME]: toolUse.name,
          [AttributeName.TOOL_CATEGORY]: getToolCategory(toolUse.name),
          [AttributeName.TOOL_RUNTIME]: DroolRuntime.Local,
          [AttributeName.TOOL_SUCCEEDED]: true,
          [AttributeName.AUTONOMY_MODE]:
            getSessionService().getCurrentAutonomyMode(),
          [AttributeName.ENVIRONMENT_TYPE]:
            getDroolRuntimeService().getDroolMode(),
        };
        CustomerMetrics.recordHistogram(
          MetricName.TOOL_EXECUTION_TIME,
          toolExecutionLatency,
          customerMetricAttrs
        );
        CustomerMetrics.addToCounter(
          MetricName.TOOL_INVOCATIONS,
          1,
          customerMetricAttrs
        );

        succeeded = true;

        // Check if tool was cancelled during execution
        if (this._cancelledTools.has(toolUse.id)) {
          logWarn(
            '[ToolExecutor] Tool was cancelled during execution, discarding result',
            {
              toolId: toolUse.id,
              toolName: toolUse.name,
            }
          );
          wasCancelled = true;

          this.setToolError(
            toolUse.id,
            getI18n().t('common:toolExecution.cancelledByUser')
          );

          return {
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
            result: null,
            error: getI18n().t('common:toolExecution.cancelledByUser'),
          };
        }

        if (toolUse.name === 'ProposeMission' && this.updateAction) {
          const parsedResult = parseProposeMissionResult(result);
          if (parsedResult?.accepted && parsedResult.missionDir) {
            if (parsedResult.isEdited && parsedResult.llmGuidance) {
              this.updateAction({
                type: 'ADD_SYSTEM_NOTIFICATION',
                content: parsedResult.llmGuidance,
              });
            } else {
              this.updateAction({
                type: 'ADD_SYSTEM_NOTIFICATION',
                content: getMissionApprovalReminder(parsedResult.missionDir),
              });
            }
          }
        }

        // Check again if tool was cancelled before running PostToolUse hooks
        if (this._cancelledTools.has(toolUse.id)) {
          logWarn(
            '[ToolExecutor] Tool was cancelled before PostToolUse hooks, skipping hooks',
            {
              toolId: toolUse.id,
              toolName: toolUse.name,
            }
          );
          wasCancelled = true;

          const cancelMessage = getI18n().t(
            'common:toolExecution.cancelledByUser'
          );
          this.setToolError(toolUse.id, cancelMessage);

          return {
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
            result: null,
            error: cancelMessage,
          };
        }

        // Execute PostToolUse hooks
        let gitAiCheckpointPostToolUseExecution:
          | Promise<HookExecutionResult[]>
          | undefined;
        try {
          const currentMode = getSessionService().getCurrentAutonomyMode();
          const hookSessionId =
            this.context?.sessionId ||
            getSessionService().getCurrentSessionId() ||
            'unknown';
          const transcriptPath =
            getSessionService().getSessionTranscriptPath() || '';
          const hookResults = await executeHooksWithDisplay(
            HookEventName.PostToolUse,
            {
              session_id: hookSessionId,
              transcript_path: transcriptPath,
              cwd: process.cwd(),
              permission_mode: getPermissionModeString(currentMode),
              hook_event_name: HookEventName.PostToolUse,
              tool_name: toolUse.name,
              tool_input: toolUse.input,
              tool_response: result,
            },
            toolUse.name,
            {
              ...this.context,
              updateAction: this.updateAction,
              sessionId: hookSessionId,
              toolCallId: toolUse.id,
              abortSignal: this._batchAbortController?.signal,
              onBackgroundHookScheduled: (hook) => {
                if (
                  hook.eventName === HookEventName.PostToolUse &&
                  hook.commands.some((command) =>
                    isDroolGitAiCheckpointHookCommand(command.command)
                  )
                ) {
                  gitAiCheckpointPostToolUseExecution = hook.execution;
                }
                this.context?.onBackgroundHookScheduled?.(hook);
              },
            }
          );

          if (
            this._cancelledTools.has(toolUse.id) ||
            this._batchAbortController?.signal.aborted
          ) {
            logWarn(
              '[ToolExecutor] Tool was cancelled during PostToolUse hooks, discarding result',
              {
                toolId: toolUse.id,
                toolName: toolUse.name,
              }
            );
            wasCancelled = true;

            const cancelMessage = getI18n().t(
              'common:toolExecution.cancelledByUser'
            );
            this.setToolError(toolUse.id, cancelMessage);

            return {
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input,
              result: null,
              error: cancelMessage,
            };
          }

          // Process hook results in priority order

          // 1. Check `continue` field first (highest priority)
          const stopResult = hookResults.find((r) => r.continue === false);
          if (stopResult) {
            const reason =
              stopResult.stopReason ||
              getI18n().t('common:toolExecution.hookRequestedStop');
            throw new HookStopError(reason);
          }

          // 2. Add additionalContext to conversation
          const contextResult = hookResults.find(
            (r) => r.hookSpecificOutput?.additionalContext
          );
          if (
            contextResult?.hookSpecificOutput?.additionalContext &&
            this.updateAction
          ) {
            this.updateAction({
              type: 'ADD_MESSAGE',
              role: MessageRole.System,
              content: contextResult.hookSpecificOutput.additionalContext,
              options: { visibility: MessageVisibility.LLMOnly },
            });
          }

          // 3. Display systemMessage if provided
          const systemMsgResult = hookResults.find((r) => r.systemMessage);
          if (systemMsgResult && this.updateAction) {
            this.updateAction({
              type: 'ADD_MESSAGE',
              role: MessageRole.System,
              content: `${getI18n().t('common:hooks.warningPrefix')} ${systemMsgResult.systemMessage}`,
              options: { visibility: MessageVisibility.UserOnly },
            });
          }

          // 4. Exit code 3: Abort agent entirely (custom drool behavior)
          const abortResult = hookResults.find((r) => r.exitCode === 3);
          if (abortResult) {
            const errorMsg =
              abortResult.stderr ||
              getI18n().t('common:toolExecution.agentAbortedByHook');
            throw new AgentAbortError(errorMsg);
          }

          // 5. Exit code 2: Show stderr to Drool (Claude Code standard)
          const blockingResult = hookResults.find((r) => r.exitCode === 2);
          if (blockingResult) {
            const message =
              blockingResult.stderr ||
              getI18n().t('common:toolExecution.hookReportedIssue');
            if (this.updateAction) {
              this.updateAction({
                type: 'ADD_MESSAGE',
                role: MessageRole.System,
                content: `${getI18n().t('common:hooks.postToolUseFeedbackPrefix')} ${message}`,
                options: { visibility: MessageVisibility.LLMOnly },
              });
            }
          }

          // 6. Exit code 1: Show stderr to user only (non-blocking)
          const errorResult = hookResults.find((r) => r.exitCode === 1);
          if (errorResult && errorResult.stderr) {
            if (this.updateAction) {
              this.updateAction({
                type: 'ADD_MESSAGE',
                role: MessageRole.System,
                content: `${getI18n().t('common:hooks.postToolUseWarningPrefix')} ${errorResult.stderr}`,
                options: { visibility: MessageVisibility.UserOnly },
              });
            }
          }
        } catch (hookError) {
          const hookErrorName =
            hookError instanceof Error ? hookError.name : '';
          if (
            hookErrorName === 'HookExecutionError' ||
            hookErrorName === 'HookStopError' ||
            hookErrorName === 'AgentAbortError' ||
            hookErrorName === 'ToolExecutionControlError'
          ) {
            throw hookError;
          }
          logException(hookError, '[Hooks] PostToolUse execution failed');
        }

        if (!toolResultsMap.has(toolUse.id)) {
          this.updateToolResult(toolUse.id, result);
        }

        // Push git-ai checkpoint to Firestore (fire-and-forget)
        const checkpointSessionId =
          this.context?.sessionId || getSessionService().getCurrentSessionId();
        const resolvedToolId =
          buildLlmidToIdMap()[toolUse.name] || toolUse.name;
        if (
          checkpointSessionId &&
          getToolCategory(resolvedToolId) === ToolCategory.Edit
        ) {
          const pushCheckpoint = async () => {
            if (gitAiCheckpointPostToolUseExecution) {
              await gitAiCheckpointPostToolUseExecution;
            }
            await getGitAiService().pushCheckpoint(checkpointSessionId);
          };
          void pushCheckpoint().catch((error: unknown) => {
            logWarn('Failed to push git-ai checkpoint', {
              cause: error,
            });
          });
        }

        toolResult = {
          id: toolUse.id,
          name: toolUse.name,
          input: this._modifiedInputs.get(toolUse.id) || toolUse.input,
          result,
          error: null,
        };
      } catch (toolError) {
        this._runningTools.delete(toolUse.id);

        const errorName = toolError instanceof Error ? toolError.name : '';

        // 1. AgentAbortError: Abort entire agent (most critical)
        if (errorName === 'AgentAbortError') {
          throw toolError;
        }

        // 2. HookStopError: Stop current execution flow
        if (errorName === 'HookStopError') {
          throw toolError;
        }

        // 2b. ToolAbortError: a tool aborted (e.g. user cancelled an AskUser
        // prompt). Treat it as a cancellation that ends the turn even when the
        // batch was not aborted, so the agent loop stops rather than feeding a
        // recoverable error result back to the model.
        if (errorName === 'ToolAbortError') {
          wasCancelled = true;

          const cancelMessage = getI18n().t(
            'common:toolExecution.cancelledByUser'
          );
          if (!toolResultsMap.has(toolUse.id)) {
            this.setToolError(toolUse.id, cancelMessage);
          }

          return {
            id: toolUse.id,
            name: toolUse.name,
            input: this._modifiedInputs.get(toolUse.id) || toolUse.input,
            result: null,
            error: cancelMessage,
          };
        }

        // 3. HookExecutionError / ToolExecutionControlError
        if (
          errorName === 'HookExecutionError' ||
          errorName === 'ToolExecutionControlError'
        ) {
          const toolExecutionLatency = Date.now() - toolStartTime;
          Metrics.recordHistogram(
            Metric.DROOL_MODE_TOOL_EXECUTION_LATENCY,
            toolExecutionLatency / 1000,
            {
              toolId: toolUse.name,
              runtime: DroolRuntime.Local,
              isError: true,
            }
          );
          const customerMetricAttrs = {
            [AttributeName.TOOL_NAME]: toolUse.name,
            [AttributeName.TOOL_CATEGORY]: getToolCategory(toolUse.name),
            [AttributeName.TOOL_RUNTIME]: DroolRuntime.Local,
            [AttributeName.TOOL_SUCCEEDED]: false,
            [AttributeName.AUTONOMY_MODE]:
              getSessionService().getCurrentAutonomyMode(),
            [AttributeName.ENVIRONMENT_TYPE]:
              getDroolRuntimeService().getDroolMode(),
          };
          CustomerMetrics.recordHistogram(
            MetricName.TOOL_EXECUTION_TIME,
            toolExecutionLatency,
            customerMetricAttrs
          );
          CustomerMetrics.addToCounter(
            MetricName.TOOL_INVOCATIONS,
            1,
            customerMetricAttrs
          );

          errorMessage =
            toolError instanceof Error ? toolError.message : String(toolError);
          if (!toolResultsMap.has(toolUse.id)) {
            this.setToolError(toolUse.id, errorMessage);
          }

          if (this.updateAction) {
            this.updateAction({
              type: 'ADD_MESSAGE',
              role: MessageRole.System,
              content: getI18n().t('errors:agent.toolExecutionError', {
                message: errorMessage,
              }),
              options: { visibility: MessageVisibility.UserOnly },
            });
          }

          toolResult = {
            id: toolUse.id,
            name: toolUse.name,
            input: this._modifiedInputs.get(toolUse.id) || toolUse.input,
            result: null,
            error: errorMessage,
          };

          logInfo('[ToolExecutor] tool execution blocked by hook', {
            name: toolUse.name,
            value: toolUse.input,
            succeeded: false,
            modelId: getSessionService().getModel(),
          });

          return toolResult;
        }

        // Check if tool was cancelled during execution
        if (this._cancelledTools.has(toolUse.id)) {
          logWarn(
            '[ToolExecutor] Tool was cancelled during execution (error path), discarding error',
            {
              toolId: toolUse.id,
              toolName: toolUse.name,
            }
          );
          wasCancelled = true;

          this.setToolError(
            toolUse.id,
            getI18n().t('common:toolExecution.cancelledByUser')
          );

          return {
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
            result: null,
            error: getI18n().t('common:toolExecution.cancelledByUser'),
          };
        }

        const toolExecutionLatency = Date.now() - toolStartTime;
        Metrics.recordHistogram(
          Metric.DROOL_MODE_TOOL_EXECUTION_LATENCY,
          toolExecutionLatency / 1000,
          {
            toolId: toolUse.name,
            runtime: DroolRuntime.Local,
            isError: true,
          }
        );
        const customerMetricAttrs = {
          [AttributeName.TOOL_NAME]: toolUse.name,
          [AttributeName.TOOL_CATEGORY]: getToolCategory(toolUse.name),
          [AttributeName.TOOL_RUNTIME]: DroolRuntime.Local,
          [AttributeName.TOOL_SUCCEEDED]: false,
          [AttributeName.AUTONOMY_MODE]:
            getSessionService().getCurrentAutonomyMode(),
          [AttributeName.ENVIRONMENT_TYPE]:
            getDroolRuntimeService().getDroolMode(),
        };
        CustomerMetrics.recordHistogram(
          MetricName.TOOL_EXECUTION_TIME,
          toolExecutionLatency,
          customerMetricAttrs
        );
        CustomerMetrics.addToCounter(
          MetricName.TOOL_INVOCATIONS,
          1,
          customerMetricAttrs
        );

        errorMessage =
          toolError instanceof Error
            ? toolError.message
            : getI18n().t('common:toolExecution.unknownError');
        if (!toolResultsMap.has(toolUse.id)) {
          this.setToolError(toolUse.id, errorMessage);
        }

        toolResult = {
          id: toolUse.id,
          name: toolUse.name,
          input: this._modifiedInputs.get(toolUse.id) || toolUse.input,
          result: null,
          error: errorMessage ?? null,
        };
      } finally {
        this._runningTools.delete(toolUse.id);
        logInfo('[ToolExecutor] tool execution', {
          name: toolUse.name,
          succeeded,
          modelId: getSessionService().getModel(),
        });
      }

      return toolResult;
    };

    const storeExecResult = async (execResult: ExecOneResult) => {
      if (!execResult) return;

      if (toolResultsMap.has(execResult.id)) {
        logWarn('[ToolExecutor] Skipping duplicate tool result', {
          toolId: execResult.id,
        });
        return;
      }
      const content = execResult.error
        ? `Error: ${execResult.error}`
        : execResult.result!;
      toolResultsMap.set(execResult.id, {
        type: MessageContentBlockType.ToolResult,
        toolUseId: execResult.id,
        content,
        isError: !!execResult.error,
      });

      // Add system message after ExitSpecMode tool completes
      if (execResult.name === 'ExitSpecMode') {
        if (execResult.error) {
          if (this.updateAction) {
            this.updateAction({
              type: 'ADD_MESSAGE',
              role: MessageRole.System,
              content: getI18n().t(
                'common:specModeConfirmation.failedToFinishSpec',
                { error: execResult.error }
              ),
              options: {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              },
            });
          }
        } else if (execResult.result) {
          try {
            let resultObj: ExitSpecModeResult | null = null;

            if (typeof execResult.result === 'string') {
              try {
                resultObj = JSON.parse(execResult.result);
              } catch {
                // Not JSON, skip
              }
            } else if (
              typeof execResult.result === 'object' &&
              execResult.result !== null &&
              'approved' in execResult.result &&
              'filePath' in execResult.result
            ) {
              resultObj = execResult.result as unknown as ExitSpecModeResult;
            }

            logInfo('[ToolExecutor] ExitSpecMode storeExecResult', {
              found: !!resultObj,
              isUpdate: !!this.updateAction,
              // eslint-disable-next-line industry/no-nested-log-metadata -- spec-mode result flags consumed as a unit
              value: {
                approved: resultObj?.approved,
                isEdited: resultObj?.isEdited,
              },
            });

            if (resultObj && resultObj.approved) {
              // Add LLM-visible system notification so the model knows
              // spec mode is exited and which option was selected
              if (this.updateAction) {
                if (!resultObj.isEdited) {
                  this.updateAction({
                    type: 'ADD_SYSTEM_NOTIFICATION',
                    content: getSystemExitSpecModeMessage(),
                  });
                } else {
                  this.updateAction({
                    type: 'ADD_SYSTEM_NOTIFICATION',
                    content: getSystemExitSpecModeEditMessage(),
                  });
                }
              }

              if (resultObj.handoff?.isNewSession && resultObj.handoff.plan) {
                shouldStopAfterTools = true;

                const handoffAutonomyLevel =
                  this._exitSpecModeConfirmationOutcome &&
                  isNewSessionOutcome(this._exitSpecModeConfirmationOutcome)
                    ? newSessionOutcomeToAutonomyLevel(
                        this._exitSpecModeConfirmationOutcome
                      )
                    : AutonomyLevel.Off;

                specHandoffPayload = {
                  plan: resultObj.handoff.plan,
                  title: resultObj.handoff.title,
                  filePath: resultObj.filePath,
                  userComment:
                    resultObj.userComment ?? resultObj.handoff.userComment,
                  autonomyLevel: handoffAutonomyLevel,
                };
              } else if (
                resultObj.isEdited &&
                resultObj.editStatus === 'in_progress'
              ) {
                shouldStopAfterTools = true;
              } else {
                // Regular spec approval (not new-session handoff):
                // Switch interaction mode from Spec to Auto so the agent continues
                const sessionService = getSessionService();
                if (sessionService.isSpecMode()) {
                  sessionService.setInteractionMode(DroolInteractionMode.Auto);
                }
              }

              if (execResult.name === 'ExitSpecMode') {
                this._exitSpecModeConfirmationOutcome = undefined;
              }
            }
          } catch (error) {
            logWarn(
              '[ToolExecutor] Failed to process ExitSpecMode result for system message',
              {
                error,
              }
            );
          }
        }
      }
    };

    const executeApprovedTools = async (approvedTools: ToolUseItem[]) => {
      if (approvedTools.length === 0) {
        return;
      }

      const segments = segmentToolUsesForExecution(approvedTools);
      await segments.reduce<Promise<void>>(async (prev, seg) => {
        await prev;
        if (seg.parallel.length > 0) {
          const batchResults = await Promise.all(
            seg.parallel.map((tool) => executeOne(tool))
          );
          await Promise.all(batchResults.map(storeExecResult));
        }
        if (seg.sequential) {
          const result = await executeOne(seg.sequential);
          await storeExecResult(result);
        }
      }, Promise.resolve());
    };

    const filteredSegments = segmentToolUsesByConcurrency(filteredToolUses);
    for (const segment of filteredSegments) {
      if (segment.parallel.length > 0) {
        const segmentApprovedToolIds =
          await this.requestConfirmationForToolUses(
            segment.parallel,
            messageId
          );
        approvedToolIds.push(...segmentApprovedToolIds);
        await executeApprovedTools(
          segment.parallel.filter((toolUse) =>
            segmentApprovedToolIds.includes(toolUse.id)
          )
        );
      }

      if (segment.sequential) {
        const segmentApprovedToolIds =
          await this.requestConfirmationForToolUses(
            [segment.sequential],
            messageId
          );
        approvedToolIds.push(...segmentApprovedToolIds);
        await executeApprovedTools(
          segmentApprovedToolIds.includes(segment.sequential.id)
            ? [segment.sequential]
            : []
        );
      }
    }

    const cancelledToolIds = Array.from(
      new Set([
        ...batchToolIds.filter((id) => !approvedToolIds.includes(id)),
        ...approvedToolIds.filter((id) => this._cancelledTools.has(id)),
      ])
    ).filter((id) => !toolResultsMap.has(id) || !filteredToolUseIds.has(id));
    recordCancelledTools(cancelledToolIds);

    // Convert Map back to array for return
    const toolResults = Array.from(toolResultsMap.values());
    return {
      results: toolResults,
      wasCancelled,
      permissionRejected: this._permissionRejectionEndedTurn,
      shouldStopAfterTools,
      specHandoffPayload,
    };
  }

  async executeTools(
    toolUses: ToolUseItem[],
    messageId: string
  ): Promise<ToolBatchExecutionResult> {
    const batchToolIds = toolUses.map((toolUse) => toolUse.id);

    this.resetBatchExecutionState();

    try {
      return await this.executeToolBatch(toolUses, messageId, batchToolIds);
    } finally {
      this.cleanupBatchExecutionState(batchToolIds);
    }
  }

  async cancelAllTools(): Promise<void> {
    const sessionId =
      this.context?.sessionId ||
      getSessionService().getCurrentSessionId() ||
      undefined;

    this.getCancellableToolIds().forEach((toolId) => {
      this._cancelledTools.add(toolId);
    });

    // Cancel any pending confirmations by emitting empty response
    const pending = this._pendingConfirmation;
    if (pending) {
      agentEventBus.emit(AgentEvent.PermissionResponse, {
        requestId: pending.requestId,
        approvedToolIds: [],
        sessionId: sessionId ?? 'unknown',
      });
    }

    // Abort the batch controller to signal all running tools
    this._batchAbortController?.abort();

    // Mark all running tools with error status immediately (non-blocking)
    const runningToolIds = Array.from(this._runningTools);
    runningToolIds.forEach((toolId) => {
      this.setToolError(
        toolId,
        getI18n().t('common:toolExecution.cancelledByUser')
      );
      this.updateToolStatus?.(toolId, ToolCallStatus.Error);
    });

    this._runningTools.clear();

    // Kill processes and terminals in background (fire-and-forget)
    // This avoids blocking cancellation on slow process cleanup
    const terminalService = getTerminalService();
    void Promise.allSettled(
      runningToolIds.flatMap((toolId) => [
        processTracker.killToolProcesses(toolId, 'SIGTERM'),
        terminalService.killByToolId(toolId),
      ])
    );

    try {
      await backgroundTaskManager.killAllTasks(sessionId, process.pid);
    } catch (error) {
      logWarn('[ToolExecutor] Failed to kill background tasks', {
        sessionId,
        cause: error,
      });
    }

    this._runningTools.clear();
  }
}
