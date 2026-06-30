import { ToolConfirmationOutcome } from '@industry/drool-sdk-ext/protocol/drool';
import { logInfo } from '@industry/logging';

import { processConfirmationOutcome } from '@/agent/tool-confirmation';
import type { PermissionRequestFn, ToolConfirmationBatch } from '@/agent/types';

/**
 * PermissionRequestHandler provides unified permission request handling
 * for all execution modes.
 *
 * It encapsulates the common logic for:
 * 1. Building permission request payloads
 * 2. Processing permission responses
 * 3. Determining which tools are approved
 *
 * Each mode provides their own PermissionRequestFn that handles
 * the actual user interaction (UI, JSON-RPC, ACP protocol).
 *
 * Usage:
 * ```typescript
 * const handler = new PermissionRequestHandler(async (batch) => {
 *   // Mode-specific: show UI, send JSON-RPC request, etc.
 *   return { outcome: ToolConfirmationOutcome.Proceed };
 * });
 *
 * const approvedToolIds = await handler.requestPermission(batch);
 * ```
 */
export class PermissionRequestHandler {
  private requestFn: PermissionRequestFn;

  constructor(requestFn: PermissionRequestFn) {
    this.requestFn = requestFn;
  }

  /**
   * Request permission for a batch of tools.
   * Returns approved tool IDs and the outcome chosen by the user.
   */
  async requestPermission(batch: ToolConfirmationBatch): Promise<{
    approvedToolIds: string[];
    outcome: ToolConfirmationOutcome;
    comment?: string;
    editedSpecContent?: string;
  }> {
    if (batch.toolUses.length === 0) {
      return {
        approvedToolIds: [],
        outcome: ToolConfirmationOutcome.Cancel,
      };
    }

    logInfo('[PermissionRequestHandler] Requesting permission', {
      toolCount: batch.toolUses.length,
      toolIds: batch.toolUses.map((t) => t.toolName),
    });

    // Call the mode-specific request function
    const response = await this.requestFn(batch);

    logInfo('[PermissionRequestHandler] Received response', {
      outcome: response.outcome,
      toolIds: response.approvedToolIds,
    });

    // Process the outcome using shared logic
    const approvedToolIds = processConfirmationOutcome({
      outcome: response.outcome,
      tools: batch.toolUses,
      approvedToolIds: response.approvedToolIds,
    });

    logInfo('[PermissionRequestHandler] Processed outcome', {
      toolIds: approvedToolIds,
      count: approvedToolIds.length,
    });

    const result = {
      approvedToolIds,
      outcome: response.outcome,
      ...(response.comment !== undefined && { comment: response.comment }),
    };
    if (response.editedSpecContent !== undefined) {
      return { ...result, editedSpecContent: response.editedSpecContent };
    }

    return result;
  }
}
