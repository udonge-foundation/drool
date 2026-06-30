import { ChildProcess, ChildProcessByStdio, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';

import { logError, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { scrubSecrets } from '@industry/utils/secretScrubber';

import { CallToolCaller } from '@/mcp/enums';
import { processTracker } from '@/services/ProcessTracker';
import { summarizeCLIOutput } from '@/tools/executors/client/shell/cli-summarizer';
import {
  ensureAgentBrowserInstalled,
  getAgentBrowserSkillDataDir,
} from '@/utils/agentBrowserEmbedded';
import {
  NON_INTERACTIVE_ENV,
  WINDOWS_PYTHON_UTF8_ENV,
} from '@/utils/constants';
import { rewriteCommandForWindowsArgv } from '@/utils/windowsArgvEncoding';
import { resolveWindowsPowerShellExecutableSync } from '@/utils/windowsShell';

const SECRET_SCRUBBING_WINDOW_SIZE = 100;
const WINDOWS_POWERSHELL_EXECUTE_ARGS = [
  '-NoLogo',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
] as const;

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Parse the inner background-process PID printed by the Windows fire-and-forget
 * wrapper (`Start-Process -PassThru | Select-Object -ExpandProperty Id`), which
 * emits just the integer followed by a newline.
 *
 * `requireLineTerminator` guards against truncated stdout: while the wrapper is
 * still running, only a digit run followed by CR/LF is a complete, trustworthy
 * PID, so a chunk that arrives split mid-number (e.g. "123" of "12345") is
 * rejected until the rest streams in. Once the wrapper has exited its stdout is
 * complete, so callers pass `false` to accept a PID printed without a trailing
 * newline. Returns `null` when no usable PID is present yet.
 */
export function parseWindowsBackgroundPid(
  stdout: string,
  requireLineTerminator: boolean
): number | null {
  const match = requireLineTerminator
    ? stdout.match(/(\d+)\s*[\r\n]/)
    : stdout.match(/\d+/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(
    requireLineTerminator ? match[1] : match[0],
    10
  );
  return Number.isInteger(parsed) ? parsed : null;
}

interface ExecuteParams {
  command: string;
  cwd: string;
  caller?: CallToolCaller;
  toolId?: string; // Optional tool ID for process tracking
  fireAndForget?: boolean;
}

interface ExecuteResult {
  pid: number | null;
  isComplete: boolean;
  isBackground?: boolean;
  outputFile?: string;
}

interface ProcessEvents {
  onProcessOutput: (pid: number, output: string) => void;
  onProcessExit: (
    pid: number,
    code: number | null,
    signal: string | null
  ) => void;
  onProcessStart: (pid: number) => void;
}

interface ProcessInfo {
  childProcess: ChildProcess;
  workingDirectory: string;
  combinedOutput: string;
  secretScrubbingWindow: string[];
  completedAt: number | null;
  createdAt: number;
}

interface CreateProcessParams {
  command: string;
  cwd: string;
  caller: CallToolCaller;
  childEnv: NodeJS.ProcessEnv;
  fireAndForget?: boolean;
  outputFile?: string;
}

export class ShellExecutor {
  private static isAgentBrowserInvocation(command: string): boolean {
    // Detect a direct invocation of `agent-browser` as a shell command.
    // Matches: agent-browser at start, after shell operators (;|&), or after env vars.
    // Excludes: echo, printf, and other contexts where it's just a string argument.
    const excludePatterns = /^\s*(echo|printf|cat|grep|awk|sed|read)\s+/i;
    if (excludePatterns.test(command)) {
      // Check if agent-browser appears after a shell operator in the command
      const afterOperator = command.match(/[;|&]\s*agent-browser(\s|$)/);
      return !!afterOperator;
    }
    return /(^|[\s;|&()])agent-browser(\s|$)/.test(command);
  }

  private static validateExecuteParams({ command, cwd }: ExecuteParams): void {
    if (!command) {
      throw new MetaError('Command is required', { command });
    }
    if (!cwd) {
      throw new MetaError('Working directory (cwd) is required', { cwd });
    }

    if (!fs.existsSync(cwd)) {
      throw new MetaError('Directory does not exist:', { cwd });
    }

    if (!fs.statSync(cwd).isDirectory()) {
      throw new MetaError('Path is not a directory:', { cwd });
    }
  }

  /**
   * Create a process on Unix/Mac systems using the shell
   */
  private static createUnixProcess({
    command,
    cwd,
    childEnv,
    fireAndForget = false,
    outputFile,
  }: CreateProcessParams): ChildProcessByStdio<null, Readable, Readable> {
    let finalCommand = command;

    if (fireAndForget) {
      // Wrap with nohup for SIGHUP immunity and true backgrounding
      // Escape single quotes in the command and redirect stdout/stderr to file for diagnostics
      const escapedCommand = command.replace(/'/g, "'\\''");
      const outputRedirect = outputFile || '/dev/null';
      finalCommand = `nohup bash -c '${escapedCommand}' > '${outputRedirect}' 2>&1`;
      // Pipe stderr to capture wrapper errors (e.g., bash syntax errors in our escaping)
      return spawn(finalCommand, [], {
        cwd,
        windowsHide: true,
        env: {
          ...childEnv,
          // Ensure the shell doesn't try to be interactive
          TERM: 'dumb',
          PS1: '', // Disable prompt
          DEBIAN_FRONTEND: 'noninteractive', // Prevent apt-get and similar from being interactive
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: 'bash',
        detached: true, // Detach for background
      }) as unknown as ChildProcessByStdio<null, Readable, Readable>;
    }

    // Spawn with shell option to let Node.js handle the shell invocation properly
    // Use 'ignore' for stdin to completely disconnect it from the parent process
    return spawn(command, [], {
      cwd,
      windowsHide: true,
      env: {
        ...childEnv,
        // Ensure the shell doesn't try to be interactive
        TERM: 'dumb',
        PS1: '', // Disable prompt
        DEBIAN_FRONTEND: 'noninteractive', // Prevent apt-get and similar from being interactive
      },
      stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin to prevent TTY conflicts
      shell: 'bash',
      detached: false, // Keep attached so processes are killed with parent
    });
  }

  /**
   * Create a process on Windows systems using PowerShell
   */
  private static createWindowsProcess({
    command,
    cwd,
    caller,
    childEnv,
    fireAndForget = false,
    outputFile,
  }: CreateProcessParams): ChildProcessByStdio<null, Readable, Readable> {
    const powershellPath = resolveWindowsPowerShellExecutableSync();

    // Build PowerShell arguments
    //
    // About ExecutionPolicy:
    // - Windows PowerShell has a security feature called ExecutionPolicy that restricts script execution
    // - Default policies often prevent running scripts or complex commands with special characters
    // - ExecutionPolicy is NOT a security boundary (Microsoft's own documentation states this)
    // - It's designed to prevent accidental script execution, not as a security measure
    // - We use Bypass because complex commands are treated as scripts by PowerShell
    // - Without Bypass, many legitimate commands with &&, ||, |, >, etc. would fail
    const powershellArgs: string[] = [...WINDOWS_POWERSHELL_EXECUTE_ARGS];

    // Load user profiles by default to ensure tools installed via package managers are available in PATH
    // Skip profile loading for FILE_API calls for consistency with Unix behavior
    // TODO: Remove as we're no longer using CLI for local repos
    if (caller === CallToolCaller.FILE_API) {
      // Windows: Skipping profile loading for FILE_API call
      powershellArgs.push('-NoProfile');
    }

    if (fireAndForget) {
      // Use Start-Process for true background execution on Windows
      const escapedPowerShellPath =
        escapePowerShellSingleQuotedString(powershellPath);
      // Use *> inside command to redirect all streams to single file (avoids dual file handle issues)
      const escapedOutputFile = outputFile
        ? escapePowerShellSingleQuotedString(outputFile)
        : '';
      const outputRedirect = outputFile ? ` *>'${escapedOutputFile}'` : '';
      const innerPowerShellArgs = WINDOWS_POWERSHELL_EXECUTE_ARGS.join(' ');
      const encodedCommand = Buffer.from(
        `& { ${command} }${outputRedirect}`,
        'utf16le'
      ).toString('base64');
      const argumentList = `${innerPowerShellArgs} -EncodedCommand ${encodedCommand}`;
      const escapedArgumentList =
        escapePowerShellSingleQuotedString(argumentList);
      const psCommand = `Start-Process -FilePath '${escapedPowerShellPath}' -ArgumentList '${escapedArgumentList}' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`;
      powershellArgs.push('-Command', psCommand);
      // Pipe stdout to capture inner PID, pipe stderr to capture wrapper errors
      return spawn(powershellPath, powershellArgs, {
        cwd,
        windowsHide: true,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false, // Keep attached to parent process group
        shell: false, // We're already using PowerShell explicitly
      }) as unknown as ChildProcessByStdio<null, Readable, Readable>;
    }

    // Add the command as the last argument
    powershellArgs.push('-Command', command);

    // Always use PowerShell for consistency - no CMD fallback
    return spawn(powershellPath, powershellArgs, {
      cwd,
      windowsHide: true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin to prevent TTY conflicts
      detached: false, // Keep attached to parent process group
      shell: false, // We're already using PowerShell explicitly
    });
  }

  /**
   * Create a fallback process when no shell is available
   */
  private static createFallbackProcess({
    command,
    cwd,
    childEnv,
  }: CreateProcessParams): ChildProcessByStdio<null, Readable, Readable> {
    // Fallback to default shell behavior if SHELL is unset on non-Windows
    return spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin to prevent TTY conflicts
      detached: false, // Keep attached so processes are killed with parent
    });
  }

  /**
   * Execute a command
   */
  public static async execute(
    {
      command: rawCommand,
      cwd,
      caller = CallToolCaller.AGENT,
      toolId,
      fireAndForget = false,
    }: ExecuteParams,
    events: ProcessEvents
  ): Promise<ExecuteResult> {
    try {
      ShellExecutor.validateExecuteParams({ command: rawCommand, cwd });

      // Strip trailing & from fireAndForget commands - LLMs commonly add & from training
      // data patterns, but it's redundant here and causes the inner bash to exit immediately
      let command = rawCommand;
      if (fireAndForget && rawCommand.trimEnd().endsWith('&')) {
        command = rawCommand.trimEnd().slice(0, -1).trimEnd();
        logWarn(
          '[ShellExecutor] Stripped trailing & from fireAndForget command (redundant)',
          { preview: rawCommand, textPreview: command }
        );
      }

      if (process.platform === 'win32') {
        command = rewriteCommandForWindowsArgv(command);
      }

      // Use current process environment with PYTHONUNBUFFERED
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        ...NON_INTERACTIVE_ENV,
        ...(process.platform === 'win32' ? WINDOWS_PYTHON_UTF8_ENV : {}),
      };

      // Ensure ~/.industry/bin (or ~/.industry-dev/bin) is on PATH so embedded tools are discoverable.
      // Note: Windows uses 'Path' while Unix uses 'PATH' - find the key case-insensitively
      const industryBinDir = path.join(
        getIndustryHome(),
        getIndustryDirName(),
        'bin'
      );
      const pathKey =
        Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      const existingPath = childEnv[pathKey] || '';
      if (!existingPath.split(path.delimiter).includes(industryBinDir)) {
        childEnv[pathKey] = `${industryBinDir}${path.delimiter}${existingPath}`;
      }

      // Lazily extract agent-browser when requested.
      if (ShellExecutor.isAgentBrowserInvocation(rawCommand)) {
        logInfo(
          '[ShellExecutor] Detected agent-browser invocation, ensuring installed'
        );
        await ensureAgentBrowserInstalled();
        childEnv.AGENT_BROWSER_SKILLS_DIR = getAgentBrowserSkillDataDir();
      }

      // Generate output file path for background processes to capture stdout/stderr
      const outputFile = fireAndForget
        ? path.join(os.tmpdir(), `drool-bg-${Date.now()}.out`)
        : undefined;

      // Log before spawning background process for diagnostics
      if (fireAndForget) {
        logInfo('[ShellExecutor] Starting background process', {
          command,
          cwd,
          filePath: outputFile,
        });
      }

      // Create subprocess based on platform
      let subprocess: ChildProcessByStdio<null, Readable, Readable>;
      if (process.platform === 'win32') {
        subprocess = ShellExecutor.createWindowsProcess({
          command,
          cwd,
          caller,
          childEnv,
          fireAndForget,
          outputFile,
        });
      } else {
        // Always use Unix process for non-Windows
        subprocess = ShellExecutor.createUnixProcess({
          command,
          cwd,
          caller,
          childEnv,
          fireAndForget,
          outputFile,
        });
      }

      // Initialize the process info as soon as we have the subprocess
      const processInfo: ProcessInfo = {
        childProcess: subprocess,
        workingDirectory: cwd,
        combinedOutput: '',
        secretScrubbingWindow: [],
        completedAt: null,
        createdAt: Date.now(),
      };

      // 🔴 process spawned - log after subprocess creation
      if (subprocess.pid) {
        // Register process with tracker if toolId is provided
        // For background processes (fireAndForget), toolId is typically omitted
        // to ensure they are not tracked/killed when the CLI exits
        if (toolId) {
          processTracker.registerProcess(toolId, subprocess.pid, {
            command,
            cwd,
            startTime: Date.now(),
          });
        }
      }

      // For fire-and-forget, verify process started before returning
      if (fireAndForget) {
        if (!subprocess.pid) {
          throw new MetaError('Failed to spawn background process', {
            command,
            filePath: outputFile,
          });
        }

        // Listen for immediate errors and exit
        let spawnError: string | null = null;
        let exitCode: number | null = null;
        let exitSignal: string | null = null;
        let windowsInnerPid: number | null = null;

        subprocess.once('error', (err) => {
          spawnError = err instanceof Error ? err.message : String(err);
        });

        subprocess.once('exit', (code, signal) => {
          exitCode = code;
          exitSignal = signal;
        });

        // On Windows, capture the inner PID from stdout (Start-Process
        // -PassThru | Select-Object -ExpandProperty Id, which prints just the
        // integer followed by a newline). Under load that line can arrive split
        // across stdout chunks, so accumulate the buffer and only accept a PID
        // once its terminating newline is seen. Reading a single early chunk
        // (the previous `.once('data')`) could capture a truncated number - a
        // wrong/nonexistent PID that the tracker can then never kill on exit,
        // which surfaced as a flaky "background process not running" failure.
        let windowsStdoutBuffer = '';
        let windowsPidResolved = false;
        const tryResolveWindowsInnerPid = (): void => {
          if (windowsPidResolved) {
            return;
          }
          const parsed = parseWindowsBackgroundPid(windowsStdoutBuffer, true);
          if (parsed !== null) {
            windowsInnerPid = parsed;
            windowsPidResolved = true;
          }
        };
        if (process.platform === 'win32' && subprocess.stdout) {
          subprocess.stdout.on('data', (data: Buffer) => {
            windowsStdoutBuffer += data.toString();
            tryResolveWindowsInnerPid();
          });
        }

        // Wait for the process to start. On Unix a short fixed delay is enough
        // to surface an immediate spawn error/exit. On Windows we also need the
        // inner PID, so poll until it is parsed from a complete line, the
        // Start-Process wrapper exits (its stdout is then complete), a spawn
        // error occurs, or a bounded timeout elapses.
        const WINDOWS_PID_CAPTURE_TIMEOUT_MS = 2000;
        await new Promise<void>((resolve) => {
          if (process.platform !== 'win32') {
            setTimeout(resolve, 200);
            return;
          }
          const start = Date.now();
          const poll = (): void => {
            tryResolveWindowsInnerPid();
            const exited = exitCode !== null || exitSignal !== null;
            const timedOut =
              Date.now() - start >= WINDOWS_PID_CAPTURE_TIMEOUT_MS;
            if (
              windowsPidResolved ||
              spawnError !== null ||
              exited ||
              timedOut
            ) {
              // On a clean wrapper exit the stream is complete, so a PID printed
              // without a trailing newline (no match above) still resolves here.
              if (!windowsPidResolved && exited) {
                const trailing = parseWindowsBackgroundPid(
                  windowsStdoutBuffer,
                  false
                );
                if (trailing !== null) {
                  windowsInnerPid = trailing;
                  windowsPidResolved = true;
                }
              }
              resolve();
              return;
            }
            setTimeout(poll, 25);
          };
          poll();
        });

        // Check for spawn errors
        if (spawnError !== null) {
          throw new MetaError(
            `Background process failed to start: ${spawnError}`,
            { command, errorMessage: spawnError, filePath: outputFile }
          );
        }

        // Determine the correct PID to return
        // On Windows: use inner PID from Start-Process output
        // On Unix: use subprocess.pid directly
        const actualPid =
          process.platform === 'win32' && windowsInnerPid
            ? windowsInnerPid
            : subprocess.pid;

        // Check if process exited during startup
        if (exitCode !== null || exitSignal !== null) {
          // Get output file diagnostics
          let outputFileExists = false;
          let outputFileSize = 0;
          if (outputFile) {
            try {
              const stats = fs.statSync(outputFile);
              outputFileExists = true;
              outputFileSize = stats.size;
            } catch {
              // File doesn't exist
            }
          }

          // Platform-specific exit code handling
          if (process.platform === 'win32') {
            // On Windows: exit 0 means Start-Process succeeded (process launched)
            // We can't know if the inner command succeeded - treat as "running"
            if (exitCode === 0) {
              if (!windowsInnerPid) {
                // Can't return subprocess.pid - it's the outer PowerShell wrapper which has exited
                logError(
                  '[ShellExecutor] Windows background process started but failed to capture inner PID',
                  {
                    command,
                    pid: subprocess.pid,
                    filePath: outputFile,
                  }
                );
              }
              return {
                pid: windowsInnerPid, // null if capture failed
                isComplete: false, // We don't know if inner command completed
                isBackground: true,
                outputFile,
              };
            }
            // Non-zero = Start-Process itself failed (rare)
            logWarn('[ShellExecutor] Windows Start-Process failed', {
              command,
              pid: subprocess.pid,
              exitCode: exitCode ?? undefined,
              signal: exitSignal ?? undefined,
              filePath: outputFile,
              found: outputFileExists,
              fileSize: outputFileSize,
            });
            throw new MetaError(
              `Windows Start-Process failed (code: ${exitCode}, signal: ${exitSignal})`,
              {
                command,
                pid: subprocess.pid,
                exitCode: exitCode ?? undefined,
                signal: exitSignal ?? undefined,
                filePath: outputFile,
              }
            );
          } else {
            // Unix: exit code IS from the actual command
            // Exit 0 means command succeeded quickly - not an error
            if (exitCode === 0) {
              logInfo('[ShellExecutor] Background process completed quickly', {
                command,
                pid: actualPid,
                exitCode: exitCode ?? undefined,
                filePath: outputFile,
                found: outputFileExists,
                fileSize: outputFileSize,
              });
              return {
                pid: actualPid,
                isComplete: true,
                isBackground: true,
                outputFile,
              };
            }

            // Non-zero exit - log diagnostics for debugging
            logWarn(
              '[ShellExecutor] Background process exited during startup',
              {
                command,
                pid: actualPid,
                exitCode: exitCode ?? undefined,
                signal: exitSignal ?? undefined,
                filePath: outputFile,
                found: outputFileExists,
                fileSize: outputFileSize,
              }
            );

            throw new MetaError(
              `Background process exited immediately (code: ${exitCode}, signal: ${exitSignal})`,
              {
                command,
                pid: actualPid,
                exitCode: exitCode ?? undefined,
                signal: exitSignal ?? undefined,
                filePath: outputFile,
              }
            );
          }
        }

        // Process still running after 200ms - success
        return {
          pid: actualPid,
          isComplete: false,
          isBackground: true,
          outputFile,
        };
      }

      // Flag to track if we've already resolved/rejected the promise
      let isPromiseSettled = false;

      const handleOutput = (data: string | Buffer) => {
        if (subprocess.pid) {
          ShellExecutor.scrubAndUpdateOutput({ data, processInfo, caller });
          const modifiedCombinedOutput = summarizeCLIOutput(
            processInfo.combinedOutput
          );
          events.onProcessOutput(subprocess.pid, modifiedCombinedOutput);
        }
      };

      // We can safely set up event listeners now since we have the subprocess
      subprocess.stdout.on('data', handleOutput);
      subprocess.stderr.on('data', handleOutput);

      return new Promise<ExecuteResult>((resolve, reject) => {
        subprocess.on('error', (error) => {
          if (!isPromiseSettled) {
            isPromiseSettled = true;
            reject(new Error(error.message));
          }
        });

        // Helper function to resolve the promise if it hasn't been settled yet
        const resolveIfNotSettled = (isProcessComplete: boolean) => {
          if (!isPromiseSettled && subprocess.pid) {
            isPromiseSettled = true;

            events.onProcessStart(subprocess.pid);

            resolve({
              pid: subprocess.pid,
              isComplete: isProcessComplete,
            });
          }
        };

        subprocess.on('exit', (code, signal) => {
          if (subprocess.pid) {
            // Unregister process from tracker
            if (toolId) {
              processTracker.unregisterProcess(toolId, subprocess.pid);
            }

            // Calculate duration
            const durationMs = processInfo.completedAt
              ? processInfo.completedAt - processInfo.createdAt
              : Date.now() - processInfo.createdAt;

            // 🔴 process exit - log info for code 0, warning for non-zero
            if (code === 0) {
              // Process exited successfully
            } else {
              logWarn('Process exited with non-zero code', {
                pid: subprocess.pid,
                exitCode: code ?? undefined,
                signal: signal ?? undefined,
                durationMs,
              });
            }

            // Set completion timestamp
            if (processInfo) {
              processInfo.completedAt = Date.now();
            }

            events.onProcessExit(subprocess.pid, code, signal);

            // Resolve the promise if it hasn't been settled yet
            resolveIfNotSettled(true);
          }
        });

        // Wait a small amount of time for the process to start.
        setTimeout(() => {
          resolveIfNotSettled(false);
        }, 250);
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Scrub secrets from process output and update the process info
   */
  private static scrubAndUpdateOutput({
    data,
    processInfo,
    caller = CallToolCaller.AGENT,
  }: {
    data: string | Buffer;
    processInfo: ProcessInfo;
    caller?: CallToolCaller;
  }): ProcessInfo {
    const strData = Buffer.isBuffer(data) ? data.toString() : data;

    // Skip scrubbing for File API caller to avoid false positives when reading files
    if (caller === CallToolCaller.FILE_API) {
      processInfo.combinedOutput += strData;
      return processInfo;
    }

    try {
      const latestLinesJoined = processInfo.secretScrubbingWindow.join('\n');
      const linesToScrub = latestLinesJoined + strData;
      const scrubbedLines = scrubSecrets(linesToScrub);

      if (processInfo.combinedOutput.length >= latestLinesJoined.length) {
        processInfo.combinedOutput =
          processInfo.combinedOutput.slice(0, -latestLinesJoined.length) +
          scrubbedLines;
      } else {
        processInfo.combinedOutput = scrubbedLines;
      }

      processInfo.secretScrubbingWindow = linesToScrub.split('\n');
      if (
        processInfo.secretScrubbingWindow.length > SECRET_SCRUBBING_WINDOW_SIZE
      ) {
        processInfo.secretScrubbingWindow =
          processInfo.secretScrubbingWindow.slice(
            -SECRET_SCRUBBING_WINDOW_SIZE
          );
      }
    } catch (error) {
      // 🟠 scrubbing failure - log warning with error
      logWarn('Secret scrubbing failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fall back to just appending the raw data
      processInfo.combinedOutput += strData;

      // Just keep new lines
      processInfo.secretScrubbingWindow = strData.split('\n');

      if (
        processInfo.secretScrubbingWindow.length > SECRET_SCRUBBING_WINDOW_SIZE
      ) {
        processInfo.secretScrubbingWindow =
          processInfo.secretScrubbingWindow.slice(
            -SECRET_SCRUBBING_WINDOW_SIZE
          );
      }
    }

    return processInfo;
  }
}
