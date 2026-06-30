import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { LLMModel } from '@industry/common/llm';
import { SESSION_TAG_SUBAGENT } from '@industry/common/session';
import {
  askUserTool,
  dismissHandoffItemsTool,
  endFeatureRunTool,
  exaWebSearchToolInputJsonSchema,
  exitSpecModeTool,
  executeCliTool,
  getWebSearchDescription,
  parallelWebSearchToolInputJsonSchema,
  proposeMissionTool,
  skillTool,
  startMissionRunTool,
  youWebSearchToolInputJsonSchema,
  webSearchTool,
} from '@industry/drool-core/tools/definitions';
import { getExecuteCliDescription } from '@industry/drool-core/tools/definitions/cli/executeCli';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  DraftToolFeedback,
  ToolImplementation,
  IndustryTool,
  LLMToolDescriptor,
  ToolOverrides,
} from '@industry/drool-core/tools/types';
import { DEFAULT_OUTPUT_TRUNCATION_THRESHOLD } from '@industry/drool-core/tools/utils/constants';
import { handleLargeStringOutput } from '@industry/drool-core/tools/utils/large-output';
import { getOutputTruncationThresholdForTool } from '@industry/drool-core/tools/utils/truncation-whitelist';
import { DecompSessionType } from '@industry/drool-sdk-ext/protocol/drool';
import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';
import { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';
import { logException, logInfo, Metrics } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { getFlag } from '@industry/runtime/feature-flags';

import { ToolExecutionContext } from '@/agent/types';
import { HookEventName } from '@/hooks/enums';
import {
  AgentAbortError,
  HookStopError,
  ToolExecutionControlError,
} from '@/hooks/errors';
import { ToolResultContent } from '@/hooks/types';
import { getI18n } from '@/i18n';
import { getTuiModelConfig } from '@/models/config';
import { handleAllowAlways } from '@/sandbox/allowAlwaysPersistence';
import { SandboxPromptResult } from '@/sandbox/enums';
import { requestSandboxPermission } from '@/sandbox/SandboxPermissionPrompt';
import { checkSandboxViolationsForTool } from '@/sandbox/sandboxPreCheck';
import type { SandboxPermissionRequestFn } from '@/sandbox/types';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { executeHooksWithDisplay } from '@/services/hook-utils';
import { getDecompSessionTypeFromTags } from '@/services/mission/sessionTags';
import { sessionConfigService } from '@/services/SessionConfigService';
import {
  getPermissionModeString,
  getSessionService,
} from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import {
  getModelInvocableSkills,
  getStableSkillToolDescription,
} from '@/skills/availableSkillsReminder';
import { getAllSkills } from '@/skills/builtin';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';
import { getTUIToolRegistry } from '@/tools/registry';
import '@/tools/tui';
import { CliClientToolDependencies } from '@/tools/types';
import { getRuntimeShell } from '@/utils/runtimeShell';
import { sanitizeSkillName } from '@/utils/skills/paths';
import { evaluateToolEnabled } from '@/utils/toolAvailability';
import { truncateOutput } from '@/utils/truncate';

// Tool IDs for mission decomposition - used to gate tools by session type
const ORCHESTRATOR_TOOL_IDS = new Set([
  proposeMissionTool.id,
  startMissionRunTool.id,
  dismissHandoffItemsTool.id,
]);
// TODO: add a canonical select_feature tool definition (currently CLI-only).
const WORKER_TOOL_IDS = new Set([endFeatureRunTool.id]);
// Tools that must be stripped from worker sessions in addition to the
// orchestrator-only set. AskUser has no interactive user to answer inside
// a mission worker and would otherwise hang or be auto-cancelled with no
// recourse, wasting a turn and risking a mission stall.
const WORKER_FORBIDDEN_TOOL_IDS = new Set([
  ...ORCHESTRATOR_TOOL_IDS,
  askUserTool.id,
]);
const SUBAGENT_FORBIDDEN_TOOL_IDS = new Set([askUserTool.id]);

/**
 * Filter tools based on decomposition session type.
 * - Orchestrator sessions: get orchestrator tools only
 * - Worker sessions: get worker tools only
 * - Normal sessions: get neither
 */
function filterDecompTools(tools: IndustryTool[]): IndustryTool[] {
  const currentTags = getSessionService().getCurrentSessionTags();
  const decompSessionType = getDecompSessionTypeFromTags(currentTags);
  const isSubagentSession =
    currentTags?.some((tag) => tag.name === SESSION_TAG_SUBAGENT) ?? false;
  const filterSubagentTools = (candidateTools: IndustryTool[]) =>
    isSubagentSession
      ? candidateTools.filter((t) => !SUBAGENT_FORBIDDEN_TOOL_IDS.has(t.id))
      : candidateTools;
  logInfo('[Tools] filterDecompTools called', {
    sessionId: getSessionService().getCurrentSessionId() ?? undefined,
    sessionTags: JSON.stringify(currentTags),
    decompSessionType,
    totalTools: tools.length,
  });
  if (decompSessionType === DecompSessionType.Orchestrator) {
    const filtered = tools.filter(
      (t) => !WORKER_TOOL_IDS.has(t.id) && t.id !== exitSpecModeTool.id
    );
    logInfo('[Tools] Orchestrator session - filtered tools', {
      filtered: filtered.length,
      orchestratorTools: filtered
        .filter((t) => ORCHESTRATOR_TOOL_IDS.has(t.id))
        .map((t) => t.id),
    });
    return filterSubagentTools(filtered);
  }
  if (decompSessionType === DecompSessionType.Worker) {
    return filterSubagentTools(
      tools.filter((t) => !WORKER_FORBIDDEN_TOOL_IDS.has(t.id))
    );
  }
  // Normal sessions: remove both orchestrator and worker tools
  const filtered = tools.filter(
    (t) => !ORCHESTRATOR_TOOL_IDS.has(t.id) && !WORKER_TOOL_IDS.has(t.id)
  );
  logInfo('[Tools] Normal session - removed mission tools', {
    filtered: filtered.length,
  });
  return filterSubagentTools(filtered);
}

// Helper function to extract result from generator
async function executeToolGenerator(
  generator: AsyncGenerator<DraftToolFeedback<unknown, unknown>, void, unknown>,
  onUpdate?: (update: unknown) => void,
  toolId?: string
): Promise<unknown> {
  let result: unknown;

  const truncateIfNeeded = (value: unknown): unknown => {
    if (typeof value !== 'string') {
      return value;
    }

    const threshold = toolId
      ? getOutputTruncationThresholdForTool(toolId)
      : DEFAULT_OUTPUT_TRUNCATION_THRESHOLD;

    return value.length > threshold ? truncateOutput(value, threshold) : value;
  };

  for await (const feedback of generator) {
    if (feedback.type === DraftToolFeedbackType.Update) {
      if (onUpdate) {
        onUpdate(feedback.value);
      }
      continue;
    }

    if (feedback.type === DraftToolFeedbackType.Result) {
      if (feedback.isError) {
        const truncatedLlmError = truncateIfNeeded(feedback.llmError);
        const truncatedUserError = truncateIfNeeded(feedback.userError);

        if (truncatedLlmError) {
          throw new MetaError(truncatedLlmError as string);
        }
        if (truncatedUserError) {
          throw new MetaError(truncatedUserError as string);
        }
        throw new MetaError('Tool execution failed');
      }
      result = feedback.value;
    }
  }

  if (result === undefined) {
    throw new MetaError('Tool execution completed without result');
  }

  return result;
}

function isToolEnabled(tool: IndustryTool): boolean {
  const modelId = getSessionService().getModel();
  const { enabled } = evaluateToolEnabled(tool, modelId);
  return enabled;
}

// Helper function to build dynamic tool mapping from registry
function buildToolMapping(): Record<string, string> {
  const registry = getTUIToolRegistry();
  const mapping: Record<string, string> = {};

  // Access registry directly to get all registered tools
  const tools: IndustryTool[] = Array.from(
    (
      registry as unknown as {
        registry: Map<string, ToolImplementation<CliClientToolDependencies>>;
      }
    ).registry.values()
  ).map((impl) => impl.tool);

  // Filter based on isToolEnabled / modelProvider
  const enabledTools = filterDecompTools(tools.filter(isToolEnabled));

  for (const tool of tools) {
    const llmId = tool.llmId || tool.id;
    if (enabledTools.includes(tool)) {
      mapping[llmId] = tool.id;
    }
  }

  return mapping;
}

async function enforceSandboxForHookModifiedInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<void> {
  const registry = getTUIToolRegistry();
  const toolDefinition =
    registry.getToolByLlmId(toolName) ?? registry.getTool(toolName);
  const violations = checkSandboxViolationsForTool(
    toolName,
    toolInput,
    toolDefinition,
    { cwd: process.cwd() }
  );
  if (violations.length === 0) return;

  const requestPermissionFn = context?.requestPermissionFn as
    | SandboxPermissionRequestFn
    | undefined;
  for (const violation of violations) {
    const result = await requestSandboxPermission(
      context?.toolCallId ?? `hook-modified-${toolName}`,
      toolName,
      toolInput,
      violation,
      requestPermissionFn
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
    throw new ToolExecutionControlError(denialMessage);
  }
}

// Generate tools definition from registry in LLM-agnostic format
export async function generateToolsFromRegistry(options?: {
  toolOverrides?: ToolOverrides;
}): Promise<LLMToolDescriptor[]> {
  const registry = getTUIToolRegistry();
  const toolOverrides = options?.toolOverrides;

  // Access registry directly to get all registered tools
  const tools = Array.from(
    (
      registry as unknown as {
        registry: Map<string, ToolImplementation<CliClientToolDependencies>>;
      }
    ).registry.values()
  ).map((impl) => impl.tool);

  const enabledTools = tools.filter(isToolEnabled);

  const allowed = getExecRuntimeConfig().getAllowedToolIds();
  let filteredTools = allowed
    ? enabledTools.filter((t) => allowed.has(t.id))
    : enabledTools;

  // Merge built-in skills (based on decomposition session type) with filesystem
  // skills. Exclude dynamically discovered skills when deciding whether to
  // expose the Skill tool; dynamic skills are announced through Read reminders.
  const validSkills = await getAllSkills({
    validOnly: true,
    excludeDynamic: true,
  });

  // Filter to only model-invocable skills (modelInvocable defaults to true if undefined)
  const modelInvocableSkills = getModelInvocableSkills(validSkills);

  Metrics.addToCounter(Metric.SKILL_LOADED_COUNT, modelInvocableSkills.length, {
    context: 'tool_registry',
  });

  // Emit customer metric for installed (non-builtin) skills per session
  const installedSkills = validSkills.filter(
    (s) => s.location !== SkillLocation.Builtin
  );
  for (const skill of installedSkills) {
    CustomerMetrics.addToCounter(MetricName.SKILL_INSTALLED, 1, {
      [AttributeName.SKILL_NAME]: sanitizeSkillName(skill.metadata.name),
      [AttributeName.SKILL_LOCATION]: skill.location,
    });
  }

  // Filter out Skill tool if no model-invocable skills are available
  if (modelInvocableSkills.length === 0) {
    filteredTools = filteredTools.filter((t) => t.id !== skillTool.id);
  }

  // Gate orchestrator/worker tools based on session type
  filteredTools = filterDecompTools(filteredTools);

  const includeCoAuthoredByDrool =
    getSettingsService().getIncludeCoAuthoredByDrool();

  const useParallelSearchApi = getFlag(
    IndustryFeatureFlags.UseParallelSearchApi
  );
  const useYouSearchApi = getFlag(IndustryFeatureFlags.UseYouSearchApi);
  let webSearchProvider: 'parallel' | 'you' | 'exa' = 'exa';
  let webSearchInputSchema: IndustryTool['inputSchema'] =
    exaWebSearchToolInputJsonSchema;
  if (useParallelSearchApi) {
    webSearchProvider = 'parallel';
    webSearchInputSchema = parallelWebSearchToolInputJsonSchema;
  } else if (useYouSearchApi) {
    webSearchProvider = 'you';
    webSearchInputSchema = youWebSearchToolInputJsonSchema;
  }

  return filteredTools.map((tool) => {
    // Build dynamic description for tools that need runtime values
    let { description } = tool;
    let inputSchema = tool.inputSchema;
    if (tool.id === skillTool.id && modelInvocableSkills.length > 0) {
      description = getStableSkillToolDescription();
    } else if (tool.id === executeCliTool.id) {
      description = getExecuteCliDescription({
        includeCoAuthoredByDrool,
        runtimeShell: getRuntimeShell().kind,
      });
    } else if (tool.id === webSearchTool.id) {
      description = getWebSearchDescription({
        provider: webSearchProvider,
      });
      inputSchema = webSearchInputSchema;
    }

    const name = tool.llmId || tool.id;
    const override = toolOverrides?.[name];
    return {
      spec: {
        name, // TODO(leo): Support overriding the tool name for experiments.
        description:
          typeof override?.description === 'string'
            ? override.description
            : description,
        input_schema: override?.input_schema ?? inputSchema,
      },
      ...(tool.deferred ? { deferred: true } : {}),
      sideEffects: tool.sideEffects,
    };
  });
}

// Execute tool based on name and input using TUI registry
export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResultContent> {
  const registry = getTUIToolRegistry();

  // Map LLM tool names to registry tool IDs (dynamically constructed)
  const toolMapping = buildToolMapping();
  const toolId = toolMapping[toolName];

  // Hard command rejection (blocked commands / hard denylist). Checked before
  // hooks, confirmation, and autonomy so blocked commands are rejected without
  // prompting; re-enforced inside the Execute executor after hook mutations.
  if (toolName === 'Execute' && typeof toolInput.command === 'string') {
    const blockedPattern = sessionConfigService.getBlockedCommandPattern(
      toolInput.command
    );
    if (blockedPattern) {
      // Single intentional breadcrumb + dedicated counter so blocklist hits are
      // distinguishable in audit telemetry from hook-denies and other tool
      // errors. No command/pattern content is recorded (CMEK policy).
      logInfo('[Tools] Execute command blocked by blocklist', {
        toolName,
      });
      CustomerMetrics.addToCounter(MetricName.COMMAND_BLOCKED, 1, {
        [AttributeName.TOOL_NAME]: toolName,
      });
      throw new ToolExecutionControlError(
        getI18n().t('common:toolExecution.blockedCommand', {
          pattern: blockedPattern,
        })
      );
    }
  }

  // Execute PreToolUse hooks
  let hookWarningMessage: string | undefined;
  let inputWasModifiedByHook = false;
  try {
    const currentMode = getSessionService().getCurrentAutonomyMode();
    const sessionId =
      context?.sessionId ||
      getSessionService().getCurrentSessionId() ||
      'unknown';
    const transcriptPath = getSessionService().getSessionTranscriptPath() || '';
    const hookResults = await executeHooksWithDisplay(
      HookEventName.PreToolUse,
      {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: process.cwd(),
        permission_mode: getPermissionModeString(currentMode),
        hook_event_name: HookEventName.PreToolUse,
        tool_name: toolName,
        tool_input: toolInput,
      },
      toolName,
      context
    );

    // Process hook results in priority order

    // 1. Check `continue` field first (highest priority - stops execution immediately)
    const stopResult = hookResults.find((r) => r.continue === false);
    if (stopResult) {
      const reason =
        stopResult.stopReason || 'Hook requested to stop execution';
      throw new HookStopError(reason);
    }

    // 2. Exit code 3: Abort agent entirely (highest priority for exit codes)
    const abortResult = hookResults.find((r) => r.exitCode === 3);
    logInfo('[Tools] Checking for exit code 3', {
      toolName,
      found: !!abortResult,
      exitCodes: hookResults.map((r) => r.exitCode),
    });
    if (abortResult) {
      const errorMsg = abortResult.stderr || 'Agent aborted by PreToolUse hook';
      logInfo('[Tools] Hook returned exit code 3, throwing AgentAbortError', {
        errorMessage: errorMsg,
        toolName,
        stderr: abortResult.stderr,
      });
      throw new AgentAbortError(errorMsg);
    }

    // 3. Check permissionDecision
    const permissionResult = hookResults.find(
      (r) => r.hookSpecificOutput?.permissionDecision
    );
    if (permissionResult?.hookSpecificOutput) {
      const { hookSpecificOutput } = permissionResult;
      // eslint-disable-next-line default-case -- Exhaustive switch for type safety
      switch (hookSpecificOutput.permissionDecision) {
        case 'allow': {
          // Auto-approve - bypass permission system
          // Apply updatedInput if provided
          if (hookSpecificOutput.updatedInput) {
            // eslint-disable-next-line no-param-reassign
            toolInput = { ...toolInput, ...hookSpecificOutput.updatedInput };
            inputWasModifiedByHook = true;
            logInfo(
              '[Hooks] Tool input modified by hook (permission decision)'
            );
            // Notify context that input was modified
            if (context?.onInputModified) {
              context.onInputModified(toolInput);
            }
          }
          // Log reason to user but don't show to drool
          if (hookSpecificOutput.permissionDecisionReason) {
            logInfo('[Hooks] Tool auto-approved', {
              reason: hookSpecificOutput.permissionDecisionReason,
            });
          }
          // Continue with tool execution (no throw)
          break;
        }
        case 'deny': {
          // Block tool execution, show reason to drool
          const denyReason =
            hookSpecificOutput.permissionDecisionReason ||
            'Tool execution denied by hook';
          throw new ToolExecutionControlError(denyReason);
        }
        case 'ask':
          // Prompt user for confirmation
          // For now, log and let normal permission flow handle it
          logInfo('[Hooks] Hook requested user confirmation', {
            reason: hookSpecificOutput.permissionDecisionReason,
          });
          break;
        // No default case - exhaustive check ensures all cases are handled
        // TypeScript will error if a new permissionDecision value is added
      }
    }

    // 5. Exit code 2: Block tool execution
    const blockingResult = hookResults.find((r) => r.exitCode === 2);
    logInfo('[Tools] Checking for exit code 2', {
      toolName,
      found: !!blockingResult,
      exitCodes: hookResults.map((r) => r.exitCode),
    });
    if (blockingResult) {
      const errorMsg =
        blockingResult.stderr || 'Tool execution blocked by hook';
      logInfo(
        '[Tools] Hook returned exit code 2, throwing ToolExecutionControlError',
        {
          errorMessage: errorMsg,
          toolName,
          stderr: blockingResult.stderr,
        }
      );
      throw new ToolExecutionControlError(errorMsg);
    }

    // 6. Apply updatedInput if provided and not already applied
    const updateInputResult = hookResults.find(
      (r) => r.hookSpecificOutput?.updatedInput
    );
    if (
      updateInputResult?.hookSpecificOutput?.updatedInput &&
      !permissionResult?.hookSpecificOutput?.updatedInput
    ) {
      // eslint-disable-next-line no-param-reassign
      toolInput = {
        ...toolInput,
        ...updateInputResult.hookSpecificOutput.updatedInput,
      };
      inputWasModifiedByHook = true;
      logInfo('[Hooks] Tool input modified by hook (updated input result)');
      // Notify context that input was modified
      if (context?.onInputModified) {
        context.onInputModified(toolInput);
      }
    }

    // 7. Display systemMessage if provided
    const systemMsgResult = hookResults.find((r) => r.systemMessage);
    if (systemMsgResult) {
      logInfo('[Hooks] System message', {
        message: systemMsgResult.systemMessage,
      });
    }

    // 8. Exit code 1: Non-blocking error, show to user but continue
    const errorResult = hookResults.find((r) => r.exitCode === 1);
    if (errorResult && errorResult.stderr) {
      logInfo('[Hooks] PreToolUse warning', { stderr: errorResult.stderr });
      // Store the warning to prepend to tool result
      hookWarningMessage = errorResult.stderr;
    }

    if (inputWasModifiedByHook) {
      await enforceSandboxForHookModifiedInput(toolName, toolInput, context);
    }
  } catch (error) {
    // Re-throw tool execution control errors by checking error.name property
    // Using error.name is more reliable than instanceof for bundled code
    if (error instanceof Error) {
      const errorName = error.name;
      if (
        errorName === 'ToolExecutionControlError' ||
        errorName === 'HookExecutionError' ||
        errorName === 'HookStopError' ||
        errorName === 'AgentAbortError' ||
        errorName === 'ToolAbortError'
      ) {
        throw error;
      }
    }
    // Log unexpected errors but don't block tool execution
    logException(
      error,
      '[Tools] Unexpected error in hook execution - continuing with tool'
    );
  }

  if (context?.abortSignal?.aborted) {
    throw new ToolAbortError();
  }

  // Check if in exec mode
  const allowedExecTools = getExecRuntimeConfig().getAllowedToolIds();

  if (allowedExecTools && (!toolId || !allowedExecTools.has(toolId))) {
    return `Error: Tool not permitted in exec mode: ${toolName}`;
  }

  if (!toolId) {
    // Handle non-TUI tools that aren't in registry
    if (toolName === 'getIdeDiagnostics') {
      if (!context?.ideClient) {
        return 'Error: IDE Extension is not connected';
      }

      // Guard against stale IDE clients whose MCP transport has dropped
      // (FAC-18854). Without this guard, every subsequent tool call would
      // throw "MCP client not connected" and spam warn logs.
      if (!context.ideClient.isConnected()) {
        return 'Error: IDE Extension is not connected';
      }

      const uri = toolInput.uri as string;
      if (!uri) {
        return 'Error: uri parameter is required';
      }

      try {
        const result = await context.ideClient.callTool('getIdeDiagnostics', {
          uri,
        });
        return result;
      } catch (error) {
        return `Error getting diagnostics: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    }

    return `Unknown tool: ${toolName}`;
  }

  // Get the executor from registry
  const executor = registry.getExecutor(toolId);
  if (!executor) {
    return `Tool not registered: ${toolName}`;
  }

  // Prepare dependencies
  const sessionService = getSessionService();
  const settingsService = getSettingsService();
  // Use provided abort signal or create a "never abort" fallback
  const abortSignal = context?.abortSignal ?? new AbortController().signal;

  // Build topLevelModel from session settings so tools like Task can inherit the parent model.
  // Use sessionService (not settingsService) to respect --model overrides from CLI args,
  // e.g. when mission workers are spawned with a specific model via --model.
  const currentModelId = sessionService.getModel();
  const currentReasoningEffort = sessionService.getReasoningEffort();
  const modelConfig = getTuiModelConfig(currentModelId);
  const topLevelModel = {
    id: currentModelId as ModelID,
    reasoningEffort: currentReasoningEffort,
    modelProvider: modelConfig.modelProvider,
  } satisfies Pick<LLMModel, 'id' | 'modelProvider' | 'reasoningEffort'>;

  // Note: CLI doesn't have all the dependencies that web has (sessionAgentConfig, etc.)
  // so we use a type assertion here. The core fields needed for CLI tool execution are provided.
  const dependencies: CliClientToolDependencies = {
    sessionId:
      context?.sessionId || sessionService.getCurrentSessionId() || 'unknown',
    workingDirectoryFullPath: process.cwd(),
    ideClient: context?.ideClient,
    abortSignal,
    topLevelModel,
    // @ts-expect-error - userId is not on the type; CLI is not finalized
    userId: 'unknown',
    isRemoteWorkspaceConnected: () => false,
    toolMessageId: 'unknown',
    toolCallId: context?.toolCallId || 'unknown', // Use toolCallId from context for process tracking
    repositoriesInContext: [],
    // In TUI/exec mode, get droolShieldEnabled from local settings
    droolShieldEnabled: settingsService.getEnableDroolShield(),
    // Pass user's confirmation decision for tools requiring confirmation
    confirmationOutcome: context?.confirmationOutcome,
    exitSpecModeComment: context?.exitSpecModeComment,
    editedSpecContent: context?.editedSpecContent,
    missionProposalComment: context?.missionProposalComment,
    requestPermissionFn: context?.requestPermissionFn,
  };

  // Execute the tool
  const generator = executor.execute(dependencies, toolInput);
  let result = await executeToolGenerator(
    generator,
    context?.onToolUpdate,
    toolId
  );

  // Prepend hook warning to result if present
  if (hookWarningMessage) {
    if (typeof result === 'string') {
      result = `${hookWarningMessage}\n\n${result}`;
    } else if (
      Array.isArray(result) &&
      result.length > 0 &&
      result[0].type === 'text'
    ) {
      result[0] = {
        ...result[0],
        text: `${hookWarningMessage}\n\n${result[0].text}`,
      };
    }
  }

  // Check if result is already Anthropic-compatible content blocks
  if (Array.isArray(result) && result.length > 0) {
    const isContentBlocks = result.every(
      (item) =>
        typeof item === 'object' &&
        'type' in item &&
        (item.type === 'text' ||
          (item.type === 'image' && 'source' in item) ||
          (item.type === 'document' && 'source' in item))
    );
    if (isContentBlocks) {
      return result satisfies ToolResultContent;
    }
  }

  // Backward compatible: stringify non-structured results
  if (typeof result === 'string') {
    const processed = await handleLargeStringOutput(result, {
      toolId: toolId || toolName,
      toolCallId: context?.toolCallId || 'unknown',
    });
    return processed as string;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
