import { logInfo, logWarn } from '@industry/logging';

import {
  buildToolInputContent,
  buildToolLocations,
  buildToolResultContent,
  generateToolTitle,
  mapTodoPriority,
  mapTodoStatus,
  parseTodoParams,
} from '@/acp/protocol/translator';
import { buildModelState } from '@/acp/session/models';
import { buildAcpSessionConfigState } from '@/acp/session/state';
import {
  buildPermissionRequestPayload,
  permissionResponseToOutcome,
} from '@/acp/tools/permissions';
import { inferToolKind } from '@/acp/tools/utils';
import { processConfirmationOutcome } from '@/agent/tool-confirmation';
import { SessionController } from '@/controllers/SessionController';
import {
  AgentEvent,
  agentEventBus,
  subscribeToMultipleAgentEvents,
} from '@/events/AgentEventBus';
import { getSessionService } from '@/services/SessionService';

import type {
  AgentSideConnection,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type {
  ToolConfirmationInfo,
  ToolConfirmationListItem,
} from '@industry/drool-sdk-ext/protocol/drool';

/**
 * AcpProtocolAdapter translates AgentEventBus events to ACP protocol.
 *
 * This adapter subscribes to the shared event bus and calls the ACP
 * connection methods to emit updates. It handles all protocol-specific
 * formatting while delegating business logic to shared components.
 *
 * Usage:
 * ```typescript
 * const adapter = new AcpProtocolAdapter(sessionController, connection, acpSessionId);
 * // Events from agentEventBus are automatically translated to ACP updates
 *
 * // Clean up when done
 * adapter.dispose();
 * ```
 */
export class AcpProtocolAdapter {
  private unsubscribe: (() => void) | null = null;

  /**
   * Track pending tool calls to know the tool name when ToolCallComplete fires.
   * Maps tool ID to { name, input }.
   */
  private pendingToolCalls = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();

  private deliveredToolCalls = new Set<string>();

  private toolCallStartDeliveries = new Map<string, Promise<boolean>>();

  /**
   * Track which tool calls have embedded terminals to avoid duplicate terminal embedding.
   */
  private embeddedTerminals = new Set<string>();

  constructor(
    private sessionController: SessionController,
    private connection: AgentSideConnection,
    private sessionId: string
  ) {
    this.setupEventSubscriptions();
  }

  /**
   * Update the session ID (e.g., when loading a different session)
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Set up subscriptions to AgentEventBus events
   */
  private setupEventSubscriptions(): void {
    this.unsubscribe = subscribeToMultipleAgentEvents({
      [AgentEvent.AssistantTextDelta]: async (params) => {
        try {
          await this.connection.sessionUpdate({
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: params.textDelta },
            },
          });
        } catch (error) {
          logWarn('[AcpAdapter] Failed to send text delta', { cause: error });
        }
      },

      [AgentEvent.ThinkingTextDelta]: async (params) => {
        try {
          await this.connection.sessionUpdate({
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: params.textDelta },
            },
          });
        } catch (error) {
          logWarn('[AcpAdapter] Failed to send thinking delta', {
            cause: error,
          });
        }
      },

      [AgentEvent.ToolCallStart]: async (params) => {
        // Buffer tool call - don't send notification yet. Input is incomplete.
        this.pendingToolCalls.set(params.id, {
          name: params.name,
          input: params.input,
        });

        logInfo('[AcpAdapter] Tool call started', {
          toolId: params.id,
          toolName: params.name,
        });
      },

      [AgentEvent.ToolCallProgress]: async (params) => {
        // Update the tracked input as it streams in
        const pending = this.pendingToolCalls.get(params.id);
        if (pending) {
          pending.input = { ...pending.input, ...params.partialInput };
        }
      },

      [AgentEvent.ToolInputComplete]: async () => {
        // All tool inputs complete - send tool_call notifications now
        const updates: Promise<unknown>[] = [];

        for (const [id, { name, input }] of this.pendingToolCalls.entries()) {
          if (name === 'TodoWrite') {
            const todos = parseTodoParams(input);
            if (todos) {
              updates.push(
                this.connection
                  .sessionUpdate({
                    sessionId: this.sessionId,
                    update: {
                      sessionUpdate: 'plan',
                      entries: todos.map((todo) => ({
                        content: todo.content,
                        priority: mapTodoPriority(todo.priority),
                        status: mapTodoStatus(todo.status),
                      })),
                    },
                  })
                  .catch((error) => {
                    logWarn(
                      '[AcpAdapter] Failed to send plan update (streaming)',
                      {
                        cause: error,
                      }
                    );
                  })
              );
            }
          } else {
            // Send tool_call with complete input
            updates.push(
              this.sendToolCall({
                toolCallId: id,
                title: generateToolTitle(name, input),
                kind: inferToolKind(name),
                status: 'pending',
                rawInput: input,
                content: buildToolInputContent(name, input),
                locations: buildToolLocations(name, input),
              })
            );
          }
        }

        await Promise.all(updates);
      },

      [AgentEvent.ToolCallComplete]: async (params) => {
        const pending = this.pendingToolCalls.get(params.id);
        const hasEmbeddedTerminal = this.embeddedTerminals.has(params.id);

        // Clean up the tracked tool call
        this.pendingToolCalls.delete(params.id);
        this.embeddedTerminals.delete(params.id);

        // Skip tool_call_update for TodoWrite - plan was already sent on input complete
        if (pending?.name === 'TodoWrite') {
          return;
        }

        const hasStartNotification = await this.ensureToolCallDelivered(
          params.id,
          pending
        );
        if (!hasStartNotification) {
          this.deliveredToolCalls.delete(params.id);
          return;
        }

        try {
          // If terminal is embedded, only send status update (output is already visible)
          if (hasEmbeddedTerminal) {
            await this.connection.sessionUpdate({
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: params.id,
                status: params.isError ? 'failed' : 'completed',
              },
            });
          } else {
            const resultContent = buildToolResultContent(
              pending?.name,
              params.result
            );
            // For Create/Edit, omit rawOutput since the diff was already shown
            const shouldOmitRawOutput =
              pending?.name === 'Create' || pending?.name === 'Edit';
            await this.connection.sessionUpdate({
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: params.id,
                status: params.isError ? 'failed' : 'completed',
                ...(!shouldOmitRawOutput && {
                  rawOutput: { text: params.result },
                }),
                ...(resultContent && { content: resultContent }),
              },
            });
          }
        } catch (error) {
          logWarn('[AcpAdapter] Failed to send tool result', { cause: error });
        } finally {
          this.deliveredToolCalls.delete(params.id);
        }
      },

      [AgentEvent.ToolStreamingUpdate]: async (params) => {
        // Embed terminal in tool call if terminalId is present
        if (
          params.update.terminalId &&
          !this.embeddedTerminals.has(params.id)
        ) {
          this.embeddedTerminals.add(params.id);

          logInfo('[AcpAdapter] Embedding terminal in tool call', {
            toolId: params.id,
            toolName: params.name,
            terminalId: params.update.terminalId,
          });

          try {
            await this.connection.sessionUpdate({
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: params.id,
                status: 'in_progress',
                content: [
                  { type: 'terminal', terminalId: params.update.terminalId },
                ],
              },
            });
          } catch (error) {
            logWarn('[AcpAdapter] Failed to embed terminal', { cause: error });
          }
        }
      },

      [AgentEvent.AgentError]: async (params) => {
        const message =
          params.error instanceof Error
            ? params.error.message
            : String(params.error);

        try {
          await this.connection.sessionUpdate({
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Error: ${message}` },
            },
          });
        } catch (error) {
          logWarn('[AcpAdapter] Failed to send error message', {
            cause: error,
          });
        }
      },

      [AgentEvent.PermissionRequest]: (params) => {
        this.handlePermissionRequestEvent(params);
      },

      [AgentEvent.SettingsUpdated]: async (params) => {
        // Notify client of mode changes
        if (params.settings.autonomyMode !== undefined) {
          try {
            await this.connection.sessionUpdate({
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'current_mode_update',
                currentModeId: params.settings.autonomyMode,
              },
            });
          } catch (error) {
            logWarn('[AcpAdapter] Failed to emit mode update', {
              cause: error,
            });
          }
        }

        // Emit ACP `config_option_update` when any advertised option changes:
        // - `reasoning_effort`, `autonomy_level`, or `model`
        // Per the ACP Session Config Options spec, the notification carries
        // the complete current configuration state, so a model change also
        // refreshes the `reasoning_effort.options` list (which is
        // model-dependent).
        const reasoningEffortChanged =
          params.settings.reasoningEffort !== undefined;
        const autonomyChanged = params.settings.autonomyMode !== undefined;
        const modelChanged = params.settings.modelId !== undefined;
        if (reasoningEffortChanged || autonomyChanged || modelChanged) {
          await this.emitConfigOptionUpdate();
        }
      },
    });
  }

  /**
   * Emit a `config_option_update` session/update notification containing the
   * complete current configOptions state. Per ACP spec
   * (https://agentclientprotocol.com/protocol/session-config-options), this
   * is fired when any advertised option changes value during a session.
   *
   * Refetches the available models list each time so the `model` option
   * reflects current server-side availability and so the reasoning-effort
   * options stay in sync with the active model.
   */
  private async emitConfigOptionUpdate(): Promise<void> {
    try {
      const settings = this.sessionController.getSettings();
      const { configOptions } = buildAcpSessionConfigState({
        settings,
        availableModels: await buildModelState().catch((err) => {
          logWarn(
            '[AcpAdapter] Failed to fetch available models for config_option_update; emitting current model only',
            { cause: err }
          );
          return [];
        }),
      });

      // UNSTABLE: `config_option_update` is in the stable ACP spec but the
      // SDK type union for sessionUpdate doesn't yet include it. The wire
      // format follows the ACP schema.
      await this.connection.sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions,
        },
      } as unknown as Parameters<typeof this.connection.sessionUpdate>[0]);
    } catch (error) {
      logWarn('[AcpAdapter] Failed to emit config_option_update', {
        cause: error,
      });
    }
  }

  /**
   * Handle PermissionRequest event from AgentEventBus.
   * Forwards the request to the ACP connection and emits PermissionResponse.
   */
  private handlePermissionRequestEvent(params: {
    requestId: string;
    toolUses: ToolConfirmationInfo[];
    options: ToolConfirmationListItem[];
    sessionId: string;
  }): void {
    // Fire-and-forget async handler
    this.processPermissionRequest(params).catch((error) => {
      logWarn('[AcpAdapter] Permission request failed (event bus handler)', {
        cause: error,
      });
      // Emit empty response on error
      agentEventBus.emit(AgentEvent.PermissionResponse, {
        requestId: params.requestId,
        approvedToolIds: [],
        sessionId: params.sessionId,
      });
    });
  }

  /**
   * Process a permission request asynchronously
   */
  private async processPermissionRequest(params: {
    requestId: string;
    toolUses: ToolConfirmationInfo[];
    options: ToolConfirmationListItem[];
    sessionId: string;
  }): Promise<void> {
    if (params.toolUses.length === 0) {
      agentEventBus.emit(AgentEvent.PermissionResponse, {
        requestId: params.requestId,
        approvedToolIds: [],
        sessionId: params.sessionId,
      });
      return;
    }

    const previousAutonomyMode =
      this.sessionController.getSettings().autonomyMode;
    const lastTool = params.toolUses[params.toolUses.length - 1];

    logInfo('[AcpAdapter] Processing permission request from event bus', {
      requestId: params.requestId,
      toolCount: params.toolUses.length,
      toolName: lastTool.toolName,
    });

    const payload = buildPermissionRequestPayload(
      lastTool,
      params.toolUses.length,
      params.toolUses
    );

    const response = await this.connection.requestPermission({
      sessionId: this.sessionId,
      options: payload.options,
      toolCall: payload.toolCall,
    });

    const outcome = permissionResponseToOutcome(response);

    logInfo('[AcpAdapter] Permission response received (event bus)', {
      outcome,
      requestId: params.requestId,
    });

    // Process the outcome for ALL tools in the batch
    const approvedToolIds = processConfirmationOutcome({
      outcome,
      tools: params.toolUses,
    });

    // Check if mode changed and notify client
    const currentAutonomyMode = getSessionService().getCurrentAutonomyMode();
    if (currentAutonomyMode !== previousAutonomyMode) {
      this.sessionController.setAutonomyMode(currentAutonomyMode);
    }

    // Emit PermissionResponse to AgentEventBus, INCLUDING the selected
    // outcome. Without this, ToolExecutor defaults to ProceedOnce — which
    // executes the tool but never invokes `persistMcpPermissionsIfApplicable`,
    // so ACP clients that pick "Always allow this tool" / "Always allow
    // all <server> tools" silently fail to persist the approval
    // (ain3sh review feedback).
    agentEventBus.emit(AgentEvent.PermissionResponse, {
      requestId: params.requestId,
      approvedToolIds,
      outcome,
      sessionId: params.sessionId,
    });
  }

  /**
   * Request permission for a batch of tools via ACP protocol.
   * Returns array of approved tool IDs.
   */
  async requestPermission(batch: {
    toolUses: ToolConfirmationInfo[];
    options: ToolConfirmationListItem[];
  }): Promise<string[]> {
    if (batch.toolUses.length === 0) {
      return [];
    }

    const previousAutonomyMode =
      this.sessionController.getSettings().autonomyMode;

    // Send permission request for the last tool in the batch
    // The user's decision applies to all tools
    const lastTool = batch.toolUses[batch.toolUses.length - 1];

    try {
      logInfo('[AcpAdapter] Processing batch permission request', {
        toolCount: batch.toolUses.length,
        toolUseId: lastTool.toolUseId,
        toolName: lastTool.toolName,
      });

      const payload = buildPermissionRequestPayload(
        lastTool,
        batch.toolUses.length,
        batch.toolUses
      );

      const response = await this.connection.requestPermission({
        sessionId: this.sessionId,
        options: payload.options,
        toolCall: payload.toolCall,
      });

      const outcome = permissionResponseToOutcome(response);

      logInfo('[AcpAdapter] Permission response received (batch)', {
        outcome,
      });

      // Process the outcome for ALL tools in the batch
      const approvedToolIds = processConfirmationOutcome({
        outcome,
        tools: batch.toolUses,
      });

      // Check if mode changed and notify client
      const currentAutonomyMode = getSessionService().getCurrentAutonomyMode();

      if (currentAutonomyMode !== previousAutonomyMode) {
        // SessionController will emit the event, which triggers our listener
        this.sessionController.setAutonomyMode(currentAutonomyMode);

        logInfo('[AcpAdapter] Mode changed via permission outcome', {
          previousMode: previousAutonomyMode,
          state: currentAutonomyMode,
        });
      }

      return approvedToolIds;
    } catch (error) {
      logWarn('[AcpAdapter] Permission request failed (batch handler)', {
        cause: error,
      });
      return [];
    }
  }

  /**
   * Send a plan update (for TodoWrite tool)
   */
  async sendPlanUpdate(
    entries: Array<{
      content: string;
      priority: 'low' | 'medium' | 'high';
      status: 'pending' | 'in_progress' | 'completed';
    }>
  ): Promise<void> {
    try {
      await this.connection.sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: 'plan',
          entries,
        },
      });
    } catch (error) {
      logWarn('[AcpAdapter] Failed to send plan update (direct)', {
        cause: error,
      });
    }
  }

  /**
   * Send a tool call notification with optional content and locations.
   */
  async sendToolCall(params: {
    toolCallId: string;
    title: string;
    kind: ToolKind;
    status: ToolCallStatus;
    rawInput: Record<string, unknown>;
    content?: ToolCallContent[];
    locations?: Array<{ path: string; line?: number }>;
  }): Promise<boolean> {
    const existingDelivery = this.toolCallStartDeliveries.get(
      params.toolCallId
    );
    if (existingDelivery) {
      return existingDelivery;
    }

    const delivery = this.deliverToolCallStart(params).finally(() => {
      if (this.toolCallStartDeliveries.get(params.toolCallId) === delivery) {
        this.toolCallStartDeliveries.delete(params.toolCallId);
      }
    });
    this.toolCallStartDeliveries.set(params.toolCallId, delivery);
    return delivery;
  }

  private async ensureToolCallDelivered(
    toolCallId: string,
    pending: { name: string; input: Record<string, unknown> } | undefined
  ): Promise<boolean> {
    if (this.deliveredToolCalls.has(toolCallId)) {
      return true;
    }

    const inFlightDelivery = this.toolCallStartDeliveries.get(toolCallId);
    if (inFlightDelivery) {
      return inFlightDelivery;
    }

    if (!pending) {
      logWarn('[AcpAdapter] Tool completed before tool_call was delivered', {
        toolId: toolCallId,
      });
    }

    const name = pending?.name;
    const input = pending?.input ?? {};

    return this.sendToolCall({
      toolCallId,
      title: name ? generateToolTitle(name, input) : 'Tool call',
      kind: name ? inferToolKind(name) : 'other',
      status: 'pending',
      rawInput: input,
      ...(name && { content: buildToolInputContent(name, input) }),
      ...(name && { locations: buildToolLocations(name, input) }),
    });
  }

  private async deliverToolCallStart(params: {
    toolCallId: string;
    title: string;
    kind: ToolKind;
    status: ToolCallStatus;
    rawInput: Record<string, unknown>;
    content?: ToolCallContent[];
    locations?: Array<{ path: string; line?: number }>;
  }): Promise<boolean> {
    try {
      await this.connection.sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: params.toolCallId,
          title: params.title,
          kind: params.kind,
          status: params.status,
          rawInput: params.rawInput,
          ...(params.content && { content: params.content }),
          ...(params.locations && { locations: params.locations }),
        },
      });
      this.deliveredToolCalls.add(params.toolCallId);
      return true;
    } catch (error) {
      logWarn('[AcpAdapter] Failed to send tool call', { cause: error });
      return false;
    }
  }

  /**
   * Clean up subscriptions
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
