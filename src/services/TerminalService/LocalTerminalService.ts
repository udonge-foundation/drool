import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import treeKill from 'tree-kill';

import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { isAgentBrowserCommand } from '@industry/utils/agent-browser';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { scrubSecrets } from '@industry/utils/secretScrubber';

import type {
  ITerminalService,
  TerminalCreateParams,
  TerminalOutputOptions,
} from '@/services/TerminalService/types';
import { summarizeCLIOutput } from '@/tools/executors/client/shell/cli-summarizer';
import {
  ensureAgentBrowserInstalled,
  getAgentBrowserSkillDataDir,
} from '@/utils/agentBrowserEmbedded';
import {
  NON_INTERACTIVE_ENV,
  WINDOWS_PYTHON_UTF8_ENV,
} from '@/utils/constants';
import { generateUUID } from '@/utils/uuid';
import { rewriteCommandForWindowsArgv } from '@/utils/windowsArgvEncoding';
import { resolveWindowsPowerShellExecutableSync } from '@/utils/windowsShell';

import type {
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

const PROCESS_KILL_GRACE_MS = 200;
const PROCESS_KILL_POLL_INTERVAL_MS = 25;

const DEFAULT_TAIL_MAX_BYTES = 8 * 1024;
const DEFAULT_SUMMARY_MAX_BYTES = 128 * 1024;
const TAIL_SCRUB_CONTEXT_BYTES = 4 * 1024;
const UNIX_BASH_PATHS = ['/bin/bash', '/usr/bin/bash'] as const;

interface LocalTerminalState {
  terminalId: string;
  process: ChildProcess;
  exitPromise: Promise<WaitForTerminalExitResponse>;
  exitResult?: WaitForTerminalExitResponse;
  cwd: string;
  createdAt: number;
  usesDetachedProcessGroup: boolean;
  toolId?: string;
  outputDirPath: string;
  outputFilePath: string;
  outputFileHandle: fs.promises.FileHandle;
  lastKnownSize: number;
  preserveOutputFileOnRelease: boolean;
  cached:
    | {
        mode: NonNullable<TerminalOutputOptions['mode']>;
        maxBytes: number;
        size: number;
        output: string;
        truncated: boolean;
      }
    | undefined;
  // Used only for existing tests that introspect internal state.
  output: string;
}

export class LocalTerminalService implements ITerminalService {
  private terminals = new Map<string, LocalTerminalState>();

  private toolTerminals = new Map<string, Set<string>>();

  async create(params: TerminalCreateParams): Promise<{ terminalId: string }> {
    const terminalId = generateUUID();

    const { outputDirPath, outputFilePath, outputFileHandle } =
      await LocalTerminalService.createTerminalOutputFile(terminalId);

    let subprocess: ChildProcess;
    try {
      subprocess = await this.spawnProcess(params, {
        outputFd: outputFileHandle.fd,
      });
    } catch (error) {
      // Only close here on the spawn-failure path: there is no child holding
      // the fd. On success the child owns outputFileHandle.fd for its whole
      // lifetime (passed as outputFd), so the handle is intentionally left
      // open and closed later in release(). A `finally` here would close the
      // fd out from under a running process.
      await outputFileHandle.close().catch(() => {});
      await fs.promises
        .rm(outputDirPath, { recursive: true, force: true })
        .catch(() => {});
      throw error;
    }

    let resolveExit: (result: WaitForTerminalExitResponse) => void;
    const exitPromise = new Promise<WaitForTerminalExitResponse>((resolve) => {
      resolveExit = resolve;
    });

    const cwd = params.cwd ?? process.cwd();
    const state: LocalTerminalState = {
      terminalId,
      process: subprocess,
      output: '',
      exitPromise,
      cwd,
      createdAt: Date.now(),
      usesDetachedProcessGroup: process.platform !== 'win32',
      toolId: params.toolId,
      outputDirPath,
      outputFilePath,
      outputFileHandle,
      lastKnownSize: 0,
      preserveOutputFileOnRelease: false,
      cached: undefined,
    };

    subprocess.on('exit', (code, signal) => {
      state.exitResult = { exitCode: code, signal };
      resolveExit!(state.exitResult);
    });

    this.terminals.set(terminalId, state);

    if (params.toolId) {
      if (!this.toolTerminals.has(params.toolId)) {
        this.toolTerminals.set(params.toolId, new Set());
      }
      this.toolTerminals.get(params.toolId)!.add(terminalId);
    }

    return { terminalId };
  }

  async getOutput(
    terminalId: string,
    options?: TerminalOutputOptions
  ): Promise<TerminalOutputResponse> {
    const state = this.terminals.get(terminalId);
    if (!state) {
      throw new MetaError(`Unknown terminal: ${terminalId}`, { terminalId });
    }

    const mode = options?.mode ?? 'summary';
    const maxBytes =
      options?.maxBytes ??
      (mode === 'tail' ? DEFAULT_TAIL_MAX_BYTES : DEFAULT_SUMMARY_MAX_BYTES);

    const { output, truncated } = await this.readTerminalOutput(state, {
      mode,
      maxBytes,
    });

    return {
      output,
      truncated,
      exitStatus: state.exitResult,
    };
  }

  async getOutputFile(
    terminalId: string
  ): Promise<{ path: string; sizeBytes: number } | null> {
    const state = this.terminals.get(terminalId);
    if (!state) {
      return null;
    }
    const stat = await state.outputFileHandle.stat().catch(() => null);
    if (!stat) {
      return null;
    }
    state.preserveOutputFileOnRelease = true;
    return { path: state.outputFilePath, sizeBytes: stat.size };
  }

  async waitForExit(terminalId: string): Promise<WaitForTerminalExitResponse> {
    const state = this.terminals.get(terminalId);
    if (!state) {
      throw new MetaError(`Unknown terminal: ${terminalId}`, { terminalId });
    }
    return state.exitPromise;
  }

  async kill(terminalId: string): Promise<void> {
    const state = this.terminals.get(terminalId);
    if (state?.process?.pid && !state.exitResult) {
      await LocalTerminalService.killProcessTree(
        state.process.pid,
        state.usesDetachedProcessGroup
      );
    }
  }

  async release(terminalId: string): Promise<void> {
    const state = this.terminals.get(terminalId);
    if (state) {
      if (!state.exitResult && state.process?.pid) {
        await LocalTerminalService.killProcessTree(
          state.process.pid,
          state.usesDetachedProcessGroup
        );
      }
      await state.outputFileHandle.close().catch(() => {});
      if (!state.preserveOutputFileOnRelease) {
        await fs.promises
          .rm(state.outputDirPath, { recursive: true, force: true })
          .catch(() => {});
      }
      if (state.toolId) {
        const toolTerminalIds = this.toolTerminals.get(state.toolId);
        if (toolTerminalIds) {
          toolTerminalIds.delete(terminalId);
          if (toolTerminalIds.size === 0) {
            this.toolTerminals.delete(state.toolId);
          }
        }
      }
      this.terminals.delete(terminalId);
    }
  }

  async releaseAll(): Promise<void> {
    const terminalIds = Array.from(this.terminals.keys());
    await Promise.all(terminalIds.map((id) => this.release(id)));
  }

  async killByToolId(toolId: string): Promise<void> {
    const terminalIds = this.toolTerminals.get(toolId);
    if (!terminalIds || terminalIds.size === 0) {
      return;
    }
    const idsToKill = Array.from(terminalIds);
    await Promise.all(
      idsToKill.map(async (terminalId) => {
        await this.kill(terminalId);
        await this.release(terminalId);
      })
    );
  }

  private static async killProcessTree(
    pid: number,
    usesDetachedProcessGroup: boolean
  ): Promise<void> {
    if (usesDetachedProcessGroup && process.platform !== 'win32') {
      if (await LocalTerminalService.killUnixProcessGroup(pid)) {
        return;
      }
    }

    await LocalTerminalService.killWithTreeKill(pid, 'SIGTERM');
    if (await LocalTerminalService.waitForProcessExit(pid)) {
      return;
    }
    await LocalTerminalService.killWithTreeKill(pid, 'SIGKILL');
    await LocalTerminalService.waitForProcessExit(pid);
  }

  private static async killUnixProcessGroup(pid: number): Promise<boolean> {
    const pgid = -pid;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(pgid, signal);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ESRCH' || err.code === 'ENOENT') return true;
        logWarn('[LocalTerminalService] Failed to signal process group', {
          pid,
          signal,
          error: err.message,
        });
        return false;
      }
      if (await LocalTerminalService.waitForProcessExit(pid)) return true;
    }
    return false;
  }

  private static async killWithTreeKill(
    pid: number,
    signal: NodeJS.Signals
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      treeKill(pid, signal, (error) => {
        if (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'ESRCH' && err.code !== 'ENOENT') {
            logWarn('[LocalTerminalService] Failed to kill process tree', {
              pid,
              signal,
              error: err.message,
            });
          }
        }
        resolve();
      });
    });
  }

  private static async waitForProcessExit(
    pid: number,
    timeoutMs = PROCESS_KILL_GRACE_MS
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise<void>((r) => {
        setTimeout(r, PROCESS_KILL_POLL_INTERVAL_MS);
      });
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  private static isAgentBrowserInvocation(command: string): boolean {
    return isAgentBrowserCommand(command);
  }

  private async spawnProcess(
    params: TerminalCreateParams,
    io: { outputFd: number }
  ): Promise<ChildProcess> {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      DEBIAN_FRONTEND: 'noninteractive',
      ...NON_INTERACTIVE_ENV,
      ...(process.platform === 'win32' ? WINDOWS_PYTHON_UTF8_ENV : {}),
    };

    // Add custom env vars if provided
    if (params.env) {
      for (const { name, value } of params.env) {
        childEnv[name] = value;
      }
    }

    // Ensure ~/.industry/bin is on PATH for embedded tools
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
    if (LocalTerminalService.isAgentBrowserInvocation(params.command)) {
      await ensureAgentBrowserInstalled();
      childEnv.AGENT_BROWSER_SKILLS_DIR = getAgentBrowserSkillDataDir();
    }

    if (process.platform === 'win32') {
      return this.createWindowsProcess(params, childEnv, io.outputFd);
    }
    return this.createUnixProcess(params, childEnv, io.outputFd);
  }

  private createUnixProcess(
    params: TerminalCreateParams,
    childEnv: NodeJS.ProcessEnv,
    outputFd: number
  ): ChildProcess {
    return spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      windowsHide: true,
      env: {
        ...childEnv,
        TERM: 'dumb',
        PS1: '',
        DEBIAN_FRONTEND: 'noninteractive',
      },
      stdio: ['ignore', outputFd, outputFd],
      shell: LocalTerminalService.resolveUnixBashShell(),
      detached: true,
    });
  }

  private static resolveUnixBashShell(): string {
    return (
      UNIX_BASH_PATHS.find((shellPath) => fs.existsSync(shellPath)) ?? 'bash'
    );
  }

  private createWindowsProcess(
    params: TerminalCreateParams,
    childEnv: NodeJS.ProcessEnv,
    outputFd: number
  ): ChildProcess {
    const powershellPath = resolveWindowsPowerShellExecutableSync();
    const powershellArgs = [
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      rewriteCommandForWindowsArgv(params.command),
    ];

    return spawn(powershellPath, powershellArgs, {
      cwd: params.cwd ?? undefined,
      windowsHide: true,
      env: childEnv,
      stdio: ['ignore', outputFd, outputFd],
      detached: false,
      shell: false,
    });
  }

  private static async createTerminalOutputFile(terminalId: string): Promise<{
    outputDirPath: string;
    outputFilePath: string;
    outputFileHandle: fs.promises.FileHandle;
  }> {
    const outputDirPath = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'drool-terminal-')
    );
    const outputFilePath = path.join(outputDirPath, `${terminalId}.log`);
    const outputFileHandle = await fs.promises.open(
      outputFilePath,
      'a+',
      0o600
    );
    return { outputDirPath, outputFilePath, outputFileHandle };
  }

  private static tailByBytes(text: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    const bytes = Buffer.byteLength(text, 'utf-8');
    if (bytes <= maxBytes) return text;
    const buf = Buffer.from(text, 'utf-8');
    return buf.slice(Math.max(0, buf.length - maxBytes)).toString('utf-8');
  }

  private async readTerminalOutput(
    state: LocalTerminalState,
    options: { mode: 'tail' | 'summary'; maxBytes: number }
  ): Promise<{ output: string; truncated: boolean }> {
    const stat = await state.outputFileHandle.stat().catch(() => null);
    const size = stat?.size ?? 0;

    if (
      state.cached &&
      state.cached.mode === options.mode &&
      state.cached.maxBytes === options.maxBytes &&
      state.cached.size === size
    ) {
      state.output = state.cached.output;
      return { output: state.cached.output, truncated: state.cached.truncated };
    }

    const result =
      options.mode === 'tail'
        ? await this.readTailOutput(state, size, options.maxBytes)
        : await this.readSummaryOutput(state, size, options.maxBytes);

    state.cached = {
      ...result,
      mode: options.mode,
      maxBytes: options.maxBytes,
      size,
    };
    state.lastKnownSize = size;
    state.output = result.output;
    return result;
  }

  private async readTailOutput(
    state: LocalTerminalState,
    size: number,
    maxBytes: number
  ): Promise<{ output: string; truncated: boolean }> {
    if (size === 0 || maxBytes <= 0) {
      return { output: '', truncated: false };
    }

    const readBytes = Math.min(size, maxBytes + TAIL_SCRUB_CONTEXT_BYTES);
    const offset = Math.max(0, size - readBytes);
    const buffer = Buffer.alloc(readBytes);
    const { bytesRead } = await state.outputFileHandle.read(
      buffer,
      0,
      readBytes,
      offset
    );

    let text = buffer.toString('utf-8', 0, bytesRead);
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1);
      }
    }

    let scrubbed = text;
    try {
      scrubbed = scrubSecrets(text);
    } catch {
      // best-effort scrubbing only
    }

    scrubbed = LocalTerminalService.tailByBytes(scrubbed, maxBytes);
    return {
      output: scrubbed.toWellFormed(),
      truncated: size > maxBytes,
    };
  }

  private async readSummaryOutput(
    state: LocalTerminalState,
    size: number,
    maxBytes: number
  ): Promise<{ output: string; truncated: boolean }> {
    if (size === 0 || maxBytes <= 0) {
      return { output: '', truncated: false };
    }

    const truncated = size > maxBytes;
    if (!truncated) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await state.outputFileHandle.read(
        buffer,
        0,
        size,
        0
      );
      let text = buffer.toString('utf-8', 0, bytesRead);
      try {
        text = scrubSecrets(text);
      } catch {
        // best-effort scrubbing only
      }
      return {
        output: summarizeCLIOutput(text).toWellFormed(),
        truncated: false,
      };
    }

    const headBytes = Math.max(0, Math.floor(maxBytes * 0.5));
    const tailBytes = Math.max(0, maxBytes - headBytes);
    const headReadBytes = Math.min(size, headBytes);
    const tailReadBytes = Math.min(size - headReadBytes, tailBytes);

    const headBuffer = Buffer.alloc(headReadBytes);
    const { bytesRead: headBytesRead } = await state.outputFileHandle.read(
      headBuffer,
      0,
      headReadBytes,
      0
    );
    const tailOffset = Math.max(0, size - tailReadBytes);
    const tailBuffer = Buffer.alloc(tailReadBytes);
    const { bytesRead: tailBytesRead } = await state.outputFileHandle.read(
      tailBuffer,
      0,
      tailReadBytes,
      tailOffset
    );

    const headText = headBuffer.toString('utf-8', 0, headBytesRead);
    let tailText = tailBuffer.toString('utf-8', 0, tailBytesRead);

    if (tailOffset > 0) {
      const firstNewline = tailText.indexOf('\n');
      if (firstNewline >= 0) {
        tailText = tailText.slice(firstNewline + 1);
      }
    }

    const omittedBytes = Math.max(0, size - (headBytesRead + tailBytesRead));
    const combined = `${headText}\n\n[... truncated ${omittedBytes} bytes from middle section ...]\n\n${tailText}`;

    let scrubbed = combined;
    try {
      scrubbed = scrubSecrets(combined);
    } catch {
      // best-effort scrubbing only
    }

    return {
      output: summarizeCLIOutput(scrubbed).toWellFormed(),
      truncated: true,
    };
  }
}
