import fs from 'fs';
import os from 'os';
import path from 'path';

import { DaemonSpecificNotificationType } from '@industry/common/daemon';
import {
  SESSION_TAG_SUBAGENT,
  ToolExecutionErrorType,
} from '@industry/common/session';
import { SubagentAutonomyLevel } from '@industry/common/settings';
import { MultiSessionStateManager } from '@industry/daemon-client';
import { askUserTool } from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import {
  AgentTurnCompletionReason,
  SessionNotificationType,
  type ToolStreamingUpdate,
} from '@industry/drool-sdk-ext/protocol/drool';
import { type SessionTag } from '@industry/drool-sdk-ext/protocol/session';
import {
  MessageContentBlockType,
  MessageRole,
} from '@industry/drool-sdk-ext/protocol/sessionV2';
import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException, logWarn, Metrics } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';
import { SettingsManager } from '@industry/runtime/settings';
import { clampAutonomyLevelToMax } from '@industry/utils/autonomy';
import { getIndustryDirName } from '@industry/utils/environment';
import { buildSubagentSessionTitle } from '@industry/utils/session';

import { executeCustomCommand } from '@/commands/custom/executeCustomCommand';
import { parseCommandText } from '@/commands/parseCommandText';
import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { getAllowedModelIds } from '@/models/availability';
import { backgroundTaskManager } from '@/services/BackgroundTaskManager';
import {
  getCompletionReasonFromFinalOutput,
  isProcessExitNotification,
} from '@/services/daemon/processExitNotifications';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import {
  getBuiltInDroolConfigs,
  getBuiltInDroolConfig,
  builtInDroolConfigToCustomDrool,
} from '@/services/drools/BuiltInDroolConfigs';
import { getDroolLoaderSingleton } from '@/services/drools/CustomDroolRegistry';
import { DroolValidator } from '@/services/drools/DroolValidator';
import { getExecRuntimeConfig } from '@/services/ExecRuntimeConfigService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { SubagentStreamProcessor } from '@/tools/executors/client/utils/SubagentStreamProcessor';
import type {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import { TaskInvocationStatus } from '@/utils/enums';
import {
  forgetSessionBackedTaskStartTime,
  rememberSessionBackedTaskStartTime,
} from '@/utils/sessionBackedTaskState';
import { readSessionFinalTextFromState } from '@/utils/sessionStateProgress';
import {
  getTaskInvocation,
  isResumableTaskInvocationStatus,
  updateTaskInvocationStatus,
  upsertTaskInvocation,
} from '@/utils/taskInvocationStore';
import { generateUUID } from '@/utils/uuid';

import type { CustomCommand, DroolModel } from '@industry/common/settings';
import type { ComplexityTier } from '@industry/drool-core/tools/enums';
import type { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

interface TaskToolParams {
  subagent_type: string;
  description?: string;
  prompt: string;
  complexity?: ComplexityTier;
  run_in_background?: boolean;
  resume?: string;
}

// Returned to the parent agent when a subagent finishes successfully but
// produces no textual output. Handing back an empty string can cause the
// parent model to spiral on zero information, so always surface something
// that points at the full transcript for follow-up.
function foregroundEmptyResultFallback(sessionId: string): string {
  return (
    'The subagent session completed but did not return any output. ' +
    `To investigate, inspect the session transcript file ${sessionId}.jsonl ` +
    `under ${getIndustryDirName()}/sessions.`
  );
}

const FOREGROUND_FINAL_TEXT_MAX_ATTEMPTS = 10;
const FOREGROUND_FINAL_TEXT_RETRY_DELAY_MS = 200;

interface BuildArgsResult {
  args: string[];
  promptFile?: string;
  subagentSource?: 'built_in' | 'custom';
}

interface PromptResolutionResult {
  prompt?: string;
  llmError?: string;
  userError?: string;
  errorType?: ToolExecutionErrorType;
}

interface StreamJsonRpcTaskConfig {
  sessionId: string;
  prompt: string;
  systemPromptOverride?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  enabledToolIds?: string[];
  disabledToolIds?: string[];
  tags: SessionTag[];
  title?: string;
  parentIsInSpecMode: boolean;
  parentAutonomyLevel: AutonomyLevel;
  isResume: boolean;
  cwd: string;
  subagentSource: 'built_in' | 'custom';
}

// Prompts longer than this (in bytes) are written to a temp file instead of
// passed as inline CLI arguments.  The Windows CreateProcess API has a ~32 767
// character command-line limit, but libuv applies a stricter per-argument
// check that surfaces as ENAMETOOLONG well before that ceiling.  macOS caps
// the total argv + envp at ~1 MB.  4 KB is a conservative threshold that
// leaves headroom for other args and environment variables on all platforms.
const PROMPT_FILE_THRESHOLD_BYTES = 4 * 1024;
// Fallback activity-silence watchdog for foreground subagents, mirroring the
// legacy SubagentStreamProcessor stdout-silence watchdog. Used only when no
// configured subagent inactivity timeout is available.
const FOREGROUND_SUBAGENT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const NESTED_DISALLOWED_TOOL_IDS = new Set(['Task']);
const SPEC_MODE_MUTATION_TOOL_IDS = new Set(['Create', 'Edit', 'ApplyPatch']);
const SUBAGENT_DISABLED_TOOL_IDS = [askUserTool.id];

function isGitRepo(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, '.git'));
}

function buildSubagentSystemPrompt(
  droolSystemPrompt: string,
  parentIsInSpecMode: boolean
): string {
  return [
    droolSystemPrompt.trim(),
    '',
    'Notes:',
    '- You are a specialized subagent invoked by another agent within an ongoing Industry session.',
    '- Complete only what is explicitly requested. Stop immediately once the task is done.',
    '- Stay strictly within scope. Do not add features, investigations, or commentary beyond the task.',
    '- If something is unclear or blocked, report it instead of guessing or expanding scope.',
    '- Use absolute file paths when sharing paths relevant to the task.',
    '- In your final response, summarize the concrete actions you took and their outcomes.',
    '- If you wrote output to any files, clearly list every file path so the caller can retrieve them.',
    '- Provide key outputs or findings relevant to the task, nothing more.',
    '- Avoid using emojis.',
    '- Do NOT write report/summary/findings/analysis markdown files. Return findings directly as your final assistant message.',
    ...(parentIsInSpecMode
      ? [
          '- The parent session is in Spec Mode. Your toolset is restricted to read-only operations and low-risk shell commands.',
          '- File edits, file creation, and further subagent spawning are disabled. Focus on analysis and concrete findings.',
        ]
      : []),
    '',
    'Environment:',
    '<env>',
    `Working directory: ${process.cwd()}`,
    `Is directory a git repo: ${isGitRepo(process.cwd()) ? 'Yes' : 'No'}`,
    `Platform: ${process.platform}`,
    `Shell: ${process.env.SHELL ?? 'unknown'}`,
    `OS Version: ${os.type()} ${os.release()}`,
    '</env>',
  ].join('\n');
}

function buildTaskInvocationPrompt({
  subagentType,
  complexity,
  description,
  prompt,
  parentIsInSpecMode,
  includeSubagentIdentity,
  droolSystemPrompt,
}: {
  subagentType: string;
  complexity?: ComplexityTier;
  description?: string;
  prompt: string;
  parentIsInSpecMode: boolean;
  includeSubagentIdentity: boolean;
  droolSystemPrompt: string;
}): string {
  return [
    '# Task Tool Invocation',
    '',
    `Subagent type: ${subagentType}`,
    ...(complexity ? [`Task complexity: ${complexity}`] : []),
    ...(description ? [`Task description: ${description}`, ''] : ['']),
    '## Context',
    'You are a specialized subagent invoked by another agent within an ongoing Industry session.',
    'You operate in your own context window but your work directly supports the parent workflow.',
    ...(parentIsInSpecMode
      ? [
          '',
          'The parent session is in Spec Mode (planning and research, not code changes).',
          'Your toolset is restricted to read-only operations and low-risk shell commands -',
          'file edits, creations, and further subagent spawning are disabled.',
          'Focus on information gathering, analysis, and returning concrete findings to the parent.',
        ]
      : []),
    ...(includeSubagentIdentity
      ? [
          '',
          '## Your Subagent Identity',
          'Your core identity and specialized capabilities are defined by the following system prompt:',
          '',
          '---BEGIN SUBAGENT SYSTEM PROMPT---',
          droolSystemPrompt,
          '---END SUBAGENT SYSTEM PROMPT---',
          '',
          '## Mission',
          'Follow the instructions from your subagent system prompt and the task below.',
          'Complete only what is explicitly requested. Stop immediately once the task is done.',
          '',
          '## Non-negotiable rules',
          '- Stay strictly within scope. Do not add features, investigations, or commentary beyond the task.',
          '- Do not pursue tangents or make proactive suggestions outside the described work.',
          '- If something is unclear or blocked, report it instead of guessing or expanding scope.',
          '- **NEVER** run destructive `rm -rf` commands (e.g. `rm -rf /`, `rm -rf ~`). Commands targeting only `/tmp` are allowed.',
        ]
      : []),
    '',
    '## Task',
    'Execute the following assignment precisely and efficiently. Do not perform any other work.',
    '',
    '---BEGIN TASK FROM PARENT AGENT---',
    prompt,
    '---END TASK FROM PARENT AGENT---',
    ...(includeSubagentIdentity
      ? [
          '',
          '## Reporting requirements',
          '- Summarize the concrete actions you took and their outcomes.',
          '- If you wrote output to any files, clearly list every file path so the caller can retrieve them.',
          '- Note any blockers, uncertainties, or required follow-ups.',
          '- Provide key outputs or findings relevant to the task, nothing more.',
        ]
      : []),
  ].join('\n');
}

function withSubagentCallingMetadata({
  tags,
  callingSessionId,
  callingToolUseId,
}: {
  tags: SessionTag[];
  callingSessionId: string;
  callingToolUseId: string;
}): SessionTag[] {
  let foundSubagentTag = false;
  const nextTags = tags.map((tag) => {
    if (tag.name !== SESSION_TAG_SUBAGENT) {
      return tag;
    }

    foundSubagentTag = true;
    return {
      ...tag,
      metadata: {
        ...(tag.metadata ?? {}),
        callingSessionId,
        callingToolUseId,
      },
    };
  });

  if (foundSubagentTag) {
    return nextTags;
  }

  return [
    ...nextTags,
    {
      name: SESSION_TAG_SUBAGENT,
      metadata: { callingSessionId, callingToolUseId },
    },
  ];
}

/**
 * Write a prompt to a temporary file to avoid OS command-line length limits.
 * The file is created with restricted permissions (0o600) inside a
 * user-only directory (0o700) because prompts may contain sensitive context.
 */
function writePromptFile(prompt: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drool-subagent-'));
  fs.chmodSync(tmpDir, 0o700);
  const promptPath = path.join(tmpDir, 'prompt.md');
  fs.writeFileSync(promptPath, prompt, { encoding: 'utf-8', mode: 0o600 });
  return promptPath;
}

function cleanupPromptFile(promptFile: string | undefined): void {
  if (!promptFile) return;
  try {
    fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the OS will reclaim temp files eventually.
  }
}

/**
 * Decide the final result of a foreground subagent turn once its terminal
 * signal and final text are both known.
 *
 * Returns recovered output (guaranteed non-empty) for successful and
 * output-bearing terminations, or throws the appropriate terminal error.
 * `ProcessExit`/`Error` prefer any recovered output over failing, so a child
 * that finished before its process exited is not reported as an abort.
 */
function resolveForegroundSubagentOutcome({
  reason,
  finalText,
  sessionId,
  notificationType,
}: {
  reason: AgentTurnCompletionReason | undefined;
  finalText: string;
  sessionId: string;
  notificationType?: SessionNotificationType;
}): string {
  const trimmed = finalText.trim();
  const isErrorMarker =
    trimmed.length > 0 &&
    getCompletionReasonFromFinalOutput(trimmed) ===
      AgentTurnCompletionReason.Error;

  switch (reason) {
    case AgentTurnCompletionReason.Cancelled:
      throw new ToolAbortError();
    case AgentTurnCompletionReason.PermissionRejected:
      throw new MetaError(
        'Subagent session ended early: required tool permission was rejected',
        {
          sessionId,
          ...(notificationType ? { notificationType } : {}),
          reason,
        }
      );
    case AgentTurnCompletionReason.ProcessExit:
      if (trimmed && !isErrorMarker) {
        return finalText;
      }
      throw new MetaError(
        'Subagent process exited before producing any output',
        {
          sessionId,
          ...(notificationType ? { notificationType } : {}),
          reason,
        }
      );
    case AgentTurnCompletionReason.Error:
      if (trimmed && !isErrorMarker) {
        return finalText;
      }
      throw new MetaError('Subagent session reported an error', {
        sessionId,
        ...(notificationType ? { notificationType } : {}),
        reason,
      });
    default:
      if (isErrorMarker) {
        throw new MetaError('Subagent session reported an error', {
          sessionId,
          ...(notificationType ? { notificationType } : {}),
        });
      }
      return trimmed ? finalText : foregroundEmptyResultFallback(sessionId);
  }
}

/**
 * Return either inline args or --file args depending on prompt size.
 * Small prompts are passed directly as a positional argument to avoid the
 * temp-file overhead; large ones go through a file to stay within OS limits.
 */
function buildPromptArgs(prompt: string): {
  args: string[];
  promptFile?: string;
} {
  if (Buffer.byteLength(prompt, 'utf-8') > PROMPT_FILE_THRESHOLD_BYTES) {
    const promptFile = writePromptFile(prompt);
    return { args: ['--file', promptFile], promptFile };
  }
  return { args: [prompt] };
}

export class TaskCliExecutor
  implements
    ClientToolExecutor<
      CliClientSpecificToolDependencies,
      string | ToolStreamingUpdate,
      ToolStreamingUpdate
    >
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: TaskToolParams
  ): AsyncGenerator<
    DraftToolFeedback<string | ToolStreamingUpdate, ToolStreamingUpdate>
  > {
    const { prompt, subagent_type: subagentType } = parameters;

    if (!subagentType || typeof subagentType !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'subagent_type is required and must be a string',
        userError: 'Invalid subagent type provided',
      };
      return;
    }
    if (!prompt || typeof prompt !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'prompt is required and must be a string',
        userError: 'Invalid prompt provided',
      };
      return;
    }

    try {
      if (dependencies.abortSignal?.aborted) {
        throw new ToolAbortError();
      }

      const resolvedPromptResult = await TaskCliExecutor.resolvePrompt(prompt);
      if (!resolvedPromptResult.prompt) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType:
            resolvedPromptResult.errorType ??
            ToolExecutionErrorType.ToolInternalError,
          llmError:
            resolvedPromptResult.llmError ?? 'Failed to resolve task prompt',
          userError:
            resolvedPromptResult.userError ?? 'Failed to resolve task prompt',
        };
        return;
      }

      const resolvedParameters: TaskToolParams = {
        ...parameters,
        prompt: resolvedPromptResult.prompt,
      };
      const isV2 = getExecRuntimeConfig().isSubAgentsV2Enabled();

      if (isV2) {
        const streamConfig = await TaskCliExecutor.buildStreamJsonRpcTaskConfig(
          resolvedParameters,
          dependencies
        );
        if (!streamConfig) {
          const availableSubagents =
            await TaskCliExecutor.listAvailableSubagents();
          const availableNames = availableSubagents.length
            ? availableSubagents.join(', ')
            : 'none';
          yield {
            type: DraftToolFeedbackType.Result,
            isError: true,
            errorType: ToolExecutionErrorType.ToolInternalError,
            llmError: `Drool configuration not found for subagent: ${subagentType}. Available subagents: ${availableNames}`,
            userError: `Drool "${subagentType}" not found. Available subagents: ${availableNames}.`,
          };
          return;
        }

        Metrics.addToCounter(Metric.CUSTOM_DROOL_INVOKED_COUNT, 1, {
          source: streamConfig.subagentSource,
          complexityTier: resolvedParameters.complexity ?? 'default',
        });

        yield* this.runViaStreamJsonRpc({
          config: streamConfig,
          parameters: resolvedParameters,
          dependencies,
        });
        return;
      }

      const result = await TaskCliExecutor.buildCommandArgs(
        resolvedParameters,
        dependencies
      );

      if (!result) {
        const availableSubagents =
          await TaskCliExecutor.listAvailableSubagents();
        const availableNames = availableSubagents.length
          ? availableSubagents.join(', ')
          : 'none';
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          llmError: `Drool configuration not found for subagent: ${subagentType}. Available subagents: ${availableNames}`,
          userError: `Drool "${subagentType}" not found. Available subagents: ${availableNames}.`,
        };
        return;
      }

      const { args, promptFile } = result;

      Metrics.addToCounter(Metric.CUSTOM_DROOL_INVOKED_COUNT, 1, {
        source: result.subagentSource ?? 'custom',
        complexityTier: resolvedParameters.complexity ?? 'default',
      });

      try {
        // Background mode (v2 only): child process is detached so we must
        // not delete the prompt file before it reads it.
        if (isV2 && resolvedParameters.run_in_background === true) {
          yield* this.launchBackground(args, resolvedParameters, dependencies);
          return;
        }

        // Stream updates from the subagent (foreground, existing behavior)
        const processor = new SubagentStreamProcessor();
        yield* processor.process(args, {
          abortSignal: dependencies.abortSignal,
          toolCallId: dependencies.toolCallId,
        });
      } finally {
        if (!(isV2 && resolvedParameters.run_in_background === true)) {
          cleanupPromptFile(promptFile);
        }
      }
    } catch (error) {
      if (error instanceof ToolAbortError) {
        throw error;
      }

      const errorObject =
        error instanceof Error ? error : new Error(String(error));
      const errorMessage = errorObject.message || 'Unknown error';

      logException(errorObject, 'TaskCliExecutor.execute');

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Error running task subagent: ${errorMessage}`,
        userError: `Failed to run task: ${errorMessage}`,
      };
    }
  }

  private async *runViaStreamJsonRpc({
    config,
    parameters,
    dependencies,
  }: {
    config: StreamJsonRpcTaskConfig;
    parameters: TaskToolParams;
    dependencies: CliClientToolDependencies;
  }): AsyncGenerator<
    DraftToolFeedback<string | ToolStreamingUpdate, ToolStreamingUpdate>
  > {
    const adapter = getTuiDaemonAdapter();
    const parentSessionId =
      dependencies.sessionId ?? getSessionService().getCurrentSessionId();
    const toolCallId = dependencies.toolCallId;

    if (!parentSessionId || !toolCallId) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: 'No active session found for Task execution',
        userError: 'No active session to launch Task from',
      };
      return;
    }

    const storedInvocation = config.isResume
      ? undefined
      : getTaskInvocation({
          parentSessionId,
          parentToolUseId: toolCallId,
        });
    const storedInvocationMatchesInput =
      storedInvocation?.subagentType === parameters.subagent_type &&
      storedInvocation?.description === parameters.description &&
      storedInvocation?.runInBackground ===
        (parameters.run_in_background === true);
    // Re-attach to the persisted child only while the invocation is still in
    // flight (Pending/Running) — e.g. an inactivity-timeout force-kill that
    // left the status Running. Terminal invocations (Completed/Failed/
    // Cancelled) are never re-attached: a completed result is already
    // delivered, and a failed or user-cancelled subagent must not be silently
    // restarted. Shares the predicate with the coordinator recovery path.
    const existingInvocation =
      storedInvocationMatchesInput &&
      isResumableTaskInvocationStatus(storedInvocation.status)
        ? storedInvocation
        : undefined;
    const childSessionId =
      existingInvocation?.childSessionId ?? config.sessionId;
    const shouldStartChild = !config.isResume && !existingInvocation;

    if (config.isResume || existingInvocation) {
      await adapter.loadSession(childSessionId);
    } else {
      await upsertTaskInvocation({
        parentSessionId,
        parentToolUseId: toolCallId,
        childSessionId,
        runInBackground: parameters.run_in_background === true,
        status: TaskInvocationStatus.Pending,
        subagentType: parameters.subagent_type,
        description: parameters.description,
        cwd: config.cwd,
      });
      await adapter.initializeSubagentSession({
        sessionId: childSessionId,
        cwd: config.cwd,
        modelId: config.modelId,
        reasoningEffort: config.reasoningEffort,
        systemPromptOverride: config.systemPromptOverride,
        interactionMode: config.parentIsInSpecMode
          ? DroolInteractionMode.Spec
          : DroolInteractionMode.Auto,
        autonomyLevel: config.parentAutonomyLevel,
        enabledToolIds: config.parentIsInSpecMode
          ? undefined
          : config.enabledToolIds,
        disabledToolIds: config.disabledToolIds,
        tags: withSubagentCallingMetadata({
          tags: config.tags,
          callingSessionId: parentSessionId,
          callingToolUseId: toolCallId,
        }),
        title: config.title,
      });
      await updateTaskInvocationStatus({
        childSessionId,
        status: TaskInvocationStatus.Running,
      });
    }

    agentEventBus.emit(AgentEvent.ChildSessionAvailable, {
      parentSessionId,
      childSessionId,
      toolUseId: toolCallId,
    });

    if (parameters.run_in_background === true) {
      const startTime = Date.now();
      rememberSessionBackedTaskStartTime({
        taskId: childSessionId,
        startTime,
      });

      if (shouldStartChild || config.isResume) {
        void adapter
          .addUserMessage({
            sessionId: childSessionId,
            text: config.prompt,
          })
          .catch((error) => {
            void updateTaskInvocationStatus({
              childSessionId,
              status: TaskInvocationStatus.Failed,
            });
            logWarn('[TaskCliExecutor] Failed to start background subagent', {
              taskId: childSessionId,
              baseSessionId: parentSessionId,
              cause: error,
            });
            void TaskCliExecutor.markBackgroundLaunchFailed({
              adapter,
              sessionId: childSessionId,
              error,
            });
          });
      }

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: TaskCliExecutor.buildBackgroundResponse(
          childSessionId,
          parameters
        ),
      };
      return;
    }

    let finalText = '';
    try {
      finalText = await TaskCliExecutor.runForegroundStreamJsonRpcTask({
        adapter,
        sessionId: childSessionId,
        prompt: config.prompt,
        abortSignal: dependencies.abortSignal,
        sendPrompt: shouldStartChild || config.isResume,
      });
      await updateTaskInvocationStatus({
        childSessionId,
        status: TaskInvocationStatus.Completed,
      });
    } catch (error) {
      await updateTaskInvocationStatus({
        childSessionId,
        status:
          error instanceof ToolAbortError
            ? TaskInvocationStatus.Cancelled
            : TaskInvocationStatus.Failed,
      });
      throw error;
    }
    getSessionService().applyChildInclusiveTokenUsageFromSession(
      childSessionId,
      parentSessionId
    );

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: `session_id: ${childSessionId}\n${finalText.trim()}`,
    };
  }

  private static buildBackgroundResponse(
    sessionId: string,
    parameters: TaskToolParams
  ): string {
    const responseLines = [
      'Task launched in background.',
      `task_id: ${sessionId}`,
      `session_id: ${sessionId}`,
      `subagent_type: ${parameters.subagent_type}`,
    ];

    if (parameters.description) {
      responseLines.push(`description: ${parameters.description}`);
    }

    responseLines.push(
      'The task is running in a subagent session.',
      `To inspect progress, open/load session "${sessionId}".`,
      `To check progress: use TaskOutput with task_id "${sessionId}" and block=false`,
      `To resume later with follow-up: use Task with resume="${sessionId}"`
    );

    return responseLines.join('\n');
  }

  private static getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static async markBackgroundLaunchFailed({
    adapter,
    sessionId,
    error,
  }: {
    adapter: ReturnType<typeof getTuiDaemonAdapter>;
    sessionId: string;
    error: unknown;
  }): Promise<void> {
    const errorMessage = TaskCliExecutor.getErrorMessage(error);
    const failureOutput = `Failed to start background task: ${errorMessage}`;
    const sessionManager = adapter
      .getSessionStateManager?.()
      ?.getSessionManager(sessionId);

    try {
      sessionManager
        ?.getStore()
        .setAgentTurnCompletionReason(AgentTurnCompletionReason.Error);
      sessionManager?.getStore().addUpdate?.({
        toolUseId: sessionId,
        update: {
          type: 'error',
          text: 'Failed to start background task',
          error: errorMessage,
          details: failureOutput,
          subagentSessionId: sessionId,
          timestamp: Date.now(),
        },
      });
      sessionManager?.upsertMessage?.({
        id: generateUUID(),
        role: MessageRole.Assistant,
        content: [
          {
            type: MessageContentBlockType.Text,
            text: failureOutput,
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      sessionManager?.stopStreaming?.();
    } catch (stateError) {
      logWarn('[TaskCliExecutor] Failed to record background launch failure', {
        sessionId,
        cause: stateError,
      });
    }

    try {
      await adapter.closeSession(sessionId, { retainState: true });
    } catch (closeError) {
      logWarn(
        '[TaskCliExecutor] Failed to close failed background subagent session',
        {
          sessionId,
          cause: closeError,
        }
      );
    } finally {
      forgetSessionBackedTaskStartTime(sessionId);
    }
  }

  private static async runForegroundStreamJsonRpcTask(params: {
    adapter: ReturnType<typeof getTuiDaemonAdapter>;
    sessionId: string;
    prompt: string;
    abortSignal?: AbortSignal;
    sendPrompt?: boolean;
  }): Promise<string> {
    const {
      adapter,
      sessionId,
      prompt,
      abortSignal,
      sendPrompt = true,
    } = params;

    let completed = false;
    let abortListener: (() => void) | null = null;
    let parentAbortListener: (() => void) | null = null;
    let interruptPromise: Promise<void> | null = null;
    let closePromise: Promise<void> | null = null;
    let unsubscribe: () => void = () => {};
    const childAbortController = new AbortController();
    const sessionStateManager = adapter.getSessionStateManager?.();
    const interruptSubagent = (): Promise<void> => {
      if (!interruptPromise) {
        interruptPromise = adapter
          .interruptSession(sessionId)
          .catch((error) => {
            logWarn(
              '[TaskCliExecutor] Failed to interrupt foreground subagent',
              {
                sessionId,
                cause: error,
              }
            );
          });
      }

      return interruptPromise;
    };
    const closeSubagent = (): Promise<void> => {
      if (!closePromise) {
        closePromise = adapter.closeSession(sessionId).catch((error) => {
          logWarn('[TaskCliExecutor] Failed to close foreground subagent', {
            sessionId,
            cause: error,
          });
        });
      }

      return closePromise;
    };

    if (!sendPrompt) {
      const existingFinalText = TaskCliExecutor.readForegroundFinalText({
        sessionId,
        sessionStateManager,
      });
      if (existingFinalText.trim()) {
        // The cached result is final: release the child session loaded for
        // reattach and its start time, mirroring the cleanup in `finally`.
        await closeSubagent();
        forgetSessionBackedTaskStartTime(sessionId);
        // Classify the cached text so an errored/rejected/cancelled child is
        // surfaced as a failure rather than reported back as success.
        return resolveForegroundSubagentOutcome({
          reason: getCompletionReasonFromFinalOutput(existingFinalText),
          finalText: existingFinalText,
          sessionId,
        });
      }
    }

    const inactivityTimeoutMs =
      getSettingsService().getSubagentInactivityTimeout() ??
      FOREGROUND_SUBAGENT_INACTIVITY_TIMEOUT_MS;
    let timedOut = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let rejectCompletion: ((error: Error) => void) | null = null;
    const clearInactivityTimer = (): void => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    };
    const onInactivityTimeout = (): void => {
      if (completed || timedOut) {
        return;
      }
      timedOut = true;
      logWarn('[TaskCliExecutor] Foreground subagent inactivity timeout', {
        sessionId,
        timeout: inactivityTimeoutMs,
      });
      void interruptSubagent();
      rejectCompletion?.(
        new MetaError('Subagent session timed out due to inactivity', {
          sessionId,
          timeout: inactivityTimeoutMs,
        })
      );
    };
    const resetInactivityTimer = (): void => {
      if (completed || timedOut) {
        return;
      }
      clearInactivityTimer();
      inactivityTimer = setTimeout(onInactivityTimeout, inactivityTimeoutMs);
      inactivityTimer.unref?.();
    };

    let terminalReason: AgentTurnCompletionReason | undefined;
    let terminalNotificationType: SessionNotificationType | undefined;
    const completion = new Promise<void>((resolve, reject) => {
      rejectCompletion = reject;
      resetInactivityTimer();
      unsubscribe = adapter.subscribeToSessionNotifications(
        sessionId,
        (notification) => {
          resetInactivityTimer();
          // Both an explicit turn-completed event and an ERROR/process-exit
          // notification are terminal. A child can die without ever emitting
          // AGENT_TURN_COMPLETED (abrupt process exit, or a resume-setup
          // throw), which would otherwise hang the await below until the
          // parent aborts. The success-vs-failure decision is deferred to the
          // post-loop resolver so a process-exit that still produced output is
          // recovered instead of being reported as an abort.
          if (terminalReason !== undefined) {
            // First terminal signal wins; ignore any trailing notifications.
            return;
          }
          if (
            notification.type === SessionNotificationType.AGENT_TURN_COMPLETED
          ) {
            terminalReason = notification.reason;
            terminalNotificationType = notification.type;
            resolve();
            return;
          }

          if (
            notification.type ===
            DaemonSpecificNotificationType.SESSION_INACTIVITY
          ) {
            reject(
              new MetaError('Subagent session cleaned up after inactivity', {
                sessionId,
                notificationType: notification.type,
              })
            );
            return;
          }

          if (notification.type === SessionNotificationType.ERROR) {
            terminalReason = isProcessExitNotification(notification)
              ? AgentTurnCompletionReason.ProcessExit
              : AgentTurnCompletionReason.Error;
            terminalNotificationType = notification.type;
            resolve();
          }
        }
      );

      abortListener = () => {
        void interruptSubagent().finally(() => {
          reject(new ToolAbortError());
        });
      };
      childAbortController.signal.addEventListener('abort', abortListener, {
        once: true,
      });
      if (childAbortController.signal.aborted) {
        abortListener();
      }
    });
    parentAbortListener = () => {
      childAbortController.abort();
    };
    abortSignal?.addEventListener('abort', parentAbortListener, { once: true });
    if (abortSignal?.aborted) {
      childAbortController.abort();
    }

    try {
      if (sendPrompt) {
        await Promise.race([
          adapter.addUserMessage({ sessionId, text: prompt }),
          completion,
        ]);
      }
      // The subscription resolves `completion` on the first terminal signal
      // (turn completed, error, or a forwarded process exit) and rejects it on
      // abort, so there is nothing to poll for here.
      await completion;
      completed = true;

      let finalText = '';
      for (
        let attempt = 0;
        attempt < FOREGROUND_FINAL_TEXT_MAX_ATTEMPTS;
        attempt++
      ) {
        finalText = TaskCliExecutor.readForegroundFinalText({
          sessionId,
          sessionStateManager,
        });
        if (finalText.trim()) {
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, FOREGROUND_FINAL_TEXT_RETRY_DELAY_MS);
        });
      }
      return resolveForegroundSubagentOutcome({
        reason: terminalReason,
        finalText,
        sessionId,
        notificationType: terminalNotificationType,
      });
    } finally {
      clearInactivityTimer();
      if (!completed) {
        await interruptSubagent();
      }
      await closeSubagent();
      forgetSessionBackedTaskStartTime(sessionId);

      unsubscribe();
      if (abortListener) {
        childAbortController.signal.removeEventListener('abort', abortListener);
      }
      if (parentAbortListener && abortSignal) {
        abortSignal.removeEventListener('abort', parentAbortListener);
      }
    }
  }

  private static readForegroundFinalText({
    sessionId,
    sessionStateManager,
  }: {
    sessionId: string;
    sessionStateManager: MultiSessionStateManager;
  }): string {
    const stateText = readSessionFinalTextFromState({
      sessionId,
      sessionStateManager,
    });
    if (stateText.trim()) {
      return stateText;
    }

    return '';
  }

  private async *launchBackground(
    args: string[],
    parameters: TaskToolParams,
    dependencies: CliClientToolDependencies
  ): AsyncGenerator<
    DraftToolFeedback<string | ToolStreamingUpdate, ToolStreamingUpdate>
  > {
    const processor = new SubagentStreamProcessor();
    const parentSessionId =
      getSessionService().getCurrentSessionId() ?? 'unknown';
    // Session ID is pre-generated and passed via --session-id in args,
    // so we use it directly as the taskId (no temporal bg-* IDs needed).
    const taskId = TaskCliExecutor.extractSessionIdFromArgs(args);
    const outputFile = backgroundTaskManager.getOutputFilePath(taskId);

    const result = await processor.launchBackground(args, {
      abortSignal: dependencies.abortSignal,
      toolCallId: dependencies.toolCallId,
      outputFile,
      taskId,
      parentSessionId,
      subagentType: parameters.subagent_type,
      description: parameters.description,
    });

    if (result.pid <= 0) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Failed to spawn background task: process did not start (subagent_type=${parameters.subagent_type})`,
        userError: 'Background task failed to start',
      };
      return;
    }

    const responseLines = [
      `Task launched in background.`,
      `task_id: ${taskId}`,
      `pid: ${result.pid}`,
      `subagent_type: ${parameters.subagent_type}`,
    ];

    if (parameters.description) {
      responseLines.push(`description: ${parameters.description}`);
    }

    responseLines.push(
      'The task is running. You will be notified when it completes.',
      `To check progress: use TaskOutput with task_id "${taskId}" and block=false`,
      `To resume later with follow-up: use Task with resume="${taskId}"`
    );

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: responseLines.join('\n'),
    };
  }

  private static buildResumeArgs(parameters: TaskToolParams): BuildArgsResult {
    const { resume, prompt } = parameters;
    const sessionService = getSessionService();
    const parentIsInSpecMode = sessionService.isSpecMode();
    const parentAutonomyLevel = sessionService.getAutonomyLevel();

    const resumePrompt = [
      '# Follow-up Instructions',
      '',
      prompt,
      ...(parentIsInSpecMode
        ? [
            '',
            'Note: the parent session is in Spec Mode (planning/research).',
            'Your toolset remains restricted to read-only operations and low-risk shell commands.',
          ]
        : []),
      '',
      '## Reporting',
      '- Summarize actions taken and outcomes',
      '- List any files created or modified',
    ].join('\n');

    const { args: promptArgs, promptFile } = buildPromptArgs(resumePrompt);
    const args = ['exec', '--session-id', resume!, ...promptArgs];
    if (!parentIsInSpecMode && parentAutonomyLevel !== AutonomyLevel.Off) {
      args.push('--auto', parentAutonomyLevel);
    }
    args.push('--output-format', 'debug');

    const currentDepth = getExecRuntimeConfig().getDepth();
    args.push('--depth', String(currentDepth + 1));

    return { args, promptFile };
  }

  private static async resolvePrompt(
    prompt: string
  ): Promise<PromptResolutionResult> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt.startsWith('/')) {
      return { prompt };
    }

    const parsedCommandText = parseCommandText(trimmedPrompt);
    if (!parsedCommandText) {
      return {
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          'Task prompt starts with "/" but no valid slash command was provided.',
        userError: 'Task prompt slash command is invalid.',
      };
    }

    if (
      TaskCliExecutor.isPathLikeSlashPrompt(
        trimmedPrompt,
        parsedCommandText.commandName
      )
    ) {
      return { prompt };
    }

    const commandMeta = await TaskCliExecutor.getResolvedCustomCommand(
      parsedCommandText.commandName
    );
    if (!commandMeta) {
      return {
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: `Task prompt slash commands only support resolved custom commands. "/${parsedCommandText.commandName}" is not a resolved custom command.`,
        userError: `Only resolved custom slash commands are allowed in Task prompts. "/${parsedCommandText.commandName}" is not available.`,
      };
    }

    if (commandMeta.isExecutable) {
      return {
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: `Task prompt custom command "/${parsedCommandText.commandName}" is executable, and executable custom commands are not allowed in Task prompt resolution.`,
        userError: `Executable custom commands like "/${parsedCommandText.commandName}" are not allowed in Task prompts.`,
      };
    }

    try {
      const commandResult = await executeCustomCommand(
        commandMeta,
        parsedCommandText.args,
        { allowExecutable: false }
      );
      if (!commandResult.messageText) {
        return {
          errorType: ToolExecutionErrorType.ToolInternalError,
          llmError: `Custom command "/${parsedCommandText.commandName}" did not produce messageText.`,
          userError: `Failed to expand custom command "/${parsedCommandText.commandName}".`,
        };
      }

      return { prompt: commandResult.messageText };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logException(error, 'TaskCliExecutor.resolvePrompt');
      return {
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Failed to execute custom command "/${parsedCommandText.commandName}": ${errorMessage}`,
        userError: `Failed to execute custom command "/${parsedCommandText.commandName}".`,
      };
    }
  }

  private static isPathLikeSlashPrompt(
    trimmedPrompt: string,
    commandName: string
  ): boolean {
    if (commandName.includes('/') || commandName.includes('\\')) {
      return true;
    }

    const rawFirstToken = trimmedPrompt.slice(1).trimStart().split(/\s+/, 1)[0];
    return rawFirstToken.startsWith('.') || rawFirstToken.startsWith('~');
  }

  private static async getResolvedCustomCommand(
    commandName: string
  ): Promise<CustomCommand | undefined> {
    const manager = SettingsManager.getInstance();
    const settings = await manager.getResolvedSettings();
    return settings.commands?.find(
      (command) => command.name.toLowerCase() === commandName.toLowerCase()
    );
  }

  private static resolveComplexity(
    parameters: TaskToolParams,
    builtInConfig?: { defaultComplexity: ComplexityTier }
  ): ComplexityTier | undefined {
    if (parameters.complexity) {
      return parameters.complexity;
    }

    return builtInConfig?.defaultComplexity;
  }

  /**
   * Resolve the autonomy level for a Subagents V2 subagent. Honors the
   * `subagentAutonomyLevel` setting (off/low/medium/high) when configured,
   * otherwise inherits the parent session's level. The result is clamped to
   * the org-managed `maxAutonomyLevel` so an explicit setting cannot exceed
   * the enterprise cap. Mission workers do not use this path.
   */
  private static resolveSubagentAutonomyLevel(): AutonomyLevel {
    const settingsService = getSettingsService();
    const configured = settingsService.getSubagentAutonomyLevel();
    const baseLevel =
      configured && configured !== SubagentAutonomyLevel.Inherit
        ? (configured as unknown as AutonomyLevel)
        : getSessionService().getAutonomyLevel();
    return clampAutonomyLevelToMax(
      baseLevel,
      settingsService.getMaxAutonomyLevel()
    );
  }

  private static buildResumePrompt(parameters: TaskToolParams): {
    prompt: string;
    parentIsInSpecMode: boolean;
    parentAutonomyLevel: AutonomyLevel;
  } {
    const sessionService = getSessionService();
    const parentIsInSpecMode = sessionService.isSpecMode();
    const parentAutonomyLevel = TaskCliExecutor.resolveSubagentAutonomyLevel();

    return {
      parentIsInSpecMode,
      parentAutonomyLevel,
      prompt: [
        '# Follow-up Instructions',
        '',
        parameters.prompt,
        ...(parentIsInSpecMode
          ? [
              '',
              'Note: the parent session is in Spec Mode (planning/research).',
              'Your toolset remains restricted to read-only operations and low-risk shell commands.',
            ]
          : []),
        '',
        '## Reporting',
        '- Summarize actions taken and outcomes',
        '- List any files created or modified',
      ].join('\n'),
    };
  }

  private static async buildStreamJsonRpcTaskConfig(
    parameters: TaskToolParams,
    dependencies?: CliClientToolDependencies
  ): Promise<StreamJsonRpcTaskConfig | null> {
    if (parameters.resume) {
      const { prompt, parentIsInSpecMode, parentAutonomyLevel } =
        TaskCliExecutor.buildResumePrompt(parameters);
      return {
        sessionId: parameters.resume,
        prompt,
        parentIsInSpecMode,
        parentAutonomyLevel,
        isResume: true,
        tags: [{ name: SESSION_TAG_SUBAGENT }],
        cwd: process.cwd(),
        subagentSource: 'custom',
      };
    }

    const { subagent_type: subagentType, description, prompt } = parameters;

    const droolLoader = getDroolLoaderSingleton();
    const drools = await droolLoader.loadAllDrools();
    let droolConfig = drools.find((d) => d.metadata.name === subagentType);
    const builtInConfig = getBuiltInDroolConfig(subagentType);
    const isCustomDrool = Boolean(droolConfig);

    if (!droolConfig && builtInConfig) {
      droolConfig = builtInDroolConfigToCustomDrool(builtInConfig);
    }

    if (!droolConfig) {
      return null;
    }

    // Resolve the effective model first
    // If the pinned model is not allowed, applies a fallback if defined
    // If that is still invalid, falls back to the parent's model
    const allowedModels = [...getAllowedModelIds()];
    const isModelAllowed = (modelId: DroolModel) =>
      DroolValidator.validateModel(modelId, allowedModels).valid;
    const model = getSettingsService().resolveModelWithFallback(
      droolConfig.metadata.model,
      isModelAllowed
    );
    const droolModel =
      model && model !== 'inherit' && !isModelAllowed(model)
        ? 'inherit'
        : model;

    const expandedTools = DroolValidator.expandTools({
      tools: droolConfig.metadata.tools,
      model: droolModel || 'inherit',
    });
    const complexity = TaskCliExecutor.resolveComplexity(
      parameters,
      isCustomDrool ? undefined : builtInConfig
    );
    const sessionService = getSessionService();
    const parentIsInSpecMode = sessionService.isSpecMode();
    const parentAutonomyLevel = TaskCliExecutor.resolveSubagentAutonomyLevel();

    const taskPrompt = buildTaskInvocationPrompt({
      subagentType,
      complexity,
      description,
      prompt,
      parentIsInSpecMode,
      includeSubagentIdentity: false,
      droolSystemPrompt: droolConfig.systemPrompt,
    });

    const shouldInheritFromParent = !droolModel || droolModel === 'inherit';
    const settingsService = getSettingsService();
    const hasExplicitRouting =
      shouldInheritFromParent && complexity
        ? settingsService.hasExplicitSubagentModelForComplexity(complexity)
        : false;
    const routedModel = hasExplicitRouting
      ? settingsService.getSubagentModelForComplexity(complexity!)
      : undefined;
    const parentModelSelection = shouldInheritFromParent
      ? getSessionService().getInheritableActiveModelSelection()
      : undefined;
    const parentModelId =
      parentModelSelection?.modelId ?? dependencies?.topLevelModel?.id;
    const parentReasoningEffort =
      parentModelSelection?.reasoningEffort ??
      dependencies?.topLevelModel?.reasoningEffort;
    const hasRoutedReasoningOverride =
      hasExplicitRouting && complexity
        ? settingsService.hasSubagentReasoningEffortOverrideForComplexity(
            complexity
          )
        : false;
    const routedReasoningEffort =
      hasExplicitRouting && complexity
        ? hasRoutedReasoningOverride ||
          parentModelId !== routedModel ||
          parentReasoningEffort === undefined
          ? settingsService.getSubagentReasoningEffortForComplexity(complexity)
          : undefined
        : undefined;

    let modelId: string | undefined;
    let reasoningEffort: ReasoningEffort | undefined;

    if (shouldInheritFromParent && routedModel) {
      modelId = routedModel;
      reasoningEffort = (routedReasoningEffort ??
        (parentModelId === routedModel ? parentReasoningEffort : undefined)) as
        | ReasoningEffort
        | undefined;
    } else if (shouldInheritFromParent && parentModelId) {
      modelId = parentModelId;
      reasoningEffort = parentReasoningEffort as ReasoningEffort | undefined;
    } else if (droolModel && droolModel !== 'inherit') {
      modelId = droolModel;
      reasoningEffort = droolConfig.metadata.reasoningEffort as
        | ReasoningEffort
        | undefined;
    }

    return {
      sessionId: generateUUID(),
      prompt: taskPrompt,
      systemPromptOverride: buildSubagentSystemPrompt(
        droolConfig.systemPrompt,
        parentIsInSpecMode
      ),
      modelId,
      reasoningEffort,
      enabledToolIds:
        droolConfig.metadata.tools !== undefined && expandedTools.length > 0
          ? expandedTools
          : undefined,
      disabledToolIds: SUBAGENT_DISABLED_TOOL_IDS,
      tags: [{ name: SESSION_TAG_SUBAGENT }],
      title: buildSubagentSessionTitle({
        subagentType,
        taskTitle: description,
      }),
      parentIsInSpecMode,
      parentAutonomyLevel,
      isResume: false,
      cwd: process.cwd(),
      subagentSource: isCustomDrool ? 'custom' : 'built_in',
    };
  }

  private static async buildCommandArgs(
    parameters: TaskToolParams,
    dependencies?: CliClientToolDependencies
  ): Promise<BuildArgsResult | null> {
    const { subagent_type: subagentType, description, prompt } = parameters;
    const isV2 = getExecRuntimeConfig().isSubAgentsV2Enabled();

    // Load drool configuration: check custom drools first, then built-in drools (v2)
    const droolLoader = getDroolLoaderSingleton();
    const drools = await droolLoader.loadAllDrools();
    let droolConfig = drools.find((d) => d.metadata.name === subagentType);
    const builtInConfig = isV2
      ? getBuiltInDroolConfig(subagentType)
      : undefined;
    const isCustomDrool = Boolean(droolConfig);

    // Fall back to built-in drools if no custom drool found (v2 only)
    if (!droolConfig) {
      if (builtInConfig) {
        droolConfig = builtInDroolConfigToCustomDrool(builtInConfig);
      }
    }

    if (!droolConfig) {
      return null;
    }

    // Resolve the effective model first
    // If the pinned model is not allowed, applies a fallback if defined
    // If that is still invalid, fallbacks back to the parent's model
    const allowedModels = [...getAllowedModelIds()];
    const isModelAllowed = (modelId: DroolModel) =>
      DroolValidator.validateModel(modelId, allowedModels).valid;
    const model = getSettingsService().resolveModelWithFallback(
      droolConfig.metadata.model,
      isModelAllowed
    );
    const droolModel =
      model && model !== 'inherit' && !isModelAllowed(model)
        ? 'inherit'
        : model;

    // Expand tools configuration from drool metadata
    const expandedTools = DroolValidator.expandTools({
      tools: droolConfig.metadata.tools,
      model: droolModel || 'inherit',
      mcpServers: droolConfig.metadata.mcpServers,
    });
    const complexity = isV2
      ? TaskCliExecutor.resolveComplexity(
          parameters,
          isCustomDrool ? undefined : builtInConfig
        )
      : undefined;

    const sessionService = getSessionService();
    const parentIsInSpecMode = sessionService.isSpecMode();
    const parentAutonomyLevel = sessionService.getAutonomyLevel();

    const taskPrompt = buildTaskInvocationPrompt({
      subagentType,
      complexity,
      description,
      prompt,
      parentIsInSpecMode,
      includeSubagentIdentity: true,
      droolSystemPrompt: droolConfig.systemPrompt,
    });

    // For large prompts, write to a temp file to avoid OS command-line length
    // limits (Windows/libuv ENAMETOOLONG, macOS ~1 MB argv+envp ceiling).
    const { args: promptArgs, promptFile } = buildPromptArgs(taskPrompt);
    const args = isV2
      ? ['exec', '--init-session-id', generateUUID(), ...promptArgs]
      : ['exec', ...promptArgs];

    // Determine which model to use:
    // 1. If drool's model has an override model configured, use it
    // 2. If drool has a specific model configured (not 'inherit'), use it
    // 3. Otherwise, use complexity routing if configured (v2 only)
    // 4. Otherwise, inherit from parent
    // (droolModel was resolved above, before expandTools, so both paths use the same value)
    const shouldInheritFromParent = !droolModel || droolModel === 'inherit';
    const settingsService = isV2 ? getSettingsService() : undefined;
    const hasExplicitRouting =
      isV2 && shouldInheritFromParent && complexity && settingsService
        ? settingsService.hasExplicitSubagentModelForComplexity(complexity)
        : false;
    const routedModel = hasExplicitRouting
      ? settingsService!.getSubagentModelForComplexity(complexity!)
      : undefined;
    const parentModelSelection =
      getSessionService().getInheritableActiveModelSelection();
    const parentModelId = parentModelSelection.modelId;
    const parentReasoningEffort = parentModelSelection.reasoningEffort;
    const hasRoutedReasoningOverride =
      hasExplicitRouting && complexity && settingsService
        ? settingsService.hasSubagentReasoningEffortOverrideForComplexity(
            complexity
          )
        : false;
    const routedReasoningEffort =
      hasExplicitRouting && complexity && settingsService
        ? hasRoutedReasoningOverride ||
          parentModelId !== routedModel ||
          parentReasoningEffort === undefined
          ? settingsService.getSubagentReasoningEffortForComplexity(complexity)
          : undefined
        : undefined;

    if (shouldInheritFromParent && routedModel) {
      args.push('--model', routedModel);

      if (routedReasoningEffort !== undefined) {
        args.push('--reasoning-effort', routedReasoningEffort);
      } else if (
        parentModelId &&
        parentModelId === routedModel &&
        parentReasoningEffort !== undefined
      ) {
        args.push('--reasoning-effort', parentReasoningEffort);
      }
    } else if (shouldInheritFromParent && parentModelId) {
      // Inherit model and reasoning effort from parent
      args.push('--model', parentModelId);
      if (parentReasoningEffort !== undefined) {
        args.push('--reasoning-effort', parentReasoningEffort);
      }
    } else if (droolModel && droolModel !== 'inherit') {
      // Use drool's configured model (including custom models like 'custom:foo')
      args.push('--model', droolModel);
      // Use drool's reasoning effort if specified
      if (droolConfig.metadata.reasoningEffort !== undefined) {
        args.push('--reasoning-effort', droolConfig.metadata.reasoningEffort);
      }
    }

    if (!parentIsInSpecMode && parentAutonomyLevel !== AutonomyLevel.Off) {
      args.push('--auto', parentAutonomyLevel);
    }
    args.push('--output-format', 'debug');

    // Pass a child allowlist whenever the drool scopes built-in or MCP tools.
    const enabledTools = expandedTools.filter(
      (tool) =>
        !NESTED_DISALLOWED_TOOL_IDS.has(tool) &&
        !(parentIsInSpecMode && SPEC_MODE_MUTATION_TOOL_IDS.has(tool))
    );
    if (
      (droolConfig.metadata.tools !== undefined ||
        droolConfig.metadata.mcpServers !== undefined) &&
      enabledTools.length > 0
    ) {
      args.push('--enabled-tools', enabledTools.join(','));
    }

    // Pass incremented depth to limit recursion
    const currentDepth = getExecRuntimeConfig().getDepth();
    args.push('--depth', String(currentDepth + 1));

    // Tag the session as a subagent
    args.push('--tag', SESSION_TAG_SUBAGENT);

    // Link subagent session to parent session for hierarchy
    if (dependencies?.sessionId) {
      args.push('--calling-session-id', dependencies.sessionId);
    }

    // Link subagent session to the specific tool call that spawned it
    if (dependencies?.toolCallId) {
      args.push('--calling-tool-use-id', dependencies.toolCallId);
    }

    // Use the Task tool parameters as the subsession title so it appears in the sidebar
    if (description) {
      args.push(
        '--session-title',
        buildSubagentSessionTitle({ subagentType, taskTitle: description })
      );
    }

    return {
      args,
      promptFile,
      subagentSource: isCustomDrool ? 'custom' : 'built_in',
    };
  }

  private static extractSessionIdFromArgs(args: string[]): string {
    // Check --init-session-id first (new sessions), then --session-id (resume)
    for (const flag of ['--init-session-id', '--session-id']) {
      const idx = args.indexOf(flag);
      if (idx !== -1 && idx + 1 < args.length) {
        return args[idx + 1];
      }
    }
    return generateUUID();
  }

  private static async listAvailableSubagents(): Promise<string[]> {
    try {
      const builtInNames = getBuiltInDroolConfigs().map((d) => d.name);
      const droolLoader = getDroolLoaderSingleton();
      const drools = await droolLoader.loadAllDrools();
      const customNames = drools
        .filter((drool) => drool.validationResult.valid)
        .map((drool) => drool.metadata.name)
        .filter((name): name is string => Boolean(name && name.trim().length));
      return [...builtInNames, ...customNames];
    } catch (error) {
      logException(error, 'TaskCliExecutor.listAvailableSubagents');
      return [];
    }
  }
}
