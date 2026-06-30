import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { spawn, IPty } from 'bun-pty';

import { DaemonTerminalEvent } from '@industry/common/daemon';
import {
  logException,
  logInfo,
  logWarn,
  Metric,
  Metrics,
} from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { OtelTracing, SpanName } from '@industry/logging/tracing';

import { TerminalCleanupScheduler } from './terminal-cleanup-scheduler';
import { TerminalStateTracker } from './terminal-state-tracker';
import { TerminalInfo, Terminal, CreateTerminalParams } from './types';
import { TerminalManagerConfig } from '../types';
import { debugLog } from '../utils/debug-log';
import { resolveWorkingDirectory } from '../utils/validate-working-directory';

import type { IAuthedDaemonConnection } from '../server/types';

const WINDOWS_PLATFORMS = ['win32', 'win64'];
const ALLOWED_SHELLS = [
  '/bin/bash',
  '/bin/sh',
  '/bin/zsh',
  '/bin/dash',
  '/usr/bin/bash',
  '/usr/bin/sh',
  '/usr/bin/zsh',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
];
const DEFAULT_SHELL_BY_PLATFORM: Record<string, string> = {
  linux: '/bin/bash',
  darwin: '/bin/zsh', // macOS default since Catalina
  freebsd: '/bin/sh',
  sunos: '/bin/sh',
  aix: '/bin/sh',
  win32: 'cmd.exe',
  win64: 'cmd.exe',
};

const DEFAULT_TERMINAL_CLEANUP_DELAY_MS = 30000;

export class TerminalManager extends EventEmitter {
  private terminals: Map<string, Terminal> = new Map();

  private terminalToSession: Map<string, string> = new Map();

  private defaultShell: string;

  private readonly baseEnv: Record<string, string>;

  private debug: boolean;

  private readonly terminalsOwnedByClient: Map<
    IAuthedDaemonConnection,
    Set<string>
  > = new Map();

  private readonly clientsOwningTerminal: Map<
    string,
    Set<IAuthedDaemonConnection>
  > = new Map();

  private readonly cleanupScheduler: TerminalCleanupScheduler;

  constructor(
    config: TerminalManagerConfig,
    cleanupDelayMs: number = DEFAULT_TERMINAL_CLEANUP_DELAY_MS
  ) {
    super();
    this.debug = config.debug ?? false;
    this.baseEnv = config.terminalEnv;
    this.defaultShell = TerminalManager.detectShell(config.shell);
    this.cleanupScheduler = new TerminalCleanupScheduler(cleanupDelayMs);

    logInfo('Terminal using shell:', { shell: this.defaultShell });
  }

  private static detectShell(configuredShell: string | undefined): string {
    let shell: string | undefined = configuredShell;

    // For Windows environments, convert to basename to avoid path parsing issues in bun-pty
    // (COMSPEC returns full path like C:\Windows\system32\cmd.exe)
    if (WINDOWS_PLATFORMS.includes(process.platform) && shell) {
      shell = path.basename(shell).toLowerCase();
    }

    // Validate shell is in allowed list
    if (shell && !ALLOWED_SHELLS.includes(shell)) {
      logWarn('Untrusted shell detected, using default', { shell });
      shell = undefined;
    }

    if (shell) return shell;

    // Default shells for different platforms
    return DEFAULT_SHELL_BY_PLATFORM[process.platform] || '/bin/sh';
  }

  createTerminal({
    terminalId,
    sessionId,
    cwd,
    env,
    cols = 80,
    rows = 24,
  }: CreateTerminalParams): void {
    // Resolve cwd. Trim, expand `~`, and normalize first so callers can pass
    // user-friendly paths like `~/foo` or `dir/../dir`.
    let resolvedPath = process.cwd();
    if (cwd) {
      try {
        resolvedPath = resolveWorkingDirectory(cwd);
        const stat = fs.statSync(resolvedPath);
        if (!stat.isDirectory()) {
          throw new MetaError('Invalid cwd: path is not a directory', { cwd });
        }
      } catch (error) {
        if (error instanceof MetaError) throw error;
        throw new MetaError('Invalid cwd: cannot access path', {
          cwd,
          cause: error,
        });
      }
    }

    // Start with base environment provided by the host app.
    // This ensures terminal sessions have access to PATH, LANG, and other
    // environment variables needed for a functional shell.
    const safeEnv: Record<string, string> = { ...this.baseEnv };
    if (env) {
      // Blacklist critical system variables that should never be overridden
      // Note: PATH is allowed to support virtual environments and project-local binaries
      const blockedVars = new Set([
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TMPDIR',
        'SUDO_USER',
        'SSH_AUTH_SOCK',
        'SSH_AGENT_PID',
        'GPG_AGENT_INFO',
      ]);
      for (const [key, value] of Object.entries(env)) {
        if (!blockedVars.has(key)) {
          safeEnv[key] = value;
        } else if (this.debug) {
          debugLog('Blocked override of critical env var:', { key });
        }
      }
    }

    const { ptyProcess, terminal, stateTracker } = OtelTracing.trace(
      SpanName.DAEMON_TERMINAL_CREATE,
      () => {
        let pty: IPty;
        try {
          pty = spawn(this.defaultShell, [], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd: resolvedPath,
            env: safeEnv,
          });
        } catch (error) {
          throw new MetaError('Failed to spawn terminal with shell', {
            cause: error,
            cwd: resolvedPath,
          });
        }

        const tracker = new TerminalStateTracker(cols, rows);
        const term: Terminal = {
          id: terminalId,
          pty,
          stateTracker: tracker,
          createdAt: new Date(),
          lastActivity: new Date(),
        };

        try {
          this.terminals.set(terminalId, term);
          this.terminalToSession.set(terminalId, sessionId);
        } catch (error) {
          pty.kill();
          throw new MetaError('Failed to register terminal', {
            cause: error,
            terminalId,
          });
        }

        return { ptyProcess: pty, terminal: term, stateTracker: tracker };
      }
    );

    logInfo('Terminal created', {
      terminalId,
      sessionId,
      pid: ptyProcess.pid ?? null,
    });

    // Set up event handlers
    ptyProcess.onData((data: string) => {
      terminal.lastActivity = new Date();

      // Process output through state tracker to maintain rendered buffer
      stateTracker.processOutput(data);

      this.emit(DaemonTerminalEvent.DATA, terminalId, data);
    });

    ptyProcess.onExit(
      (exitInfo: { exitCode: number; signal?: string | number }) => {
        // Track abnormal exits (non-zero exit code or killed by signal)
        const isAbnormal = exitInfo.exitCode !== 0 || exitInfo.signal;
        if (isAbnormal) {
          Metrics.addToCounter(Metric.DAEMON_TERMINAL_ABNORMAL_EXIT_COUNT, 1);
        }

        this.emit(
          DaemonTerminalEvent.EXIT,
          terminalId,
          exitInfo.exitCode,
          exitInfo.signal || 'SIGTERM'
        );
        this.terminals.delete(terminalId);
        this.terminalToSession.delete(terminalId);

        logInfo('Terminal exited', {
          terminalId,
          exitCode: exitInfo.exitCode,
          signal: exitInfo.signal,
        });
      }
    );
  }

  writeData(terminalId: string, data: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      if (this.debug) {
        debugLog('Terminal write failed - not found:', { terminalId });
      }
      return false;
    }

    try {
      terminal.lastActivity = new Date();
      terminal.pty.write(data);
      return true;
    } catch (error) {
      logException(error, 'Terminal write error', { terminalId });
      // Clean up the dead terminal
      this.closeTerminal(terminalId);
      return false;
    }
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      if (this.debug) {
        debugLog('Terminal resize failed - not found:', { terminalId });
      }
      return false;
    }

    terminal.lastActivity = new Date();
    terminal.pty.resize(cols, rows);
    terminal.stateTracker.resize(cols, rows);

    if (this.debug) {
      debugLog('Terminal resized', { terminalId, size: `(${cols}, ${rows})` });
    }

    return true;
  }

  closeTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return false;
    }

    terminal.pty.kill();
    terminal.stateTracker.dispose();
    this.terminals.delete(terminalId);
    this.terminalToSession.delete(terminalId);

    if (this.debug) {
      debugLog('Terminal closed:', { terminalId });
    }

    return true;
  }

  getTerminal(terminalId: string): Terminal | undefined {
    return this.terminals.get(terminalId);
  }

  listTerminals(): TerminalInfo[] {
    return Array.from(this.terminals.values()).map((terminal) => {
      const state = terminal.stateTracker.captureSnapshot();
      return {
        id: terminal.id,
        pid: terminal.pty.pid ?? null,
        cols: terminal.pty.cols,
        rows: terminal.pty.rows,
        createdAt: terminal.createdAt,
        state: {
          serialized: state.serialized,
          plainText: state.plainText,
          cols: state.cols,
          rows: state.rows,
          timestamp: state.timestamp,
          cursorHidden: state.cursorHidden,
        },
      };
    });
  }

  listTerminalsForSession(sessionId: string): TerminalInfo[] {
    const sessionTerminals = Array.from(this.terminals.values()).filter(
      (terminal) => this.terminalToSession.get(terminal.id) === sessionId
    );

    if (this.debug) {
      debugLog('Listing terminals for session:', {
        sessionId,
        count: sessionTerminals.length,
      });
    }

    return sessionTerminals.map((terminal) => {
      const state = terminal.stateTracker.captureSnapshot();
      return {
        id: terminal.id,
        pid: terminal.pty.pid ?? null,
        cols: terminal.pty.cols,
        rows: terminal.pty.rows,
        createdAt: terminal.createdAt,
        state: {
          serialized: state.serialized,
          plainText: state.plainText,
          cols: state.cols,
          rows: state.rows,
          timestamp: state.timestamp,
          cursorHidden: state.cursorHidden,
        },
      };
    });
  }

  closeAllTerminals(): void {
    for (const [terminalId, terminal] of this.terminals) {
      try {
        terminal.pty.kill();
        terminal.stateTracker.dispose();
        logInfo('Closing terminal', { terminalId });
      } catch (error) {
        logException(error, 'Terminal error closing', { terminalId });
      }
    }
    this.terminals.clear();
    this.terminalToSession.clear();
  }

  /**
   * Get the sessionId associated with a terminal
   */
  getSessionId(terminalId: string): string | undefined {
    return this.terminalToSession.get(terminalId);
  }

  getTerminalCount(): number {
    return this.terminals.size;
  }

  /**
   * Registers a new WebSocket client, initializing an empty set of terminals for it.
   * Safe to call multiple times for the same client.
   */
  registerClient(context: IAuthedDaemonConnection): void {
    if (!this.terminalsOwnedByClient.has(context)) {
      this.terminalsOwnedByClient.set(context, new Set());
    }
  }

  /**
   * Unregisters a client and cleans up all its terminals from both mappings.
   * @returns Array of terminal IDs that were owned by this client
   */
  unregisterClient(context: IAuthedDaemonConnection): string[] {
    const terminals = this.terminalsOwnedByClient.get(context);
    if (!terminals) {
      return [];
    }

    const terminalIds = Array.from(terminals);
    for (const terminalId of terminalIds) {
      this.disassociateTerminal(context, terminalId);
    }

    this.terminalsOwnedByClient.delete(context);
    return terminalIds;
  }

  /**
   * Associates a terminal with a client, updating both bidirectional mappings.
   * Automatically registers the client if not already registered.
   */
  associateTerminal(
    context: IAuthedDaemonConnection,
    terminalId: string
  ): void {
    this.registerClient(context);
    this.cleanupScheduler.cancel(terminalId);

    const terminals = this.terminalsOwnedByClient.get(context)!;
    terminals.add(terminalId);

    if (!this.clientsOwningTerminal.has(terminalId)) {
      this.clientsOwningTerminal.set(terminalId, new Set());
    }
    this.clientsOwningTerminal.get(terminalId)!.add(context);
  }

  /**
   * Removes the association between a client and a terminal.
   * Cleans up empty entries in both mappings.
   */
  disassociateTerminal(
    context: IAuthedDaemonConnection,
    terminalId: string
  ): void {
    const terminals = this.terminalsOwnedByClient.get(context);
    if (terminals) {
      terminals.delete(terminalId);
      if (terminals.size === 0) {
        this.terminalsOwnedByClient.delete(context);
      }
    }

    const clients = this.clientsOwningTerminal.get(terminalId);
    if (clients) {
      clients.delete(context);
      if (clients.size === 0) {
        this.clientsOwningTerminal.delete(terminalId);
      }
    }
  }

  /**
   * Removes a terminal from all clients that own it.
   * @returns Set of WebSocket clients that were associated with this terminal
   */
  removeTerminalAssociations(terminalId: string): Set<IAuthedDaemonConnection> {
    this.cleanupScheduler.cancel(terminalId);
    const clients =
      this.clientsOwningTerminal.get(terminalId) ||
      new Set<IAuthedDaemonConnection>();

    for (const context of clients) {
      const terminals = this.terminalsOwnedByClient.get(context);
      if (terminals) {
        terminals.delete(terminalId);
        if (terminals.size === 0) {
          this.terminalsOwnedByClient.delete(context);
        }
      }
    }

    this.clientsOwningTerminal.delete(terminalId);
    return clients;
  }

  /**
   * Checks if a specific client owns a specific terminal.
   * Used for authorization checks before allowing operations.
   */
  ownsTerminal(context: IAuthedDaemonConnection, terminalId: string): boolean {
    const terminals = this.terminalsOwnedByClient.get(context);
    return terminals ? terminals.has(terminalId) : false;
  }

  /**
   * Gets all clients that own a specific terminal.
   * @returns Set of WebSocket clients (empty set if terminal has no clients)
   */
  getClientsForTerminal(terminalId: string): Set<IAuthedDaemonConnection> {
    return this.clientsOwningTerminal.get(terminalId) || new Set();
  }

  /**
   * Returns the total number of registered clients.
   */
  getClientCount(): number {
    return this.terminalsOwnedByClient.size;
  }

  /**
   * Schedule terminal cleanup after disconnect grace period.
   */
  scheduleTerminalCleanup(terminalId: string, cleanup: () => void): void {
    this.cleanupScheduler.schedule(terminalId, cleanup);
  }

  /**
   * Check if a terminal has a pending cleanup scheduled (in grace period).
   */
  hasPendingCleanup(terminalId: string): boolean {
    return this.cleanupScheduler.hasPendingCleanup(terminalId);
  }

  /**
   * Check if a terminal is truly orphaned (no owners AND no pending cleanup).
   * Terminals in grace period (pending cleanup) are not considered orphaned.
   */
  isOrphaned(terminalId: string): boolean {
    const owners = this.getClientsForTerminal(terminalId);
    return (
      owners.size === 0 && !this.cleanupScheduler.hasPendingCleanup(terminalId)
    );
  }

  /**
   * Start periodic orphan cleanup.
   */
  startOrphanCleanup(params: {
    intervalMs: number;
    /** Called for each orphaned terminal */
    onOrphanFound: (terminalId: string) => void;
  }): void {
    const { intervalMs, onOrphanFound } = params;

    this.cleanupScheduler.startOrphanCleanup(intervalMs, () => {
      for (const terminalId of this.terminals.keys()) {
        if (this.isOrphaned(terminalId)) {
          onOrphanFound(terminalId);
        }
      }
    });
  }

  /**
   * Stop periodic orphan cleanup.
   */
  stopOrphanCleanup(): void {
    this.cleanupScheduler.stopOrphanCleanup();
  }
}
