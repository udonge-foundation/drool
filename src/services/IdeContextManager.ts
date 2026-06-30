import { logException, logInfo } from '@industry/logging';

import { IdeFileInfo, IdeSelection, IdeDiagnostic } from '@/hooks/types';
import { JetBrainsIdeClient } from '@/services/JetBrainsIdeClient';
import { getSettingsService } from '@/services/SettingsService';
import { VSCodeIdeClient } from '@/services/VSCodeIdeClient';
import { SHUTDOWN_HOOK_PRIORITY } from '@/utils/constants';
import { ideDetector } from '@/utils/ide-detector';
import {
  findMatchingIdeInstance,
  IdeLockFileData,
} from '@/utils/ide-lock-files';
import { getShutdownCoordinator } from '@/utils/shutdownCoordinator';

class IdeContextManager {
  // eslint-disable-next-line no-use-before-define
  private static instance: IdeContextManager | null = null;

  private ideClient: VSCodeIdeClient | JetBrainsIdeClient | null = null;

  private ideType: 'vscode' | 'jetbrains' | null = null;

  private connectedInstanceInfo: IdeLockFileData | null = null;

  private initialized = false;

  private callbacks: {
    onActiveFileChange?: (file: IdeFileInfo, selection: IdeSelection) => void;
    onOpenFilesChange?: (files: IdeFileInfo[]) => void;
    onDiagnosticsChange?: (
      filePath: string,
      diagnostics: IdeDiagnostic[]
    ) => void;
    onDisconnect?: () => void;
  } = {};

  private processHandlersRegistered = false;

  // eslint-disable-next-line no-useless-constructor, no-empty-function
  private constructor() {}

  public static getInstance(): IdeContextManager {
    if (!IdeContextManager.instance) {
      IdeContextManager.instance = new IdeContextManager();
    }
    return IdeContextManager.instance;
  }

  async initialize(callbacks: {
    onActiveFileChange: (file: IdeFileInfo, selection: IdeSelection) => void;
    onOpenFilesChange: (files: IdeFileInfo[]) => void;
    onDiagnosticsChange: (
      filePath: string,
      diagnostics: IdeDiagnostic[]
    ) => void;
    onDisconnect?: () => void;
  }): Promise<VSCodeIdeClient | JetBrainsIdeClient | undefined> {
    if (this.initialized) {
      return this.ideClient || undefined;
    }

    this.callbacks = callbacks;

    // Priority 1: Check for VSCode MCP port from environment variable
    if (process.env.INDUSTRY_VSCODE_MCP_PORT) {
      const port = parseInt(process.env.INDUSTRY_VSCODE_MCP_PORT, 10);
      const client = await this.connectToPort(port);
      if (client) {
        return client;
      }
    }

    // Priority 2: Check for JetBrains
    if (process.env.INDUSTRY_JETBRAINS_MCP_PORT) {
      try {
        const client = new JetBrainsIdeClient({
          onActiveFileChange: callbacks.onActiveFileChange,
          onOpenFilesChange: callbacks.onOpenFilesChange,
          onDiagnosticsChange: callbacks.onDiagnosticsChange,
        });

        await client.connect();
        this.ideClient = client;
        this.ideType = 'jetbrains';
        this.initialized = true;
        logInfo('[IDE Context] Connected to JetBrains IDE');

        this.setupProcessHandlers();
        return client;
      } catch (error) {
        logException(error, 'Failed to initialize JetBrains MCP client');
      }
    }

    // Priority 3: Auto-connect from lock files
    // If running inside VS Code terminal, auto-connect regardless of settings
    // If outside VS Code terminal, check ideAutoConnect setting
    const isInIdeTerminal = ideDetector.isRunningInSupportedIde();
    const ideAutoConnect = getSettingsService().getIdeAutoConnect();

    if (isInIdeTerminal || ideAutoConnect) {
      const cwd = process.cwd();
      // Get preferred IDE name if running inside an IDE terminal
      const preferredIdeName = isInIdeTerminal
        ? ideDetector.detectIde().displayName
        : undefined;

      const matchingInstance = await findMatchingIdeInstance(
        cwd,
        preferredIdeName
      );

      if (matchingInstance) {
        logInfo('[IDE Context] Found matching IDE instance from lock file', {
          clientType: matchingInstance.ideName,
          port: matchingInstance.port,
          paths: matchingInstance.workspaceFolders,
        });

        const client = await this.connectToPort(
          matchingInstance.port,
          matchingInstance
        );
        if (client) {
          return client;
        }
      }
    }

    this.initialized = true;
    return undefined;
  }

  /**
   * Connect to a VS Code MCP server on the specified port.
   * Can be called manually from /ide command or automatically during initialization.
   */
  async connectToPort(
    port: number,
    instanceInfo?: IdeLockFileData
  ): Promise<VSCodeIdeClient | undefined> {
    // Disconnect existing client if connected
    if (this.ideClient) {
      await this.cleanup();
    }

    try {
      const client = new VSCodeIdeClient({
        onActiveFileChange: this.callbacks.onActiveFileChange,
        onOpenFilesChange: this.callbacks.onOpenFilesChange,
        onDiagnosticsChange: this.callbacks.onDiagnosticsChange,
        onDisconnect: () => {
          // Clear the stale client reference so subsequent tool calls
          // don't reuse a dead MCP connection (FAC-18854). We keep the
          // instance info cleared alongside it.
          this.handleClientDisconnect();
          this.callbacks.onDisconnect?.();
        },
      });

      await client.connect(port);
      this.ideClient = client;
      this.ideType = 'vscode';
      this.connectedInstanceInfo = instanceInfo || null;
      this.initialized = true;

      const ideName = instanceInfo?.ideName || 'VS Code';
      logInfo('[IDE Context] Connected to IDE', {
        clientType: ideName,
        port,
      });

      this.setupProcessHandlers();
      return client;
    } catch (error) {
      logException(error, 'Failed to connect to VS Code MCP', {
        port,
      });
      return undefined;
    }
  }

  private setupProcessHandlers(): void {
    if (this.processHandlersRegistered) return;
    this.processHandlersRegistered = true;

    const shutdownCoordinator = getShutdownCoordinator();
    shutdownCoordinator.registerHook(
      'ide-context',
      async () => {
        await this.cleanup();
      },
      { priority: SHUTDOWN_HOOK_PRIORITY.IdeContext }
    );
  }

  async cleanup(): Promise<void> {
    if (this.ideClient) {
      try {
        await this.ideClient.disconnect();
      } catch (error) {
        logException(error, 'Error disconnecting MCP client');
      }
      this.ideClient = null;
    }
    this.connectedInstanceInfo = null;
    this.initialized = false;
  }

  /**
   * Clear the stale IDE client reference after an unexpected disconnect
   * (heartbeat timeout, transport close, client error). This is intentionally
   * synchronous and does not call `disconnect()` on the client because the
   * underlying MCP transport is already gone. Keeping a stale, non-null
   * reference causes every subsequent `callTool` to throw "MCP client not
   * connected" (FAC-18854).
   */
  private handleClientDisconnect(): void {
    this.ideClient = null;
    this.connectedInstanceInfo = null;
    // Allow re-initialization (e.g. from /ide reconnect) to take effect.
    this.initialized = false;
  }

  getIdeClient(): VSCodeIdeClient | JetBrainsIdeClient | null {
    return this.ideClient;
  }

  getIdeType(): 'vscode' | 'jetbrains' | null {
    return this.ideType;
  }

  getConnectedInstanceInfo(): IdeLockFileData | null {
    return this.connectedInstanceInfo;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // Reset the singleton (useful for testing)
  static reset(): void {
    IdeContextManager.instance = null;
  }
}

export { IdeContextManager };
