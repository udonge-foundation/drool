import { SessionNotificationType } from '@industry/drool-sdk-ext/protocol/drool';
import { AutonomyMode } from '@industry/drool-sdk-ext/protocol/shared';
import { logException } from '@industry/logging';

import { ToolExecutionContext } from '@/agent/types';
import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import {
  HookEventName,
  HookExecutionStatus,
  PermissionMode,
} from '@/hooks/enums';
import { HookExecutionResult, HookInput } from '@/hooks/types';
import { getHookService } from '@/services/HookService';
import { isDroolGitAiCheckpointHookCommand } from '@/utils/gitAiHookCommand';
import { generateUUID } from '@/utils/uuid';

import type { HookCommand } from '@industry/common/cli';

/**
 * Convert AutonomyMode to PermissionMode for hook inputs
 */
export function convertAutonomyModeToPermissionMode(
  autonomyMode: AutonomyMode
): PermissionMode {
  switch (autonomyMode) {
    case AutonomyMode.Normal:
      return PermissionMode.Off;
    case AutonomyMode.Spec:
      return PermissionMode.Spec;
    case AutonomyMode.AutoLow:
      return PermissionMode.AutoLow;
    case AutonomyMode.AutoMedium:
      return PermissionMode.AutoMedium;
    case AutonomyMode.AutoHigh:
      return PermissionMode.AutoHigh;
    default:
      return PermissionMode.Off;
  }
}

async function executeHookCommandsWithDisplay(params: {
  eventName: HookEventName;
  input: HookInput;
  matcher: string | undefined;
  context: ToolExecutionContext | undefined;
  commands: HookCommand[];
  command: string | undefined;
}): Promise<HookExecutionResult[]> {
  const { eventName, input, matcher, context, commands, command } = params;
  const hookId = generateUUID();
  if (context?.updateAction) {
    context.updateAction({
      type: 'START_HOOK_EXECUTION',
      id: hookId,
      hookEventName: eventName,
      hookMatcher: matcher,
      hookCommands: commands,
      hookToolCallId: context.toolCallId,
      startTime: Date.now(),
    });
  }

  agentEventBus.emit(AgentEvent.ProjectNotification, {
    notification: {
      type: SessionNotificationType.HOOK_EXECUTION_STARTED,
      hookId,
      hookEventName: eventName,
      hookMatcher: matcher,
      hookCommands: commands,
      hookToolCallId: context?.toolCallId,
    },
  });

  const hookService = getHookService();
  const hookExecutionParams = {
    eventName,
    input,
    matcher,
    ...(command !== undefined && { command }),
    ...(context?.abortSignal && { abortSignal: context.abortSignal }),
    ...(context?.toolCallId && { toolCallId: context.toolCallId }),
    emitNotifications: false,
    matchedCommands: commands,
  };
  const results = await hookService.executeHooks(hookExecutionParams);

  const hasErrors = results.some((r) => r.exitCode !== 0);
  const hookResultPayload = results.map((r) => ({
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(r.suppressOutput !== undefined && { suppressOutput: r.suppressOutput }),
  }));
  const enrichedHookResultPayload = hookResultPayload.map((r, index) => ({
    command: commands[index]?.command,
    timeout: commands[index]?.timeout,
    ...r,
  }));

  if (context?.updateAction) {
    context.updateAction({
      type: 'UPDATE_HOOK_EXECUTION',
      id: hookId,
      hookStatus: hasErrors
        ? HookExecutionStatus.Error
        : HookExecutionStatus.Completed,
      hookResults: hookResultPayload,
    });
  }

  agentEventBus.emit(AgentEvent.ProjectNotification, {
    notification: {
      type: SessionNotificationType.HOOK_EXECUTION_COMPLETED,
      hookId,
      hookEventName: eventName,
      hookMatcher: matcher,
      hookToolCallId: context?.toolCallId,
      hookStatus: hasErrors ? 'error' : 'completed',
      hookResults: enrichedHookResultPayload,
    },
  });

  return results;
}

// Helper function to execute hooks with UI display
export async function executeHooksWithDisplay(
  eventName: HookEventName,
  input: HookInput,
  matcher: string | undefined,
  context: ToolExecutionContext | undefined
): Promise<HookExecutionResult[]> {
  // Extract command from tool_input if tool is Execute
  let command: string | undefined;
  if (matcher === 'Execute' && input.tool_input) {
    const toolInput = input.tool_input as Record<string, unknown>;
    if (typeof toolInput.command === 'string') {
      command = toolInput.command;
    }
  }

  const hookService = getHookService();
  const allCommands = hookService.getMatchingHookCommands({
    eventName,
    matcher,
    command,
  });
  if (allCommands.length === 0) {
    return [];
  }

  const backgroundCommands =
    eventName === HookEventName.PostToolUse
      ? allCommands.filter((hookCommand) =>
          isDroolGitAiCheckpointHookCommand(hookCommand.command)
        )
      : [];
  const foregroundCommands =
    backgroundCommands.length === 0
      ? allCommands
      : allCommands.filter(
          (hookCommand) =>
            !isDroolGitAiCheckpointHookCommand(hookCommand.command)
        );

  if (backgroundCommands.length > 0) {
    const backgroundExecution = executeHookCommandsWithDisplay({
      eventName,
      input,
      matcher,
      context,
      commands: backgroundCommands,
      command,
    });
    try {
      context?.onBackgroundHookScheduled?.({
        eventName,
        matcher,
        commands: backgroundCommands,
        execution: backgroundExecution,
      });
    } catch (error) {
      logException(error, '[Hooks] Background hook schedule callback failed');
    }
    void backgroundExecution.catch((error: unknown) => {
      logException(error, '[Hooks] Background hook execution failed');
    });
  }

  if (foregroundCommands.length === 0) {
    return [];
  }

  return executeHookCommandsWithDisplay({
    eventName,
    input,
    matcher,
    context,
    commands: foregroundCommands,
    command,
  });
}
