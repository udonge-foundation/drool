import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import shellQuote from 'shell-quote';
import treeKill from 'tree-kill';

import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { DraftToolFeedback } from '@industry/drool-core/tools/types';
import { SandboxMode } from '@industry/drool-sdk-ext/protocol/settings';
import { EnvironmentVariable } from '@industry/environment';
import { logException, logInfo, logWarn } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';

import { getWorkerTranscriptPath } from '@/components/mission-control/utils/readWorkerTranscript';
import { AgentEvent, agentEventBus } from '@/events/AgentEventBus';
import {
  BackgroundTaskStatus,
  HookEventName,
  ToolCallStatus,
} from '@/hooks/enums';
import { DROOL_SANDBOXED_ENV } from '@/sandbox/constants';
import { backgroundTaskManager } from '@/services/BackgroundTaskManager';
import { convertAutonomyModeToPermissionMode } from '@/services/hook-utils';
import { getHookService } from '@/services/HookService';
import { processTracker } from '@/services/ProcessTracker';
import { getSandboxService } from '@/services/SandboxService';
import { getSessionService } from '@/services/SessionService';
import { getSettingsService } from '@/services/SettingsService';
import { SubagentEvent } from '@/tools/executors/client/utils/types';

import type { SandboxSettings } from '@industry/common/settings';
import type { ToolStreamingUpdate } from '@industry/drool-sdk-ext/protocol/drool';
// eslint-disable-next-line industry/types-file-organization
export interface BackgroundLaunchResult {
  pid: number;
  sessionId: string | null;
  outputFile: string;
}

function extractParameters(
  event: SubagentEvent
): Record<string, unknown> | undefined {
  if (
    event.parameters === null ||
    event.parameters === undefined ||
    typeof event.parameters !== 'object' ||
    Array.isArray(event.parameters)
  ) {
    return undefined;
  }
  return event.parameters;
}

function extractValueSnippet(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const firstLine = trimmed.split('\n')[0];
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }

  if (typeof value === 'object' && value !== null) {
    try {
      const serialized = JSON.stringify(value);
      return serialized.length > 120
        ? `${serialized.slice(0, 117)}...`
        : serialized;
    } catch (error) {
      logWarn(
        '[SubagentStreamProcessor] Failed to serialize tool value snippet',
        {
          cause: error instanceof Error ? error.message : String(error),
        }
      );
      return undefined;
    }
  }

  if (value !== undefined && value !== null) {
    const asString = String(value);
    return asString.length > 120 ? `${asString.slice(0, 117)}...` : asString;
  }

  return undefined;
}

function formatToolCallDetails(event: SubagentEvent): string | undefined {
  const parameters = extractParameters(event);
  if (!parameters) {
    return undefined;
  }

  const orderedKeys = [
    'file_path',
    'path',
    'directory_path',
    'uri',
    'url',
    'command',
    'description',
  ];

  for (const key of orderedKeys) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return key === 'command' ? value.trim() : `${key}: ${value.trim()}`;
    }
  }

  const entries = Object.entries(parameters).filter(
    ([, value]) => value !== undefined
  );
  if (entries.length === 0) {
    return undefined;
  }

  const preview = entries.slice(0, 3).map(([key, value]) => {
    if (typeof value === 'string') {
      return `${key}: ${value}`;
    }
    try {
      return `${key}: ${JSON.stringify(value)}`;
    } catch {
      return `${key}: ${String(value)}`;
    }
  });

  return preview.join(', ');
}

function formatToolResultDetails(event: SubagentEvent): string | undefined {
  if (event.isError && typeof event.message === 'string') {
    return event.message;
  }

  if (typeof event.text === 'string' && event.text.trim().length > 0) {
    return event.text.trim();
  }

  return extractValueSnippet(event.value);
}

const VALID_TOOL_STATUSES = new Set<ToolCallStatus>([
  ToolCallStatus.Pending,
  ToolCallStatus.Executing,
  ToolCallStatus.Completed,
  ToolCallStatus.Error,
]);

function normalizeToolStatus(
  rawStatus: unknown,
  fallback: ToolCallStatus
): ToolCallStatus {
  if (typeof rawStatus === 'string') {
    const status = rawStatus as ToolCallStatus;
    if (VALID_TOOL_STATUSES.has(status)) {
      return status;
    }
  }
  return fallback;
}

// Kill the subagent if no stdout data arrives for this long (ms).
const DEFAULT_INACTIVITY_TIMEOUT_MS = 60 * 1000 * 3; // 3 minutes
const TASK_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Processes streaming output from a subagent drool process.
 * Parses JSONL events and converts them to DraftToolFeedback updates.
 */
/**
 * Returns the binary and base args needed to re-invoke the CLI.
 * In dev mode (running via `bun /path/to/index.ts`), process.execPath is the
 * bun runtime and process.argv[1] is the script entry point that must be
 * included. In compiled mode, process.execPath is the standalone binary and
 * no extra base arg is needed.
 *
 * We use process.execPath instead of process.argv[0] because Bun >=1.2.21
 * changed compiled-binary argv to ["bun", "/$bunfs/root/index", ...] which
 * made process.argv[0] unreliable for re-spawning.
 */
function getCliSpawnArgs(): { binary: string; baseArgs: string[] } {
  // When the auto-updater preserves the currently-running binary mid-session
  // (POSIX in-place update), INDUSTRY_DROOL_BINARY is pointed at the preserved
  // copy so subagents keep using the same version as this TUI for its
  // lifetime. Honour that here the same way resolveDroolCommand() does.
  //
  // The preserved tmp binary can disappear mid-session (OS tmp sweeper,
  // manual cleanup, parent exit handler racing a still-pending subagent
  // spawn). Fall back to the default resolution in that case rather than
  // failing to spawn.
  const preservedBinary = process.env.INDUSTRY_DROOL_BINARY;
  if (preservedBinary && fs.existsSync(preservedBinary)) {
    return { binary: preservedBinary, baseArgs: [] };
  }
  if (preservedBinary) {
    logWarn(
      'INDUSTRY_DROOL_BINARY is set but path is missing; falling back to default spawn resolution',
      { filePath: preservedBinary }
    );
  }

  const binary = process.execPath;
  const execName = path.basename(binary);

  // In dev mode the execPath is the bun/node runtime, so we need to pass
  // the script entry point as the first arg.
  if (!execName.includes('drool')) {
    const scriptArg = process.argv[1];
    if (scriptArg && (scriptArg.endsWith('.ts') || scriptArg.endsWith('.js'))) {
      return { binary, baseArgs: [scriptArg] };
    }
  }

  return { binary, baseArgs: [] };
}

function buildSubagentEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function writeSandboxRuntimeSettingsFile(sandbox: SandboxSettings): {
  dir: string;
  settingsPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drool-subagent-sandbox-'));
  fs.chmodSync(dir, 0o700);
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, `${JSON.stringify({ sandbox }, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return { dir, settingsPath };
}

function cleanupSandboxRuntimeSettingsFile(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    logWarn(
      '[SubagentStreamProcessor] Failed to clean up sandbox runtime settings file',
      {
        cause: error instanceof Error ? error.message : String(error),
        filePath: dir,
      }
    );
  }
}

interface PreparedSubagentSpawn {
  command: string;
  args: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
  sandboxRuntimeSettingsDir?: string;
}

async function prepareSubagentSpawn(
  binary: string,
  args: string[]
): Promise<PreparedSubagentSpawn> {
  const env = buildSubagentEnv();
  const sandboxService = getSandboxService();

  if (!sandboxService.isEnabled()) {
    return {
      command: binary,
      args,
      shell: false,
      env,
    };
  }

  const sandboxSettings = sandboxService.getSandboxSettingsSnapshot();
  if (!sandboxSettings?.enabled) {
    throw new Error(
      'Sandbox propagation unavailable: active parent sandbox settings could not be established'
    );
  }

  const { dir, settingsPath } =
    writeSandboxRuntimeSettingsFile(sandboxSettings);

  try {
    env[EnvironmentVariable.INDUSTRY_RUNTIME_SETTINGS_PATH] = settingsPath;
    env[DROOL_SANDBOXED_ENV] = '1';
    Object.assign(env, sandboxService.getProxyEnv());

    if (sandboxService.getMode() === SandboxMode.PerCommand) {
      const command = await sandboxService.wrapCommand(
        shellQuote.quote([binary, ...args])
      );
      return {
        command,
        args: [],
        shell: true,
        env,
        sandboxRuntimeSettingsDir: dir,
      };
    }

    return {
      command: binary,
      args,
      shell: false,
      env,
      sandboxRuntimeSettingsDir: dir,
    };
  } catch (error) {
    cleanupSandboxRuntimeSettingsFile(dir);
    throw error;
  }
}

export class SubagentStreamProcessor {
  private toolsExecuted = new Set<string>();

  private messageTexts: string[] = [];

  private lastAssistantMessage = '';

  private hasErrors = false;

  private subagentSessionId: string | null = null;

  /**
   * Process a subagent execution and stream updates.
   */
  async *process(
    args: string[],
    options?: { abortSignal?: AbortSignal; toolCallId?: string }
  ): AsyncGenerator<
    DraftToolFeedback<string | ToolStreamingUpdate, ToolStreamingUpdate>
  > {
    const { abortSignal, toolCallId } = options ?? {};
    const inactivityTimeoutMs =
      getSettingsService().getSubagentInactivityTimeout() ??
      DEFAULT_INACTIVITY_TIMEOUT_MS;
    const startTime = Date.now();

    this.toolsExecuted.clear();
    this.messageTexts = [];
    this.lastAssistantMessage = '';
    this.hasErrors = false;
    this.subagentSessionId = null;

    let aborting = false;
    let abortError: ToolAbortError | null = null;
    let abortListener: (() => void) | null = null;
    let registeredPid: number | null = null;
    let processRegistered = false;
    let stderrCleanup: (() => void) | null = null;

    // Inactivity watchdog state - declared early so cleanup() can reference it.
    let timedOut = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    const { binary, baseArgs } = getCliSpawnArgs();
    let preparedSpawn: PreparedSubagentSpawn;
    try {
      preparedSpawn = await prepareSubagentSpawn(binary, [
        ...baseArgs,
        ...args,
      ]);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        userError: `Failed to prepare sandboxed subagent process: ${errorMessage}`,
        llmError: `Failed to prepare sandboxed subagent process: ${errorMessage}`,
      };
      return;
    }

    const droolProcess = spawn(preparedSpawn.command, preparedSpawn.args, {
      shell: preparedSpawn.shell,
      env: preparedSpawn.env,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately since we don't write to it.
    // This prevents potential hangs if the child process waits for stdin EOF.
    droolProcess.stdin?.end();

    registeredPid = droolProcess.pid ?? null;

    if (toolCallId && droolProcess.pid) {
      registeredPid = droolProcess.pid;
      processTracker.registerProcess(toolCallId, droolProcess.pid, {
        command: 'drool exec (task tool)',
        cwd: process.cwd(),
        startTime: Date.now(),
      });
      processRegistered = true;
    }

    const cleanup = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      if (abortListener && abortSignal) {
        abortSignal.removeEventListener('abort', abortListener);
        abortListener = null;
      }

      if (processRegistered && toolCallId && registeredPid !== null) {
        processTracker.unregisterProcess(toolCallId, registeredPid);
        processRegistered = false;
      }

      if (stderrCleanup) {
        stderrCleanup();
        stderrCleanup = null;
      }

      cleanupSandboxRuntimeSettingsFile(
        preparedSpawn.sandboxRuntimeSettingsDir
      );
    };

    const killProcessTree = async (
      signal: NodeJS.Signals = 'SIGTERM'
    ): Promise<void> => {
      const pid = registeredPid ?? droolProcess.pid;
      if (!pid) {
        return;
      }

      if (droolProcess.exitCode !== null || droolProcess.signalCode) {
        return;
      }

      await new Promise<void>((resolveKill) => {
        treeKill(pid, signal, (error) => {
          if (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code !== 'ESRCH' && err.code !== 'ENOENT') {
              logException(err, 'SubagentStreamProcessor.killProcessTree');
            }
          }
          resolveKill();
        });
      });

      if (signal === 'SIGTERM') {
        setTimeout(() => {
          if (droolProcess.exitCode === null && !droolProcess.killed) {
            void killProcessTree('SIGKILL');
          }
        }, 1000).unref?.();
      }
    };

    const killTrackedProcess = async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (toolCallId) {
        try {
          await processTracker.killToolProcesses(toolCallId, signal);
          return;
        } catch (error) {
          const errorObject =
            error instanceof Error ? error : new Error(String(error));
          logException(
            errorObject,
            'SubagentStreamProcessor.killToolProcesses'
          );
        }
      }

      await killProcessTree(signal);
    };

    if (abortSignal) {
      const handleAbort = () => {
        if (aborting) {
          return;
        }
        aborting = true;
        abortError = new ToolAbortError();
        void killTrackedProcess('SIGTERM');
      };

      abortListener = handleAbort;
      abortSignal.addEventListener('abort', handleAbort, { once: true });

      if (abortSignal.aborted) {
        handleAbort();
      }
    }

    const stdout = droolProcess.stdout;
    if (!stdout) {
      void killProcessTree('SIGTERM');
      cleanup();
      const errorMessage = 'Subagent process stdout unavailable';
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        userError: errorMessage,
        llmError: errorMessage,
      };
      return;
    }

    let errorOutput = '';
    const stderr = droolProcess.stderr;
    if (stderr) {
      const handleStderrData = (data: Buffer | string) => {
        errorOutput += data.toString();
      };
      stderr.on('data', handleStderrData);
      stderrCleanup = () => {
        stderr.off('data', handleStderrData);
      };
    }

    // Inactivity watchdog: kill the child if no stdout data arrives for too long.
    const resetInactivityTimer = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }
      inactivityTimer = setTimeout(() => {
        if (aborting || timedOut) {
          return;
        }
        timedOut = true;
        logWarn('Subagent inactivity timeout', {
          timeout: inactivityTimeoutMs,
          sessionId: this.subagentSessionId ?? undefined,
        });
        void killTrackedProcess('SIGTERM');
      }, inactivityTimeoutMs);
      inactivityTimer.unref?.();
    };

    // Start the watchdog immediately after spawn.
    resetInactivityTimer();

    const emitTaskHeartbeat = (): void => {
      if (!toolCallId) return;
      const sessionId = getSessionService().getCurrentSessionId();
      if (!sessionId) return;
      agentEventBus.emit(AgentEvent.ToolExecutionHeartbeat, {
        toolUseId: toolCallId,
        toolName: 'Task',
        sessionId,
      });
    };

    if (toolCallId) {
      heartbeatInterval = setInterval(
        emitTaskHeartbeat,
        TASK_HEARTBEAT_INTERVAL_MS
      );
      heartbeatInterval.unref?.();
    }

    let buffer = '';
    let exitCode: number | null = null;
    let spawnErrored = false;
    let spawnErrorMessage: string | null = null;

    let resolveProcess: (() => void) | null = null;
    const processFinished = new Promise<void>((resolve) => {
      resolveProcess = () => {
        resolve();
        resolveProcess = null;
      };
    });

    const finalizeProcess = () => {
      if (resolveProcess) {
        resolveProcess();
      }
    };

    droolProcess.once('close', (code) => {
      exitCode = code;
      finalizeProcess();
    });

    droolProcess.once('error', (error) => {
      spawnErrored = true;
      spawnErrorMessage =
        error instanceof Error ? error.message : String(error);
      finalizeProcess();
    });

    try {
      for await (const chunk of stdout) {
        if (spawnErrored || abortError || timedOut) {
          break;
        }

        resetInactivityTimer();

        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line) as SubagentEvent;
            const update = this.parseEventToUpdate(event);

            if (update) {
              yield update;
            }
          } catch {
            continue;
          }
        }
      }
    } catch (streamError) {
      if (!abortError && !timedOut) {
        cleanup();
        throw streamError;
      }
    }

    await processFinished;

    if (!spawnErrored && !abortError && !timedOut && buffer.trim()) {
      try {
        const event = JSON.parse(buffer) as SubagentEvent;
        const update = this.parseEventToUpdate(event);
        if (update) {
          yield update;
        }
      } catch {
        buffer = '';
      }
    }

    try {
      if (abortError) {
        throw abortError;
      }

      if (timedOut) {
        const timeoutMessage = `Subagent process timed out after ${inactivityTimeoutMs / 1000}s of inactivity`;
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          userError: timeoutMessage,
          llmError: timeoutMessage,
        };
        return;
      }

      if (spawnErrored) {
        const message = spawnErrorMessage ?? 'Unknown spawn error';
        const errorMessage = `Failed to spawn subagent process: ${message}`;
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          userError: errorMessage,
          llmError: errorMessage,
        };
        return;
      }

      const finalResult = this.buildFinalResult(exitCode, errorOutput);

      // Execute SubagentStop hooks after subagent completes
      try {
        const currentMode = getSessionService().getCurrentAutonomyMode();
        const permissionMode = convertAutonomyModeToPermissionMode(currentMode);

        // Extract result/error info based on feedback type
        let taskResult: string | undefined;
        let taskError: string | undefined;

        if (finalResult.type === DraftToolFeedbackType.Result) {
          if ('isError' in finalResult && finalResult.isError) {
            taskError =
              'userError' in finalResult
                ? finalResult.userError
                : 'Task failed';
          } else if ('value' in finalResult) {
            taskResult = finalResult.value as string;
          }
        }

        const transcriptPath =
          getSessionService().getSessionTranscriptPath() || '';
        await getHookService().executeHooks({
          eventName: HookEventName.SubagentStop,
          input: {
            session_id: getSessionService().getCurrentSessionId() || 'unknown',
            transcript_path: transcriptPath,
            cwd: process.cwd(),
            permission_mode: permissionMode,
            hook_event_name: HookEventName.SubagentStop,
            task_name: args[0] || 'unknown',
            task_result: taskResult,
            task_error: taskError,
            stop_hook_active: false,
            message_id: undefined,
          },
        });
      } catch (error) {
        // Log but don't fail - hooks should never break subagent execution
        logException(
          error,
          '[SubagentStop] Error executing SubagentStop hooks'
        );
      }

      // Append session_end event to the subagent's JSONL file so mission
      // control can detect completion without waiting for tool_result.
      if (this.subagentSessionId) {
        try {
          const sessionEndEvent = {
            type: 'session_end' as const,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            toolCount: this.toolsExecuted.size,
            finalText: this.lastAssistantMessage || '',
          };
          const transcriptPath = getWorkerTranscriptPath({
            workerSessionId: this.subagentSessionId,
            workingDirectory: process.cwd(),
          });
          fs.appendFileSync(
            transcriptPath,
            `${JSON.stringify(sessionEndEvent)}\n`
          );
        } catch {
          // Never let session_end write failure break tool execution
        }

        try {
          getSessionService().applyChildInclusiveTokenUsageFromSession(
            this.subagentSessionId
          );
        } catch (error) {
          logException(
            error,
            '[SubagentStreamProcessor] Failed to aggregate subagent token usage'
          );
        }
      }

      yield finalResult;
    } finally {
      cleanup();
    }
  }

  /**
   * Parse a JSONL event into a DraftToolFeedback update.
   */
  private parseEventToUpdate(
    event: SubagentEvent
  ): DraftToolFeedback<
    string | ToolStreamingUpdate,
    ToolStreamingUpdate
  > | null {
    switch (event.type) {
      case 'tool_call':
        if (event.toolName) {
          this.toolsExecuted.add(event.toolName);
          const status = normalizeToolStatus(
            event.status,
            ToolCallStatus.Executing
          );
          return {
            type: DraftToolFeedbackType.Update,
            value: {
              type: 'tool_call',
              toolName: event.toolName,
              status,
              details: formatToolCallDetails(event),
              parameters: extractParameters(event),
              timestamp: Date.now(),
            } satisfies ToolStreamingUpdate,
          };
        }
        break;

      case 'tool_result':
        if (event.toolName) {
          const fallbackStatus = event.isError
            ? ToolCallStatus.Error
            : ToolCallStatus.Completed;
          const status = normalizeToolStatus(event.status, fallbackStatus);
          return {
            type: DraftToolFeedbackType.Update,
            value: {
              type: 'tool_result',
              toolName: event.toolName,
              status,
              details: formatToolResultDetails(event),
              valueSnippet: extractValueSnippet(event.value),
              timestamp: Date.now(),
            } satisfies ToolStreamingUpdate,
          };
        }
        break;

      case 'message':
        // Capture assistant messages for fallback output
        if (event.role === 'assistant' && event.text) {
          this.messageTexts.push(event.text);
          // Surface assistant text as a progress update so parent can see it
          const truncated =
            event.text.length > 120
              ? `${event.text.substring(0, 117)}...`
              : event.text;
          return {
            type: DraftToolFeedbackType.Update,
            value: {
              type: 'message',
              text: truncated,
              timestamp: Date.now(),
            } satisfies ToolStreamingUpdate,
          };
        }
        break;

      case 'completion':
        // Capture the final text from completion event
        if (event.finalText && typeof event.finalText === 'string') {
          this.messageTexts.push(event.finalText);
          this.lastAssistantMessage = event.finalText;
        }
        break;

      case 'error':
        this.hasErrors = true;
        if (event.message) {
          return {
            type: DraftToolFeedbackType.Update,
            value: {
              type: 'error',
              error: event.message,
              timestamp: Date.now(),
            } satisfies ToolStreamingUpdate,
          };
        }
        break;

      case 'status':
        // Generic status update
        if (event.message) {
          return {
            type: DraftToolFeedbackType.Update,
            value: {
              type: 'status',
              text: event.message,
              details: event.message,
              timestamp: Date.now(),
            } satisfies ToolStreamingUpdate,
          };
        }
        break;

      case 'system':
        // Parse system/init event to extract the subagent session ID
        if (
          event.subtype === 'init' &&
          typeof event.session_id === 'string' &&
          event.session_id.length > 0
        ) {
          this.subagentSessionId = event.session_id;
          return {
            type: DraftToolFeedbackType.Update,
            value: {
              type: 'status',
              text: 'Subagent session started',
              details: `session: ${event.session_id}`,
              subagentSessionId: event.session_id,
              timestamp: Date.now(),
            } satisfies ToolStreamingUpdate,
          };
        }
        break;

      default:
        // Ignore unhandled event types
        break;
    }

    return null;
  }

  /**
   * Launch a subagent process in the background, streaming output to a file.
   * The session ID is pre-generated by the caller and passed via --new-session-id
   * in args, so no polling for init events is needed.
   */
  async launchBackground(
    args: string[],
    options: {
      abortSignal?: AbortSignal;
      toolCallId: string;
      outputFile: string;
      taskId: string;
      parentSessionId: string;
      subagentType?: string;
      description?: string;
    }
  ): Promise<BackgroundLaunchResult> {
    const {
      toolCallId,
      outputFile,
      taskId,
      parentSessionId,
      subagentType,
      description,
    } = options;

    // Ensure output directory exists
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    }

    const { binary, baseArgs } = getCliSpawnArgs();
    let preparedSpawn: PreparedSubagentSpawn | null = null;
    let outputFd: number | null = null;

    let droolProcess: ReturnType<typeof spawn>;
    try {
      preparedSpawn = await prepareSubagentSpawn(binary, [
        ...baseArgs,
        ...args,
      ]);
      outputFd = fs.openSync(outputFile, 'a', 0o600);
      droolProcess = spawn(preparedSpawn.command, preparedSpawn.args, {
        shell: preparedSpawn.shell,
        env: preparedSpawn.env,
        cwd: process.cwd(),
        stdio: ['ignore', outputFd, outputFd],
        detached: false,
      });
    } catch (error) {
      logException(error, '[SubagentStreamProcessor] Background spawn failed');
      cleanupSandboxRuntimeSettingsFile(
        preparedSpawn?.sandboxRuntimeSettingsDir
      );
      backgroundTaskManager.registerTask({
        taskId,
        type: 'subagent',
        status: BackgroundTaskStatus.Error,
        pid: -1,
        command: `drool exec (${subagentType ?? 'task'})`,
        cwd: process.cwd(),
        startTime: Date.now(),
        endTime: Date.now(),
        parentSessionId,
        toolCallId,
        outputFile,
        description,
        subagentType,
        sessionId: taskId,
      });
      return { pid: -1, sessionId: taskId, outputFile };
    } finally {
      if (outputFd !== null) {
        fs.closeSync(outputFd);
      }
    }

    const pid = droolProcess.pid;
    if (!pid || pid <= 0) {
      backgroundTaskManager.registerTask({
        taskId,
        type: 'subagent',
        status: BackgroundTaskStatus.Error,
        pid: -1,
        command: `drool exec (${subagentType ?? 'task'})`,
        cwd: process.cwd(),
        startTime: Date.now(),
        endTime: Date.now(),
        parentSessionId,
        toolCallId,
        outputFile,
        description,
        subagentType,
        sessionId: taskId,
      });
      logWarn('[SubagentStreamProcessor] Spawn failed: no PID', {
        taskId,
        name: binary,
      });
      cleanupSandboxRuntimeSettingsFile(
        preparedSpawn?.sandboxRuntimeSettingsDir
      );
      return { pid: -1, sessionId: taskId, outputFile };
    }

    // Register the task immediately -- taskId is the pre-generated session ID
    backgroundTaskManager.registerTask({
      taskId,
      type: 'subagent',
      status: BackgroundTaskStatus.Running,
      pid,
      command: `drool exec (${subagentType ?? 'task'})`,
      cwd: process.cwd(),
      startTime: Date.now(),
      parentSessionId,
      toolCallId,
      outputFile,
      description,
      subagentType,
      sessionId: taskId,
    });

    droolProcess.once('close', (code) => {
      const status =
        code === 0
          ? BackgroundTaskStatus.Completed
          : BackgroundTaskStatus.Error;
      const exitCode = code === null ? undefined : code;
      try {
        getSessionService().applyChildInclusiveTokenUsageFromSession(
          taskId,
          parentSessionId
        );
      } catch (error) {
        logException(
          error,
          '[SubagentStreamProcessor] Failed to aggregate background subagent token usage'
        );
      }
      backgroundTaskManager.updateTaskStatus(taskId, status, exitCode);
      cleanupSandboxRuntimeSettingsFile(
        preparedSpawn?.sandboxRuntimeSettingsDir
      );

      logInfo('[SubagentStreamProcessor] Background task completed', {
        taskId,
        exitCode: code,
      });
    });

    droolProcess.once('error', (error) => {
      backgroundTaskManager.updateTaskStatus(
        taskId,
        BackgroundTaskStatus.Error
      );
      cleanupSandboxRuntimeSettingsFile(
        preparedSpawn?.sandboxRuntimeSettingsDir
      );
      logException(
        error,
        '[SubagentStreamProcessor] Background task spawn error'
      );
    });

    // Unref so the parent process can exit independently when needed.
    droolProcess.unref();

    return { pid, sessionId: taskId, outputFile };
  }

  /**
   * Build the final result after process completion.
   */
  private buildFinalResult(
    exitCode: number | null,
    errorOutput: string
  ): DraftToolFeedback<string> {
    // Use the last assistant message if available, otherwise join all messages
    const output = this.lastAssistantMessage || this.messageTexts.join('\n');

    // Include session ID so the LLM can resume this foreground task later
    const sessionPrefix = this.subagentSessionId
      ? `session_id: ${this.subagentSessionId}\n`
      : '';

    // If we have clean output (no errors, successful exit), return it directly
    if (exitCode === 0 && !this.hasErrors && output.trim()) {
      return {
        type: DraftToolFeedbackType.Result,
        isError: false as const,
        value: `${sessionPrefix}${output.trim()}`,
      };
    }

    // Build summary for error/debug cases
    const parts: string[] = [];

    if (exitCode !== 0) {
      parts.push(`⚠️ Task subagent process exited with code ${exitCode}\n`);
    } else if (this.hasErrors) {
      parts.push('⚠️ Task subagent execution completed with errors\n');
    }

    // Include output if we have any
    if (output.trim()) {
      parts.push('\nOutput:');
      parts.push(output.trim());
    } else {
      // No output at all
      parts.push('\n❌ No output received from task subagent.');
      if (!errorOutput.trim()) {
        parts.push('Debug: No assistant message events were captured.');
        parts.push(
          'The subagent may have failed to respond or used an unexpected output format.'
        );
      }
    }

    // Include stderr if present
    if (errorOutput.trim()) {
      parts.push('\nError output:');
      parts.push(errorOutput.trim());
    }

    // Include tools executed summary
    if (this.toolsExecuted.size > 0) {
      parts.push(
        `\nTools executed: ${Array.from(this.toolsExecuted).join(', ')}`
      );
    }

    const finalOutput = parts.join('\n');

    const isError = exitCode !== 0 || this.hasErrors;
    if (isError) {
      return {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        userError: finalOutput,
        llmError: `${sessionPrefix}${finalOutput}`,
      };
    }

    // This shouldn't happen but handle it for type safety
    return {
      type: DraftToolFeedbackType.Result,
      isError: false as const,
      value: `${sessionPrefix}${finalOutput}`,
    };
  }
}
