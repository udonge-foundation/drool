import { ToolExecutionErrorType } from '@industry/common/session';
import { ExecuteCliWithBackgroundParams } from '@industry/drool-core/tools/definitions/cli/schema';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { SandboxMode } from '@industry/drool-sdk-ext/protocol/settings';
import { logInfo, logWarn } from '@industry/logging';
import { MetaError, ToolAbortError } from '@industry/logging/errors';

import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import { getI18n } from '@/i18n';
import { consumeDeniedDomains } from '@/sandbox/SandboxPermissionPrompt';
import { backgroundProcessTracker } from '@/services/BackgroundProcessTracker';
import { ensureGitAiAutoSetupForCommands } from '@/services/GitAiAutoSetup';
import { getSandboxService } from '@/services/SandboxService';
import { sessionConfigService } from '@/services/SessionConfigService';
import { getSessionService } from '@/services/SessionService';
import { getTerminalService } from '@/services/TerminalService';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';
import { runPreExecutionHooks } from '@/tools/executors/client/shell/command-hooks';
import {
  detectInteractiveWaitFromOutput,
  detectPreflightInteractiveCommand,
  formatInteractiveCommandBlockedMessage,
  formatInteractiveWaitMessage,
} from '@/tools/executors/client/shell/non-interactive-command-guard';
import { ShellExecutor } from '@/tools/executors/client/shell/shell-executor';
import { trackGitOperations } from '@/tools/executors/client/trackGitOperations';
import {
  CliClientToolDependencies,
  CliClientSpecificToolDependencies,
} from '@/tools/types';
import {
  detectPowerShellBashisms,
  detectPowerShellOutputError,
  formatBashismError,
} from '@/utils/powershell-bashism-detector';
import { getLastNLines } from '@/utils/text-utils';
import { throttle } from '@/utils/throttle';
import { resolveWindowsPowerShellExecutableSync } from '@/utils/windowsShell';

import type { WaitForTerminalExitResponse } from '@agentclientprotocol/sdk';
import type { ToolStreamingUpdate } from '@industry/drool-sdk-ext/protocol/drool';

function formatTerminalOutputSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

// Foreground agent-browser commands can wedge indefinitely (e.g. a page never
// loads or the browser session never becomes ready), silently stalling the
// worker. Cap their timeout so a stuck command surfaces a deterministic
// timeout error instead of hanging. Background (fireAndForget) invocations are
// intentionally exempt.
const AGENT_BROWSER_FOREGROUND_TIMEOUT_SECONDS = 10 * 60;

function isAgentBrowserCommand(command: string): boolean {
  // Only treat `agent-browser` as the executable token: at the start of the
  // command or after a shell separator (newline ; && || | & ( ), allowing
  // optional leading env-var assignments (e.g. `FOO=bar agent-browser`). This
  // avoids clamping unrelated commands like `echo agent-browser`.
  return /(?:^|[\n;&|(]|&&|\|\|)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*agent-browser(?=\s|$)/.test(
    command
  );
}

export class ExecuteCliExecutor
  implements
    ClientToolExecutor<
      CliClientSpecificToolDependencies,
      string | ToolStreamingUpdate,
      ToolStreamingUpdate
    >
{
  private static detectGitAuthFailure(
    command: string,
    output: string
  ): string | null {
    if (!/\bgit\b/.test(command)) {
      return null;
    }

    const lowerOutput = output.toLowerCase();
    const authFailurePatterns = [
      'permission denied',
      'could not read username',
      'could not read password',
      'host key verification failed',
      'fatal: authentication failed',
      'no such identity',
      'repository not found',
      'could not resolve host',
      'ssh_exchange_identification',
      'kex_exchange_identification',
      'connection refused',
      'connection timed out',
      'the requested url returned error: 403',
      'the requested url returned error: 401',
      'terminal prompts disabled',
    ];

    if (authFailurePatterns.some((p) => lowerOutput.includes(p))) {
      return 'Git authentication failed. The user may need to configure SSH keys or a credential helper. Interactive prompts are disabled in Drool to prevent TUI corruption.';
    }

    return null;
  }

  private static detectTtyFailure(output: string): string | null {
    const lowerOutput = output.toLowerCase();
    const ttyFailurePatterns = [
      'input is not from a terminal',
      'output is not to a terminal',
      'not a terminal',
      'no tty present',
      'not a tty',
      'inappropriate ioctl for device',
      'must be run from a terminal',
      'requires a terminal',
      'terminal not fully functional',
      'cannot open terminal',
      'failed to initialize terminal',
      'terminal is not interactive',
      'stdin is not a terminal',
      'stdout is not a terminal',
      'the input device is not a tty',
    ];

    if (ttyFailurePatterns.some((p) => lowerOutput.includes(p))) {
      return 'This command requires an interactive terminal (TTY) which is not available in Drool. Use non-interactive alternatives instead (e.g., use "cat" instead of "less", write files with "tee" or redirect operators instead of editors).';
    }

    return null;
  }

  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: ExecuteCliWithBackgroundParams
  ): AsyncGenerator<
    DraftToolFeedback<string | ToolStreamingUpdate, ToolStreamingUpdate>
  > {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { command, timeout = 60, fireAndForget = false } = parameters;

    if (!command || typeof command !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'command is required and must be a string',
        userError: 'Invalid command provided',
      };
      return;
    }

    // Hard command rejection (blocked commands / hard denylist). executeTool
    // already rejects blocked commands before hooks run, but PreToolUse hooks
    // can rewrite the command via updatedInput afterward, so this executor is
    // the authoritative last gate before anything is spawned.
    const blockedPattern =
      sessionConfigService.getBlockedCommandPattern(command);
    if (blockedPattern) {
      // Breadcrumb + dedicated counter mirror the pre-hook gate in
      // executeTool; the two never fire for the same call. No command or
      // pattern content is recorded (CMEK policy).
      logInfo('[ExecuteCli] Command blocked by blocklist');
      CustomerMetrics.addToCounter(MetricName.COMMAND_BLOCKED, 1, {
        [AttributeName.TOOL_NAME]: 'Execute',
      });
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: getI18n().t('common:toolExecution.blockedCommand', {
          pattern: blockedPattern,
        }),
        userError: 'Command blocked by policy',
      };
      return;
    }

    // Security check for dangerous commands
    const dangerousPatterns = [
      /^rm\s+-rf\s+\/\s*$/, // rm -rf /
      /^rm\s+-rf\s+\/\*/, // rm -rf /*
      /^rm\s+-rf\s+~\s*$/, // rm -rf ~
      /^rm\s+-rf\s+~\//, // rm -rf ~/
      /^rm\s+-rf\s+\$HOME/, // rm -rf $HOME
      /:\(\)\{\s*:\|\s*:\s*&\s*\};/, // Fork bomb
      />\s*\/dev\/sda/, // Direct write to disk
      /dd\s+if=\/dev\/zero\s+of=\/dev/, // DD to system devices
    ];

    const trimmedCommand = command.trim();
    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmedCommand)) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError: `Dangerous command detected: "${command}". This command could cause irreversible damage to the system.`,
          userError: 'Command blocked for safety reasons',
        };
        return;
      }
    }

    // Block commands that require an interactive terminal (TTY).
    // These would hang indefinitely since stdin is ignored and TERM=dumb.
    const interactiveMatch = detectPreflightInteractiveCommand(trimmedCommand);
    if (interactiveMatch) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: formatInteractiveCommandBlockedMessage(interactiveMatch),
        userError: `Interactive command blocked: ${interactiveMatch.desc} (${interactiveMatch.executable})`,
      };
      return;
    }

    // Detect Bash/Unix syntax that will fail in PowerShell on Windows.
    // This catches common LLM mistakes like using &&, grep, head, export, etc.
    if (process.platform === 'win32') {
      let isLegacyPowerShell = false;
      try {
        isLegacyPowerShell =
          resolveWindowsPowerShellExecutableSync() === 'powershell.exe';
      } catch {
        // If resolution fails, assume legacy PowerShell (conservative)
        isLegacyPowerShell = true;
      }

      const bashisms = detectPowerShellBashisms(trimmedCommand, {
        isLegacyPowerShell,
      });
      if (bashisms.length > 0) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError: formatBashismError(bashisms),
          userError: 'Command uses Bash syntax incompatible with PowerShell',
        };
        return;
      }
    }

    // Additional validation for fire-and-forget commands
    if (fireAndForget) {
      const backgroundDangerousPatterns = [
        { pattern: /\brm\b.*-[rRfF]/, desc: 'recursive/force rm' },
        { pattern: /\bsudo\b/, desc: 'sudo elevation' },
        { pattern: /\|.*\bbash\b/, desc: 'piping to bash' },
        { pattern: /\|.*\bsh\b/, desc: 'piping to sh' },
        { pattern: /\beval\b/, desc: 'eval command' },
        { pattern: />.*\/dev\//, desc: 'writing to devices' },
        { pattern: /\bdd\b.*of=\/dev/, desc: 'dd to devices' },
        { pattern: /:\(\)\{.*:\|.*:/, desc: 'fork bomb' },
        { pattern: /\bchmod\b.*-R/, desc: 'recursive chmod' },
        { pattern: /\bchown\b.*-R/, desc: 'recursive chown' },
        { pattern: /\bcurl\b.*\|\s*bash/, desc: 'curl piped to bash' },
        { pattern: /\bwget\b.*-O-.*\|/, desc: 'wget piped' },
      ];

      for (const { pattern, desc } of backgroundDangerousPatterns) {
        if (pattern.test(trimmedCommand)) {
          yield {
            type: DraftToolFeedbackType.Result,
            isError: true,
            errorType: ToolExecutionErrorType.InvalidParameterLLMError,
            llmError: `Command "${command}" is not safe to run as background process (contains: ${desc})`,
            userError:
              'This command cannot be run in background mode for safety reasons',
          };
          return;
        }
      }

      // Check for common server commands and provide warnings
      const warningPatterns = [
        {
          pattern: /^npm\s+(run\s+)?dev/,
          warning: 'Dev servers should use appropriate process managers',
        },
        {
          pattern: /^python.*manage\.py\s+runserver/,
          warning: 'Django dev server may need explicit port binding',
        },
        {
          pattern: /^node\s/,
          warning: 'Node processes should handle SIGTERM properly',
        },
      ];

      let warning = '';
      for (const { pattern, warning: msg } of warningPatterns) {
        if (pattern.test(trimmedCommand)) {
          warning = `\nWarning: ${msg}`;
          break;
        }
      }

      // Execute in background
      try {
        const cwd = dependencies.workingDirectoryFullPath;
        const extracted = sessionConfigService.getExtractedCommands(command);
        await ensureGitAiAutoSetupForCommands(extracted, cwd);

        // Sandbox command wrapping for fire-and-forget
        let bgCommand = command;
        const bgSandboxService = getSandboxService();
        if (
          bgSandboxService.isEnabled() &&
          bgSandboxService.getMode() === SandboxMode.PerCommand
        ) {
          bgCommand = await bgSandboxService.wrapCommand(command);
          // Prepend proxy env vars to the command string for background processes
          const proxyEnv = bgSandboxService.getProxyEnv();
          const envPrefix = Object.entries(proxyEnv)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
          if (envPrefix) {
            bgCommand = `${envPrefix} ${bgCommand}`;
          }
        }

        const result = await this.executeBackgroundCommand(bgCommand, cwd);
        logInfo('[ExecuteCli] Background process started', {
          command,
          pid: result.pid,
          filePath: result.outputFile,
          succeeded: result.isComplete,
        });

        const outputFileInfo = result.outputFile
          ? `\nOutput: ${result.outputFile}`
          : '';
        const pidInfo = result.pid ? `PID: ${result.pid}` : 'PID: unknown';

        // Handle case where command completed quickly (exit 0)
        if (result.isComplete) {
          yield {
            type: DraftToolFeedbackType.Result,
            isError: false,
            value: `Background process completed (${pidInfo})\nCommand: ${command}${outputFileInfo}\nStatus: Completed successfully`,
          };
          return;
        }

        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value: `Background process started (${pidInfo})\nCommand: ${command}${outputFileInfo}\nStatus: Running in background${warning}\n\nNote: Process will continue after CLI exits. Use 'ps' or 'kill' commands to manage.`,
        };
        return;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const outputFile =
          error instanceof MetaError ? error.metadata?.filePath : undefined;
        const outputFileInfo = outputFile ? `\nOutput: ${outputFile}` : '';
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          llmError: `Failed to start background process: ${errorMessage}${outputFileInfo}`,
          userError: `Failed to start background process: ${errorMessage}${outputFileInfo}`,
        };
        return;
      }
    }

    const cwd = dependencies.workingDirectoryFullPath;
    try {
      // Run pre-exec hooks (e.g., secret scanning for git commit/push)
      const extracted = sessionConfigService.getExtractedCommands(command);
      await runPreExecutionHooks(extracted, {
        cwd,
        droolShieldEnabled: dependencies.droolShieldEnabled,
      });
      await ensureGitAiAutoSetupForCommands(extracted, cwd);

      // Sandbox command wrapping for normal execution
      let execCommand = command;
      let sandboxEnv: Array<{ name: string; value: string }> | undefined;
      const sandboxService = getSandboxService();
      if (
        sandboxService.isEnabled() &&
        sandboxService.getMode() === SandboxMode.PerCommand
      ) {
        execCommand = await sandboxService.wrapCommand(command);
        const proxyEnv = sandboxService.getProxyEnv();
        if (Object.keys(proxyEnv).length > 0) {
          sandboxEnv = Object.entries(proxyEnv).map(([name, value]) => ({
            name,
            value,
          }));
        }
      }

      // Clear any stale denied domains before execution so we only
      // capture denials from this specific command.
      consumeDeniedDomains();
      // Cap foreground agent-browser commands so a wedged browser session
      // can't stall the worker indefinitely.
      const effectiveTimeout = isAgentBrowserCommand(command)
        ? Math.min(timeout, AGENT_BROWSER_FOREGROUND_TIMEOUT_SECONDS)
        : timeout;
      // Execute command with streaming
      yield* this.executeCommandWithStreaming(
        execCommand,
        effectiveTimeout,
        dependencies.toolCallId,
        dependencies.abortSignal,
        sandboxEnv,
        cwd
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      const fullErrorMessage = `Error executing command: ${errorMessage}`;

      // Truncate error message if it's too long
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: fullErrorMessage,
        userError: fullErrorMessage,
      };
    }
  }

  private async executeBackgroundCommand(
    command: string,
    cwd: string
  ): Promise<{
    pid: number | null;
    outputFile?: string;
    isComplete?: boolean;
  }> {
    const result = await ShellExecutor.execute(
      {
        command,
        cwd,
        fireAndForget: true,
        // Intentionally omitting toolId to bypass ProcessTracker
        // Background processes should persist after tool execution and CLI exit
        // so they must not be tracked/killed by the session lifecycle
      },
      {
        onProcessOutput: () => {}, // No-op for background processes
        onProcessExit: () => {}, // No-op for background processes
        onProcessStart: () => {}, // No-op for background processes
      }
    );

    // Register with persistent tracker if we have a PID
    if (!result.pid) {
      logWarn('[ExecuteCli] Background process started but PID is unknown', {
        command,
        filePath: result.outputFile,
      });
    } else {
      const sessionId = getSessionService().getCurrentSessionId() || undefined;
      backgroundProcessTracker.registerProcess(
        result.pid,
        command,
        cwd,
        sessionId,
        result.outputFile
      );
    }

    return {
      pid: result.pid,
      outputFile: result.outputFile,
      isComplete: result.isComplete,
    };
  }

  private async *executeCommandWithStreaming(
    command: string,
    timeout: number,
    toolId?: string,
    abortSignal?: AbortSignal,
    env?: Array<{ name: string; value: string }>,
    cwd?: string
  ): AsyncGenerator<
    DraftToolFeedback<string | ToolStreamingUpdate, ToolStreamingUpdate>
  > {
    const terminalService = getTerminalService();

    // Create terminal with toolId for cancellation tracking
    const { terminalId } = await terminalService.create({
      command,
      cwd: cwd ?? process.cwd(),
      toolId,
      env,
    });

    let output = '';
    let hasTimedOut = false;
    let processComplete = false;
    let lastStreamedOutput = '';
    let latestPendingUpdate: DraftToolFeedback<
      string | ToolStreamingUpdate,
      ToolStreamingUpdate
    > | null = null;
    let result: WaitForTerminalExitResponse | null = null;
    let autoStoppedMessage: string | null = null;

    const timeoutMs = timeout * 1000;
    const STREAMING_OUTPUT_TAIL_BYTES = 8 * 1024;
    const FINAL_OUTPUT_SUMMARY_MAX_BYTES = 16 * 1024;

    // Yield initial update with terminalId (ACP uses this to embed terminal)
    yield {
      type: DraftToolFeedbackType.Update,
      value: {
        type: 'status',
        text: '',
        terminalId,
        timestamp: Date.now(),
      } as ToolStreamingUpdate,
    };

    // Create throttled update function (200ms throttle)
    const sendUpdate = throttle((currentOutput: string, tid: string) => {
      if (currentOutput && currentOutput !== lastStreamedOutput) {
        const lastTwoLines = getLastNLines(currentOutput, 2);
        if (lastTwoLines) {
          // Only store the latest update (memory optimization)
          // Include full output for detailed view (Ctrl+O)
          latestPendingUpdate = {
            type: DraftToolFeedbackType.Update,
            value: {
              type: 'status',
              text: lastTwoLines,
              fullOutput: currentOutput,
              terminalId: tid,
              timestamp: Date.now(),
            } as ToolStreamingUpdate,
          };
        }
        lastStreamedOutput = currentOutput;
      }
    }, 200);

    // Set up timeout
    const timeoutHandle = setTimeout(async () => {
      hasTimedOut = true;
      if (!processComplete) {
        logInfo('[ExecuteCli] Timeout reached, killing process', {
          terminalId,
          timeout,
        });
        await terminalService.kill(terminalId);
      }
    }, timeoutMs);

    // Poll for output while waiting for exit
    let wasAborted = false;
    // Emit a keep-alive heartbeat at most once every HEARTBEAT_INTERVAL_MS so
    // the daemon's session inactivity timer is refreshed even when the
    // command produces no visible streaming output (e.g. pytest with stdout
    // redirected to a file). The heartbeat flows over the JSON-RPC session
    // notification channel but is suppressed by the daemon before being
    // forwarded to clients.
    const HEARTBEAT_INTERVAL_MS = 30_000;
    let lastHeartbeatAt = Date.now();
    const emitHeartbeat = (): void => {
      const now = Date.now();
      if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
      const sessionId = getSessionService().getCurrentSessionId();
      if (!sessionId || !toolId) return;
      lastHeartbeatAt = now;
      agentEventBus.emit(AgentEvent.ToolExecutionHeartbeat, {
        toolUseId: toolId,
        toolName: 'Execute',
        sessionId,
      });
    };
    while (!processComplete && !hasTimedOut && !wasAborted) {
      // Check abort signal
      if (abortSignal?.aborted) {
        wasAborted = true;
        break;
      }

      const outputResult = await terminalService.getOutput(terminalId, {
        mode: 'tail',
        maxBytes: STREAMING_OUTPUT_TAIL_BYTES,
      });
      output = outputResult.output;
      sendUpdate(output, terminalId);
      emitHeartbeat();

      if (outputResult.exitStatus) {
        processComplete = true;
        result = outputResult.exitStatus;
      } else {
        const interactiveWaitMatch = detectInteractiveWaitFromOutput(output);
        if (interactiveWaitMatch) {
          autoStoppedMessage =
            formatInteractiveWaitMessage(interactiveWaitMatch);
          processComplete = true;
          logInfo('[ExecuteCli] Interactive wait detected, killing process', {
            terminalId,
            reason: interactiveWaitMatch.desc,
          });
          await terminalService.kill(terminalId);
          result = await terminalService
            .waitForExit(terminalId)
            .catch(() => ({ exitCode: null, signal: 'SIGTERM' }));
        }
      }

      // Yield pending update if available
      if (latestPendingUpdate) {
        yield latestPendingUpdate;
        latestPendingUpdate = null;
      }

      if (!processComplete && !hasTimedOut && !wasAborted) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    }

    clearTimeout(timeoutHandle);
    sendUpdate.flush();

    // Kill process if aborted
    if (wasAborted) {
      logInfo('[ExecuteCli] Abort signal received, killing process', {
        terminalId,
      });
      await terminalService.kill(terminalId);
      result = await terminalService
        .waitForExit(terminalId)
        .catch(() => ({ exitCode: null, signal: 'SIGTERM' }));
    }

    // Yield any remaining update
    if (latestPendingUpdate) {
      yield latestPendingUpdate;
    }

    // Always fetch a bounded summary for the final tool result.
    const finalOutputResult = await terminalService.getOutput(terminalId, {
      mode: 'summary',
      maxBytes: FINAL_OUTPUT_SUMMARY_MAX_BYTES,
    });
    output = finalOutputResult.output;
    result =
      result ??
      finalOutputResult.exitStatus ??
      ({
        exitCode: null,
        signal: hasTimedOut ? 'TIMEOUT' : 'SIGTERM',
      } as const);

    // When the final result was truncated, retain the full output on disk and
    // tell the caller where to find it.
    let savedOutputNote = '';
    if (finalOutputResult.truncated) {
      const outputFile = await terminalService.getOutputFile?.(terminalId);
      if (outputFile) {
        savedOutputNote = `\n\nFull command output saved to: ${outputFile.path} (${formatTerminalOutputSize(outputFile.sizeBytes)})`;
      }
    }

    // Release terminal
    await terminalService.release(terminalId);

    // Generate final result
    if (hasTimedOut) {
      const partialOutput = output
        ? `\n\nPartial output before timeout:\n${output}`
        : '';
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false as const,
        value: `Command timed out after ${timeout} seconds. Consider increasing the timeout for long-running commands.${partialOutput}${savedOutputNote}`,
      };
    } else {
      let finalOutput = output;
      let isError = false;
      let errorType = ToolExecutionErrorType.ToolInternalError;
      const isSigpipe = result.signal === 'SIGPIPE' || result.exitCode === 141;

      if (autoStoppedMessage) {
        isError = true;
        errorType = ToolExecutionErrorType.InvalidParameterLLMError;
        finalOutput = output
          ? `${autoStoppedMessage}\n${output}`
          : autoStoppedMessage;
      } else if (result.exitCode === 0) {
        finalOutput = output || 'Command completed successfully';
        // Track git operations for customer telemetry
        void trackGitOperations(command, output, result.exitCode);
      } else if (isSigpipe) {
        finalOutput =
          output || 'Command terminated early due to SIGPIPE (exit code 141)';
      } else {
        isError = true;
        let errorMsg: string;
        if (result.signal) {
          errorMsg = `Command terminated by signal: ${result.signal}`;
        } else if (result.exitCode === 127) {
          errorMsg = `Command not found. The command or program may not be installed or not in PATH.`;
        } else if (result.exitCode === 126) {
          errorMsg = `Command not executable. Check file permissions.`;
        } else {
          errorMsg = `Command failed (exit code: ${result.exitCode})`;
        }
        finalOutput = output ? `${errorMsg}\n${output}` : errorMsg;

        // Detect git authentication failures and provide actionable guidance
        const gitAuthHint = ExecuteCliExecutor.detectGitAuthFailure(
          command,
          output
        );
        if (gitAuthHint) {
          finalOutput += `\n\n${gitAuthHint}`;
        }

        // Detect TTY/terminal requirement failures for interactive programs
        const ttyHint = ExecuteCliExecutor.detectTtyFailure(output);
        if (ttyHint) {
          finalOutput += `\n\n${ttyHint}`;
        }

        // Detect PowerShell syntax errors (safety net for bash-isms that
        // slipped past pre-execution detection)
        if (process.platform === 'win32') {
          const psHint = detectPowerShellOutputError(output);
          if (psHint) {
            finalOutput += `\n\n${psHint}`;
          }
        }
      }

      // Append sandbox denial info if any domains were blocked during this command
      const deniedDomains = consumeDeniedDomains();
      if (deniedDomains.length > 0) {
        isError = true;
        const domainList = deniedDomains.join(', ');
        finalOutput += `\n\nSandbox: network access was denied to: ${domainList}`;
      }

      if (savedOutputNote) {
        finalOutput += savedOutputNote;
      }

      // Always append exit code for transparency
      if (result.exitCode !== null) {
        finalOutput += `\n\n[Process exited with code ${result.exitCode}]`;
      }

      if (isError) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType,
          llmError: finalOutput,
          userError: finalOutput,
        };
      } else {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: false as const,
          value: finalOutput,
        };
      }
    }
  }
}
