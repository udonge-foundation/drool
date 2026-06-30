import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { VSCODE_IDE_NOT_CONNECTED_MESSAGE } from '@industry/common/cli';
import { logException, logInfo, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { IdeFileInfo, IdeSelection, IdeDiagnostic } from '@/hooks/types';
import type { McpTool } from '@/mcp/schema';

interface IdeClientOptions {
  onActiveFileChange?: (file: IdeFileInfo, selection: IdeSelection) => void;
  onOpenFilesChange?: (files: IdeFileInfo[]) => void;
  onDiagnosticsChange?: (
    filePath: string,
    diagnostics: IdeDiagnostic[]
  ) => void;
  onDisconnect?: () => void;
}

const ActiveFileNotificationSchema = z.object({
  method: z.literal('notifications/activeFile'),
  params: z.object({
    path: z.string(),
    fileName: z.string(),
    isDirty: z.boolean(),
    lineCount: z.number(),
    selection: z.object({
      startLine: z.number(),
      startCharacter: z.number(),
      endLine: z.number(),
      endCharacter: z.number(),
      selectedText: z.string(),
    }),
  }),
});

const DiagnosticsNotificationSchema = z.object({
  method: z.literal('notifications/diagnostics'),
  params: z.object({
    filePath: z.string(),
    diagnostics: z.array(
      z.object({
        severity: z.number(),
        message: z.string(),
        source: z.string().optional(),
        range: z.object({
          start: z.object({ line: z.number(), character: z.number() }),
          end: z.object({ line: z.number(), character: z.number() }),
        }),
        code: z.any().optional(),
      })
    ),
  }),
});

const OpenFilesNotificationSchema = z.object({
  method: z.literal('notifications/openFiles'),
  params: z.object({
    files: z.array(
      z.object({
        path: z.string(),
        fileName: z.string(),
        isDirty: z.boolean(),
        languageId: z.string(),
      })
    ),
  }),
});

const HeartbeatNotificationSchema = z.object({
  method: z.literal('notifications/heartbeat'),
  params: z.object({
    timestamp: z.number(),
  }),
});

type ActiveFileNotification = z.infer<typeof ActiveFileNotificationSchema>;
type DiagnosticsNotification = z.infer<typeof DiagnosticsNotificationSchema>;
type OpenFilesNotification = z.infer<typeof OpenFilesNotificationSchema>;

export class VSCodeIdeClient {
  private client: Client | null = null;

  private transport: StreamableHTTPClientTransport | null = null;

  private connected = false;

  private options: IdeClientOptions;

  private availableTools: McpTool[] = [];

  private lastHeartbeatTime: number = 0;

  private heartbeatCheckInterval: NodeJS.Timeout | null = null;

  private readonly HEARTBEAT_TIMEOUT_MS = 75000; // 75s (60s interval + 15s buffer)

  constructor(options: IdeClientOptions) {
    this.options = options;
  }

  async connect(portOverride?: number): Promise<void> {
    const port = portOverride ?? process.env.INDUSTRY_VSCODE_MCP_PORT;
    if (!port) {
      throw new MetaError(
        'No port provided and INDUSTRY_VSCODE_MCP_PORT environment variable not set'
      );
    }

    // Add a small delay to ensure server is fully ready
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });

    const serverUrl = `http://localhost:${port}/mcp`;

    // Create transport - let SDK handle session management
    this.transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    // Set up transport error handling
    this.transport.onerror = (error) => {
      logException(error, '[IDE Client] Transport error');
    };

    this.transport.onclose = () => {
      // Only call onDisconnect if we had a successful connection that was lost
      // Don't call it during initial connection setup failure
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        this.options.onDisconnect?.();
      }
    };

    this.client = new Client(
      { name: 'industry-cli-mcp-client', version: '1.0.0' },
      { capabilities: {} }
    );

    this.client.onerror = (error) => {
      logWarn('[IDE Client] Client error', {
        cause: error,
      });
      // Trigger disconnect on error - connection may be broken
      if (this.connected) {
        this.connected = false;
        this.options.onDisconnect?.();
      }
    };

    this.setupNotificationHandlers();

    await this.client.connect(this.transport);

    this.connected = true;

    // Discover available tools
    await this.discoverTools();

    // Start heartbeat check to detect dead connections
    this.startHeartbeatCheck();
  }

  private async discoverTools(): Promise<void> {
    if (!this.client || !this.connected) {
      return;
    }

    try {
      const response = await this.client.request(
        { method: 'tools/list' },
        ListToolsResultSchema
      );
      this.availableTools = response.tools || [];
    } catch (error) {
      logException(error, '[IDE Client] Failed to discover tools');
      this.availableTools = [];
    }
  }

  getAvailableTools(): McpTool[] {
    return this.availableTools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client || !this.connected) {
      throw new MetaError(VSCODE_IDE_NOT_CONNECTED_MESSAGE);
    }

    // Determine timeout based on tool and args
    // openFile with waitForSave needs 30 minutes, other tools use 3 seconds
    const isLongRunning = name === 'openFile' && Boolean(args.waitForSave);
    const timeoutMs = isLongRunning ? 30 * 60 * 1000 : 3000;

    // Create a timeout promise that rejects after the timeout
    let timeoutId: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new MetaError(
            `MCP tool call timed out after ${timeoutMs / 1000} seconds`,
            {
              toolName: name,
            }
          )
        );
      }, timeoutMs);
    });

    try {
      // Race between the actual request and the timeout
      const response = await Promise.race([
        this.client.request(
          {
            method: 'tools/call',
            params: {
              name,
              arguments: args,
            },
          },
          CallToolResultSchema
        ),
        timeoutPromise,
      ]);

      return response.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { type: 'text'; text: string }).text)
        .join('\n');
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private setupNotificationHandlers(): void {
    if (!this.client) return;

    this.client.setNotificationHandler(
      ActiveFileNotificationSchema,
      (notification: ActiveFileNotification) => {
        try {
          this.handleActiveFileNotification(notification);
        } catch (error) {
          logException(
            error,
            '[IDE Client] Error handling active file notification'
          );
        }
      }
    );

    this.client.setNotificationHandler(
      DiagnosticsNotificationSchema,
      (notification: DiagnosticsNotification) => {
        try {
          this.handleDiagnosticsNotification(notification);
        } catch (error) {
          logException(
            error,
            '[IDE Client] Error handling diagnostics notification'
          );
        }
      }
    );

    this.client.setNotificationHandler(
      OpenFilesNotificationSchema,
      (notification: OpenFilesNotification) => {
        try {
          this.handleOpenFilesNotification(notification);
        } catch (error) {
          logException(
            error,
            '[IDE Client] Error handling open files notification'
          );
        }
      }
    );

    this.client.setNotificationHandler(HeartbeatNotificationSchema, () => {
      this.lastHeartbeatTime = Date.now();
    });
  }

  private startHeartbeatCheck(): void {
    this.lastHeartbeatTime = Date.now();
    this.heartbeatCheckInterval = setInterval(() => {
      if (!this.connected) return;
      const elapsed = Date.now() - this.lastHeartbeatTime;
      if (elapsed > this.HEARTBEAT_TIMEOUT_MS) {
        logInfo('[IDE Client] Connection lost - no heartbeat received', {
          durationMs: elapsed,
          timeout: this.HEARTBEAT_TIMEOUT_MS,
        });
        this.connected = false;
        this.options.onDisconnect?.();
        this.stopHeartbeatCheck();
      }
    }, 5000); // Check every 5 seconds
  }

  private stopHeartbeatCheck(): void {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
      this.heartbeatCheckInterval = null;
    }
  }

  private handleActiveFileNotification(
    notification: ActiveFileNotification
  ): void {
    const { params } = notification;

    // Update IDE context store if callback is provided
    if (this.options.onActiveFileChange) {
      const fileInfo: IdeFileInfo = {
        path: params.path,
        fileName: params.fileName,
        isDirty: params.isDirty,
      };

      const selection: IdeSelection = {
        startLine: params.selection.startLine,
        startCharacter: params.selection.startCharacter,
        endLine: params.selection.endLine,
        endCharacter: params.selection.endCharacter,
        selectedText: params.selection.selectedText,
      };

      this.options.onActiveFileChange(fileInfo, selection);
    }
  }

  private handleDiagnosticsNotification(
    notification: DiagnosticsNotification
  ): void {
    const { params } = notification;

    // Update IDE context store if callback is provided
    if (this.options.onDiagnosticsChange) {
      this.options.onDiagnosticsChange(params.filePath, params.diagnostics);
    }
  }

  private handleOpenFilesNotification(
    notification: OpenFilesNotification
  ): void {
    const { params } = notification;

    // Update IDE context store if callback is provided
    if (this.options.onOpenFilesChange) {
      const files: IdeFileInfo[] = params.files.map((file) => ({
        path: file.path,
        fileName: file.fileName,
        isDirty: file.isDirty,
        languageId: file.languageId,
      }));
      this.options.onOpenFilesChange(files);
    }
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeatCheck();

    if (this.connected) {
      try {
        if (this.client) {
          await this.client.close();
        }
        if (this.transport) {
          await this.transport.close();
        }
        logInfo('[IDE Client] Disconnected from VS Code MCP server');
      } catch (error) {
        logException(error, '[IDE Client] Error during disconnect');
      }
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async openDiff(filePath: string, newContent: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new MetaError(VSCODE_IDE_NOT_CONNECTED_MESSAGE);
    }

    await this.callTool('openDiff', { filePath, newContent });
  }

  async closeDiff(filePath: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new MetaError(VSCODE_IDE_NOT_CONNECTED_MESSAGE);
    }

    await this.callTool('closeDiff', { filePath });
  }

  async openFile(filePath: string, waitForSave?: boolean): Promise<void> {
    if (!this.client || !this.connected) {
      throw new MetaError(VSCODE_IDE_NOT_CONNECTED_MESSAGE);
    }

    await this.callTool('openFile', { filePath, waitForSave });
  }
}
