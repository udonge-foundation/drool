import { spawn } from 'child_process';

import { SessionNotificationType } from '@industry/drool-sdk-ext/protocol/drool';
import { logException, logInfo, logWarn } from '@industry/logging';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { HookEventName } from '@/hooks/enums';
import { HookExecutionResult, HookInput } from '@/hooks/types';
import { getFolderTrustService } from '@/services/FolderTrustService';
import { processTracker } from '@/services/ProcessTracker';
import { getSettingsService } from '@/services/SettingsService';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';
import { WINDOWS_PYTHON_UTF8_ENV } from '@/utils/constants';
import { generateUUID } from '@/utils/uuid';

import type {
  HookConfig,
  HookCommand,
  HooksSettings,
} from '@industry/common/cli';

function getHookShellInvocation(command: string): {
  command: string;
  shell: 'cmd.exe' | 'sh';
} {
  // Passing a complete command as cmd.exe argv makes Node escape its inner
  // quotes before cmd.exe parses them. Use the shell-command form instead.
  return {
    command,
    shell: process.platform === 'win32' ? 'cmd.exe' : 'sh',
  };
}

class HookService {
  hasMatchingHooks(params: {
    eventName: HookEventName;
    matcher?: string;
    command?: string;
  }): boolean {
    return this.getMatchingHookCommands(params).length > 0;
  }

  getMatchingHookCommands(params: {
    eventName: HookEventName;
    matcher?: string;
    command?: string;
  }): HookCommand[] {
    const { eventName, matcher, command } = params;
    const settingsService = getSettingsService();
    if (settingsService.getHooksDisabled()) {
      return [];
    }

    const hookConfigs = settingsService.getHooksForType(
      eventName as keyof HooksSettings
    );
    return HookService.matchHooks(hookConfigs, matcher, command);
  }

  async executeHooks(params: {
    eventName: HookEventName;
    input: HookInput;
    matcher?: string;
    command?: string; // The actual command being executed (for Execute tool)
    abortSignal?: AbortSignal;
    toolCallId?: string;
    emitNotifications?: boolean;
    matchedCommands?: HookCommand[];
  }): Promise<HookExecutionResult[]> {
    const {
      eventName,
      input,
      matcher,
      command,
      abortSignal,
      toolCallId,
      emitNotifications = true,
      matchedCommands: precomputedMatchedCommands,
    } = params;
    try {
      const settingsService = getSettingsService();

      // Check if hooks are globally disabled
      if (settingsService.getHooksDisabled()) {
        return [];
      }

      // Folder trust gate (CLI-897): resume/fork flows load sessions (and
      // would fire SessionStart hooks) before the interactive trust prompt
      // can render, so hook execution is suppressed at this choke point
      // until the folder is trusted.
      if (getFolderTrustService().isTrustGateActive()) {
        logInfo('[Hooks] Skipping hooks: folder not trusted yet', {
          eventName,
        });
        return [];
      }

      const matchedCommands =
        precomputedMatchedCommands ??
        this.getMatchingHookCommands({ eventName, matcher, command });

      logInfo('[Hooks] Matched commands', {
        eventName,
        matcher,
        command,
        count: matchedCommands.length,
      });

      if (matchedCommands.length === 0) {
        return [];
      }

      // Generate invocation ID to group all hooks from this event trigger
      const invocationId = generateUUID();
      const hookId = generateUUID();

      logInfo('[Hooks] Executing hooks', {
        eventName,
        matcher,
        hookCount: matchedCommands.length,
      });

      if (emitNotifications) {
        agentEventBus.emit(AgentEvent.ProjectNotification, {
          notification: {
            type: SessionNotificationType.HOOK_EXECUTION_STARTED,
            hookId,
            hookEventName: eventName,
            hookMatcher: matcher,
            hookCommands: matchedCommands,
          },
        });
      }

      const results = await Promise.all(
        matchedCommands.map(async (cmd) => {
          const result = await HookService.executeCommand(
            cmd.command,
            input,
            cmd.timeout || 60,
            {
              abortSignal,
              toolCallId,
            }
          );

          // Customer telemetry for each hook invocation
          CustomerMetrics.addToCounter(MetricName.HOOK_INVOCATIONS, 1, {
            [AttributeName.HOOK_EVENT_NAME]: eventName,
            [AttributeName.HOOK_MATCHER]: matcher ?? '*',
            [AttributeName.HOOK_INVOCATION_ID]: invocationId,
          });

          return result;
        })
      );

      if (emitNotifications) {
        const hookResults = results.map((result, index) => ({
          command: matchedCommands[index]?.command,
          timeout: matchedCommands[index]?.timeout,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.suppressOutput !== undefined && {
            suppressOutput: result.suppressOutput,
          }),
        }));

        agentEventBus.emit(AgentEvent.ProjectNotification, {
          notification: {
            type: SessionNotificationType.HOOK_EXECUTION_COMPLETED,
            hookId,
            hookEventName: eventName,
            hookMatcher: matcher,
            hookStatus: hookResults.some((r) => r.exitCode !== 0)
              ? 'error'
              : 'completed',
            hookResults,
          },
        });
      }

      logInfo('[Hooks] Hook execution completed', {
        eventName,
        count: results.length,
      });

      return results;
    } catch (error) {
      // Log error but don't fail - hooks should never break the main app
      logException(
        error,
        '[Hooks] Error executing hooks - returning empty array'
      );
      return [];
    }
  }

  /**
   * Match hooks based on matcher pattern and optional command regex
   *
   * Matcher patterns (compatible with Claude Code):
   * - Empty, "*", or no matcher: Matches all tools
   * - Exact string: "Read" matches only Read tool
   * - Regex: "Edit|Write" or ".*Search" matches multiple tools
   *
   * Command regex (for Execute tool):
   * - Only applies when tool is Execute
   * - Must match the actual command being executed
   * - Example: "^npm" matches npm commands, "git.*push" matches git push
   *
   * Common tool names to match:
   * - CLI: Read, Edit, MultiEdit, Write, Create, Execute, Bash, LS, Glob, Grep, Task, apply_patch
   * - Web: WebSearch, FetchUrl
   * - MCP: mcp__<server>__<tool> (e.g., "mcp__.*" matches all MCP tools)
   * - Integrations: linear_*, slack_*, browser_*, github_*, gitlab_*
   *
   * @param hooks Array of hook configurations to match against
   * @param matcher Tool name or pattern to match (optional)
   * @param command The actual command being executed (for Execute tool, optional)
   * @returns Array of matched hook commands to execute
   */
  private static matchHooks(
    hooks: HookConfig[],
    matcher?: string,
    command?: string
  ): HookCommand[] {
    const commands: HookCommand[] = [];

    for (const config of hooks) {
      // HookConfig is loaded from JSON without runtime validation, so a
      // hand-edited settings.json or third-party plugin can deliver a non-object
      // entry or one whose hooks array is missing/non-array. Skip those instead
      // of throwing mid-loop so valid neighboring entries still execute.
      if (!config || typeof config !== 'object') {
        logWarn('[Hooks] Skipping non-object HookConfig entry', {
          type: typeof config,
        });
        continue;
      }
      if (!Array.isArray(config.hooks)) {
        logWarn(
          '[Hooks] Skipping HookConfig with missing or invalid hooks array',
          {
            matcher: config.matcher,
          }
        );
        continue;
      }

      // First check if tool matcher matches
      let toolMatches = false;

      toolMatches = HookService.matchesMatcher(config.matcher, matcher);

      // If tool doesn't match, skip this config
      if (!toolMatches) {
        continue;
      }

      // If tool matches and there's a commandRegex, check it
      if (config.commandRegex) {
        // commandRegex only applies if we have a command to match against
        if (!command) {
          // No command provided, so skip this config
          continue;
        }

        try {
          const commandRegex = new RegExp(config.commandRegex);
          if (!commandRegex.test(command)) {
            // Command doesn't match the regex, skip this config
            continue;
          }
        } catch (error) {
          logException(error, '[Hooks] Invalid command regex', {
            pattern: config.commandRegex,
          });
          // Skip this config if regex is invalid
          continue;
        }
      }

      // Both tool and command (if specified) match - add hooks
      commands.push(...config.hooks);
    }

    return commands;
  }

  private static matchesMatcher(
    configuredMatcher: string | undefined,
    matcher: string | undefined
  ): boolean {
    if (
      !configuredMatcher ||
      configuredMatcher === '*' ||
      configuredMatcher === ''
    ) {
      return true;
    }

    if (!matcher) {
      return true;
    }

    if (configuredMatcher === matcher) {
      return true;
    }

    try {
      return new RegExp(configuredMatcher).test(matcher);
    } catch (error) {
      logException(error, '[Hooks] Invalid matcher regex', {
        matcher: configuredMatcher,
      });
      return false;
    }
  }

  private static withLegacyFields(input: HookInput): Record<string, unknown> {
    const legacyMapping: Record<string, string> = {
      session_id: 'sessionId',
      transcript_path: 'transcriptPath',
      permission_mode: 'permissionMode',
      hook_event_name: 'hookEventName',
      message_id: 'messageId',
      has_images: 'hasInput',
      notification_type: 'notificationType',
      stop_hook_active: 'stopHookActive',
      tool_execution_count: 'toolExecutionCount',
      elapsed_time: 'elapsedTime',
      task_name: 'taskName',
      task_result: 'taskResult',
      task_error: 'taskError',
      custom_instructions: 'customInstructions',
      message_count: 'messageCount',
      estimated_tokens: 'estimatedTokens',
      previous_session_id: 'previousSessionId',
      calling_session_id: 'callingSessionId',
      session_duration_ms: 'sessionDurationMs',
    };

    const result: Record<string, unknown> = { ...input };
    for (const [snakeKey, camelKey] of Object.entries(legacyMapping)) {
      if (snakeKey in input) {
        result[camelKey] = (input as Record<string, unknown>)[snakeKey];
      }
    }
    return result;
  }

  private static async executeCommand(
    command: string,
    input: HookInput,
    timeout: number,
    options: {
      abortSignal?: AbortSignal;
      toolCallId?: string;
    } = {}
  ): Promise<HookExecutionResult> {
    return new Promise((resolve) => {
      if (options.abortSignal?.aborted) {
        resolve(HookService.getCancelledResult());
        return;
      }

      // Add legacy camelCase aliases for backwards compatibility
      const compatInput = HookService.withLegacyFields(input);

      // Build environment variables from string, boolean, and number input fields
      // Only use keys that are valid environment variable names (alphanumeric + underscore)
      const inputEnvVars: Record<string, string> = {};
      const validEnvVarPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

      for (const [key, value] of Object.entries(compatInput)) {
        if (validEnvVarPattern.test(key)) {
          if (typeof value === 'string') {
            inputEnvVars[key] = value;
          } else if (typeof value === 'boolean' || typeof value === 'number') {
            inputEnvVars[key] = String(value);
          }
        }
      }

      const env = {
        ...process.env,
        // Project directory env vars (Claude Code compatibility)
        INDUSTRY_PROJECT_DIR: process.cwd(),
        DROOL_PROJECT_DIR: process.cwd(),
        CLAUDE_PROJECT_DIR: process.cwd(),
        // Plugin root env vars - set to sentinel that produces clear error if unexpanded
        // (plugins should expand these at load time via PluginLoader)
        DROOL_PLUGIN_ROOT: '/PLUGIN_ROOT_NOT_EXPANDED_ERROR',
        CLAUDE_PLUGIN_ROOT: '/PLUGIN_ROOT_NOT_EXPANDED_ERROR',
        // Force UTF-8 mode for Python hook scripts on Windows so user-defined
        // hooks don't crash with UnicodeEncodeError under cp1252/GBK consoles.
        ...(process.platform === 'win32' ? WINDOWS_PYTHON_UTF8_ENV : {}),
        ...inputEnvVars, // Include input environment variables
      };

      const shellInvocation = getHookShellInvocation(command);
      const child = spawn(shellInvocation.command, {
        env,
        shell: shellInvocation.shell,
        timeout: timeout * 1000,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let aborted = false;
      const childPid = child.pid;

      if (options.toolCallId && childPid) {
        processTracker.registerProcess(options.toolCallId, childPid, {
          command: '[hook command]',
          cwd: process.cwd(),
          startTime: Date.now(),
        });
      }

      let abortHandler = () => {};
      const cleanup = () => {
        options.abortSignal?.removeEventListener('abort', abortHandler);
        if (options.toolCallId && childPid) {
          processTracker.unregisterProcess(options.toolCallId, childPid);
        }
      };

      const finish = (result: HookExecutionResult) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      abortHandler = () => {
        if (settled) {
          return;
        }
        aborted = true;

        const cancelledResult = HookService.getCancelledResult();
        if (options.toolCallId && childPid) {
          void processTracker
            .killToolProcesses(options.toolCallId, 'SIGTERM')
            .finally(() => {
              finish(cancelledResult);
            });
          return;
        }

        try {
          child.kill('SIGTERM');
        } catch (error) {
          logWarn('[Hooks] Failed to kill aborted hook process', {
            cause: error,
          });
        }
        setTimeout(() => {
          finish(cancelledResult);
        }, 500);
      };

      options.abortSignal?.addEventListener('abort', abortHandler, {
        once: true,
      });

      // Attach all event handlers BEFORE writing to stdin to avoid race conditions
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code, signal) => {
        if (aborted) {
          finish(HookService.getCancelledResult());
          return;
        }

        // If terminated by signal (timeout, SIGTERM, etc), treat as failure
        const exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
        const result: HookExecutionResult = {
          exitCode,
          stdout,
          stderr,
        };

        if (stdout.trim().startsWith('{')) {
          try {
            const jsonOutput = JSON.parse(stdout);

            // Common JSON fields (Claude Code spec)
            result.continue = jsonOutput.continue;
            result.stopReason = jsonOutput.stopReason;
            // suppressOutput is forwarded onto the wire via a `z.boolean()`
            // protocol schema and is consumed by the TUI hide check, where a
            // truthy non-boolean (e.g. the string "false") would both bypass
            // the check and break daemon-side schema parsing. Only honor it
            // when the hook returned an actual boolean.
            if (typeof jsonOutput.suppressOutput === 'boolean') {
              result.suppressOutput = jsonOutput.suppressOutput;
            }
            result.systemMessage = jsonOutput.systemMessage;

            // Stop/SubagentStop Decision Control (Claude Code spec)
            result.decision = jsonOutput.decision;
            result.reason = jsonOutput.reason;

            // Claude Code standard: Hook-specific output under hookSpecificOutput
            if (jsonOutput.hookSpecificOutput) {
              result.hookSpecificOutput = {
                permissionDecision:
                  jsonOutput.hookSpecificOutput.permissionDecision,
                permissionDecisionReason:
                  jsonOutput.hookSpecificOutput.permissionDecisionReason,
                additionalContext:
                  jsonOutput.hookSpecificOutput.additionalContext,
                updatedInput: jsonOutput.hookSpecificOutput.updatedInput,
              };
            }
          } catch (error) {
            // Truncated/non-JSON hook stdout is an expected, recoverable
            // user-side condition (partial chunk, process killed mid-write).
            // Log-and-continue at warn level instead of error+Sentry.
            logWarn('[Hooks] Failed to parse JSON output from hook', {
              cause: error,
              stdoutLength: stdout.length,
            });
          }
        }

        logInfo('[Hooks] Command completed', {
          exitCode,
          stderr: stderr.substring(0, 500),
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });

        finish(result);
      });

      child.on('error', (error) => {
        logException(error, '[Hooks] Failed to execute hook command');
        finish({
          exitCode: 1,
          stdout: '',
          stderr: error.message,
        });
      });

      // Handle stdin errors for commands that don't read stdin
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        // EPIPE is expected when commands exit without reading stdin
        if (error.code === 'EPIPE') {
          // This is normal - command finished before reading input
          return;
        }

        // Log all other errors as they indicate real problems
        logException(
          error,
          '[Hooks] Unexpected stdin error during hook execution',
          {
            code: error.code,
          }
        );
      });

      // Write input to stdin AFTER all handlers are attached
      child.stdin.write(JSON.stringify(compatInput));
      child.stdin.end();
    });
  }

  private static getCancelledResult(): HookExecutionResult {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Hook execution cancelled by user',
    };
  }
}

// Lazy initialization to avoid module-level side effects
let hookServiceInstance: HookService | null = null;

export function getHookService(): HookService {
  if (!hookServiceInstance) {
    hookServiceInstance = new HookService();
  }
  return hookServiceInstance;
}

export const __testing = Object.freeze({
  getHookShellInvocation,
});
