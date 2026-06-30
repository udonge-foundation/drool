import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { JETBRAINS_IDE_NOT_CONNECTED_MESSAGE } from '@industry/common/cli';
import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { IdeFileInfo, IdeSelection, IdeDiagnostic } from '@/hooks/types';
import type { McpTool } from '@/mcp/schema';

interface JetBrainsIdeClientOptions {
  onActiveFileChange?: (file: IdeFileInfo, selection: IdeSelection) => void;
  onOpenFilesChange?: (files: IdeFileInfo[]) => void;
  onDiagnosticsChange?: (
    filePath: string,
    diagnostics: IdeDiagnostic[]
  ) => void;
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

const DiagnosticItemSchema = z.object({
  severity: z.union([z.number(), z.string()]),
  message: z.string(),
  source: z.string().optional(),
  range: z.object({
    start: z.object({ line: z.number(), character: z.number() }),
    end: z.object({ line: z.number(), character: z.number() }),
  }),
  code: z.any().optional(),
});

// Accept both per-file format ({ filePath, diagnostics }) and aggregate format
// ({ allDiagnostics }) sent by the JetBrains plugin's DiagnosticsManager.getState()
const DiagnosticsNotificationSchema = z.object({
  method: z.literal('notifications/diagnostics'),
  params: z.object({
    filePath: z.string().optional(),
    diagnostics: z.array(DiagnosticItemSchema).optional(),
    allDiagnostics: z
      .array(
        z.object({
          filePath: z.string(),
          diagnostics: z.array(DiagnosticItemSchema).optional(),
          errorCount: z.number().optional(),
          warningCount: z.number().optional(),
          infoCount: z.number().optional(),
          hintCount: z.number().optional(),
        })
      )
      .optional(),
    totalErrors: z.number().optional(),
    totalWarnings: z.number().optional(),
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

type ActiveFileNotification = z.infer<typeof ActiveFileNotificationSchema>;
type DiagnosticsNotification = z.infer<typeof DiagnosticsNotificationSchema>;
type OpenFilesNotification = z.infer<typeof OpenFilesNotificationSchema>;

/**
 * Convert JetBrains severity strings ("ERROR", "WARNING", etc.) to the
 * numeric DiagnosticSeverity values used by IdeDiagnostic.
 * Values follow the LSP DiagnosticSeverity enum (1=Error, 2=Warning, 3=Info, 4=Hint).
 */
function severityStringToNumber(severity: string): number {
  switch (severity.toUpperCase()) {
    case 'ERROR':
      return 1;
    case 'WARNING':
      return 2;
    case 'INFO':
    case 'INFORMATION':
      return 3;
    case 'HINT':
      return 4;
    default:
      return 3; // Default to Info
  }
}

export class JetBrainsIdeClient {
  private client: Client | null = null;

  private transport: StreamableHTTPClientTransport | null = null;

  private connected = false;

  private options: JetBrainsIdeClientOptions;

  private availableTools: McpTool[] = [];

  constructor(options: JetBrainsIdeClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const port = process.env.INDUSTRY_JETBRAINS_MCP_PORT;
    if (!port) {
      throw new MetaError(
        'INDUSTRY_JETBRAINS_MCP_PORT environment variable not set',
        { key: 'INDUSTRY_JETBRAINS_MCP_PORT' }
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
      logException(error, '[JetBrains IDE Client] Transport error');
    };

    this.transport.onclose = () => {
      this.connected = false;
    };

    this.client = new Client(
      { name: 'industry-cli-jetbrains-client', version: '1.0.0' },
      { capabilities: {} }
    );

    this.client.onerror = (error) => {
      logException(error, '[JetBrains IDE Client] Client error');
    };

    this.setupNotificationHandlers();

    await this.client.connect(this.transport);

    this.connected = true;

    // Discover available tools
    await this.discoverTools();
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
      logException(error, '[JetBrains IDE Client] Failed to discover tools');
      this.availableTools = [];
    }
  }

  private setupNotificationHandlers(): void {
    if (!this.client) {
      return;
    }

    // Handle active file changes
    this.client.setNotificationHandler(
      ActiveFileNotificationSchema,
      (notification: ActiveFileNotification) => {
        try {
          const { params } = notification;
          const fileInfo: IdeFileInfo = {
            path: params.path,
            fileName: params.fileName,
            isDirty: params.isDirty,
            languageId: '', // JetBrains doesn't provide languageId in this notification
          };
          const selection: IdeSelection = {
            startLine: params.selection.startLine,
            startCharacter: params.selection.startCharacter,
            endLine: params.selection.endLine,
            endCharacter: params.selection.endCharacter,
            selectedText: params.selection.selectedText,
          };
          this.options.onActiveFileChange?.(fileInfo, selection);
        } catch (error) {
          logException(
            error,
            '[JetBrains IDE Client] Error handling active file notification'
          );
        }
      }
    );

    // Handle diagnostics changes
    // The JetBrains plugin may send either per-file format ({ filePath, diagnostics })
    // or aggregate format ({ allDiagnostics: [{ filePath, diagnostics, ... }] })
    this.client.setNotificationHandler(
      DiagnosticsNotificationSchema,
      (notification: DiagnosticsNotification) => {
        try {
          const { params } = notification;

          const toIdeDiagnostics = (
            items: DiagnosticsNotification['params']['diagnostics']
          ): IdeDiagnostic[] =>
            (items ?? []).map((d) => ({
              severity:
                typeof d.severity === 'string'
                  ? severityStringToNumber(d.severity)
                  : d.severity,
              message: d.message,
              source: d.source,
              range: d.range,
              code: d.code,
            }));

          if (params.filePath && params.diagnostics) {
            // Per-file format (same as VSCode)
            this.options.onDiagnosticsChange?.(
              params.filePath,
              toIdeDiagnostics(params.diagnostics)
            );
          } else if (params.allDiagnostics) {
            // Aggregate format from DiagnosticsManager.getState()
            for (const entry of params.allDiagnostics) {
              this.options.onDiagnosticsChange?.(
                entry.filePath,
                toIdeDiagnostics(entry.diagnostics)
              );
            }
          }
          // If neither format matched, silently ignore — no fields to process
        } catch (error) {
          logException(
            error,
            '[JetBrains IDE Client] Error handling diagnostics notification'
          );
        }
      }
    );

    // Handle open files changes
    this.client.setNotificationHandler(
      OpenFilesNotificationSchema,
      (notification: OpenFilesNotification) => {
        try {
          const { params } = notification;
          const files: IdeFileInfo[] = params.files.map((f) => ({
            path: f.path,
            fileName: f.fileName,
            isDirty: f.isDirty,
            languageId: f.languageId,
          }));
          this.options.onOpenFilesChange?.(files);
        } catch (error) {
          logException(
            error,
            '[JetBrains IDE Client] Error handling open files notification'
          );
        }
      }
    );
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getAvailableTools(): McpTool[] {
    return this.availableTools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client || !this.connected) {
      throw new MetaError(JETBRAINS_IDE_NOT_CONNECTED_MESSAGE, {
        actionType: 'callTool',
        toolName: name,
      });
    }

    const response = await this.client.request(
      {
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
      },
      CallToolResultSchema
    );

    // Convert response to string format (matching IdeClient behavior)
    if (response.content && response.content.length > 0) {
      const firstContent = response.content[0];
      if (firstContent.type === 'text') {
        return firstContent.text;
      }
    }
    return JSON.stringify(response);
  }

  async getIdeDiagnostics(uri: string): Promise<IdeDiagnostic[]> {
    try {
      const result = await this.callTool('getIdeDiagnostics', { uri });

      // Result is now a string (JSON)
      try {
        const diagnosticsData = JSON.parse(result);
        return diagnosticsData.diagnostics || [];
      } catch (parseError) {
        logException(
          parseError,
          '[JetBrains IDE Client] Failed to parse diagnostics'
        );
        return [];
      }
    } catch (error) {
      logException(
        error,
        '[JetBrains IDE Client] Failed to get IDE diagnostics'
      );
      return [];
    }
  }

  async openDiff(
    filePath: string,
    newContent: string
  ): Promise<{ success: boolean }> {
    try {
      const result = await this.callTool('openDiff', { filePath, newContent });

      // Result is now a string (JSON)
      try {
        const response = JSON.parse(result);
        return { success: response.success || false };
      } catch {
        return { success: false };
      }
    } catch (error) {
      logException(error, '[JetBrains IDE Client] Failed to open diff');
      return { success: false };
    }
  }

  async closeDiff(filePath: string): Promise<{ success: boolean }> {
    try {
      const result = await this.callTool('closeDiff', { filePath });

      // Result is now a string (JSON)
      try {
        const response = JSON.parse(result);
        return { success: response.success || false };
      } catch {
        return { success: false };
      }
    } catch (error) {
      logException(error, '[JetBrains IDE Client] Failed to close diff');
      return { success: false };
    }
  }
}
