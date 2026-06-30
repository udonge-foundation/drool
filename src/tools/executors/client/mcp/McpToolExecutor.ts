import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ToolExecutionErrorType } from '@industry/common/session';
import { SUPPORTED_IMAGE_TYPES } from '@industry/drool-core/tools/definitions/cli/constants';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { Metrics, logWarn } from '@industry/logging';
import { ToolAbortError } from '@industry/logging/errors';
import { Metric } from '@industry/logging/metrics/enums';

import { ToolResultContent } from '@/hooks/types';
import { getMcpService } from '@/services/mcp/McpService';
import { CustomerMetrics } from '@/telemetry/customer/CustomerMetrics';
import { AttributeName, MetricName } from '@/telemetry/customer/enums';
import { formatMcpResult } from '@/tools/executors/client/mcp/formatMcpResult';
import { resolveMcpResourceBlobs } from '@/tools/executors/client/mcp/resolveMcpResourceBlobs';
import { CliClientToolDependencies } from '@/tools/types';
import { compressImageForLLM } from '@/utils/images/compressForLLM';
import { MAX_LLM_IMAGE_SIZE_BYTES } from '@/utils/images/constants';

/**
 * Compresses image blocks in an MCP tool result to stay within the same
 * per-image limits we use for user attachments. If compression fails for a
 * particular image, that image is replaced with a textual placeholder.
 */
async function compressMcpResultImages(
  result: CallToolResult
): Promise<CallToolResult> {
  if (!result.content || result.content.length === 0) {
    return result;
  }

  const newContent = await Promise.all(
    result.content.map(async (block) => {
      if (block.type !== 'image') {
        return block;
      }

      const mimeType = block.mimeType as string | undefined;
      if (
        !mimeType ||
        !SUPPORTED_IMAGE_TYPES.includes(
          mimeType as (typeof SUPPORTED_IMAGE_TYPES)[number]
        )
      ) {
        return block;
      }

      try {
        const buffer = Buffer.from(block.data, 'base64');

        // Skip compression for images that are already under the limit.
        if (buffer.length <= MAX_LLM_IMAGE_SIZE_BYTES) {
          return block;
        }

        const compressed = await compressImageForLLM(buffer, mimeType);

        return {
          ...block,
          mimeType: compressed.contentType || mimeType,
          data: compressed.buffer.toString('base64'),
        } as typeof block;
      } catch (error) {
        logWarn('[MCP] Failed to compress image result', {
          mimeType,
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        return {
          type: 'text',
          text: '[Image result omitted because it could not be compressed under the size limit]',
        } as CallToolResult['content'][number];
      }
    })
  );

  return {
    ...result,
    content: newContent,
  };
}

/**
 * Generic executor for MCP (Model Context Protocol) tools.
 * This executor handles the communication with MCP servers through the McpService.
 */
export class McpToolExecutor
  implements ClientToolExecutor<CliClientToolDependencies, ToolResultContent>
{
  private serverName: string;

  private toolName: string;

  constructor(serverName: string, toolName: string) {
    this.serverName = serverName;
    this.toolName = toolName;
  }

  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: Record<string, unknown>
  ): AsyncGenerator<DraftToolFeedback<ToolResultContent>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    try {
      const mcpService = getMcpService();

      if (!mcpService.isInitialized()) {
        Metrics.addToCounter(Metric.MCP_TOOL_EXECUTION_COUNT, 1, {
          serverName: this.serverName,
          toolName: this.toolName,
          status: 'error',
          failureReason: 'service_not_initialized',
          ...(dependencies.sessionId && { sessionId: dependencies.sessionId }),
        });

        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ToolInternalError,
          llmError: 'MCP service not initialized',
          userError: 'MCP service is not available',
        };
        return;
      }

      // Call the tool on the MCP server
      const rawResult = await mcpService.callTool({
        serverName: this.serverName,
        toolName: this.toolName,
        args: parameters,
        sessionId: dependencies.sessionId,
      });

      Metrics.addToCounter(Metric.MCP_TOOL_EXECUTION_COUNT, 1, {
        serverName: this.serverName,
        toolName: this.toolName,
        status: rawResult.isError ? 'error' : 'success',
        ...(rawResult.isError && { failureReason: 'result_is_error' }),
        ...(dependencies.sessionId && { sessionId: dependencies.sessionId }),
      });

      // Customer telemetry for MCP tool usage
      CustomerMetrics.addToCounter(MetricName.MCP_TOOL_INVOCATIONS, 1, {
        [AttributeName.MCP_SERVER]: this.serverName,
        [AttributeName.TOOL_NAME]: this.toolName,
        [AttributeName.TOOL_SUCCEEDED]: !rawResult.isError,
      });

      // Compress any image content to stay within per-image limits
      const compressedResult = await compressMcpResultImages(rawResult);
      const resolvedResult = await resolveMcpResourceBlobs(compressedResult, {
        serverName: this.serverName,
        toolName: this.toolName,
        sessionId: dependencies.sessionId,
      });

      // Format the result for display
      const formattedResult = formatMcpResult(resolvedResult, {
        serverName: this.serverName,
        toolName: this.toolName,
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: formattedResult,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown MCP error';
      const formattedError = formatMcpResult(
        {
          isError: true,
          content: [
            {
              type: 'text',
              text: errorMessage,
            },
          ],
        },
        {
          serverName: this.serverName,
          toolName: this.toolName,
        }
      );
      const userError =
        typeof formattedError === 'string'
          ? formattedError
          : 'Error: Unknown error occurred';

      Metrics.addToCounter(Metric.MCP_TOOL_EXECUTION_COUNT, 1, {
        serverName: this.serverName,
        toolName: this.toolName,
        status: 'error',
        failureReason: 'call_exception',
        ...(dependencies.sessionId && { sessionId: dependencies.sessionId }),
      });

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ToolInternalError,
        llmError: `Error executing MCP tool ${this.serverName}___${this.toolName}: ${errorMessage}`,
        userError,
      };
    }
  }
}
