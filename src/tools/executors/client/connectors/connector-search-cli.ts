import { z } from 'zod';

import {
  CallConnectorToolResponseSchema,
  CONNECTORS_API_ROUTES,
  type CallConnectorToolRequest,
} from '@industry/common/api/connectors';
import { ToolExecutionErrorType } from '@industry/common/session';
import { fetch } from '@industry/drool-core/api/fetch';
import { connectorSearchSchema } from '@industry/drool-core/tools/definitions/connectors';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { ToolAbortError } from '@industry/logging/errors';

import { getIndustryApiConfig } from '@/api/config';
import { fetchConnectorTools } from '@/tools/executors/client/connectors/client';
import { connectorOf } from '@/tools/executors/client/connectors/connector-name';
import { JSON_HEADERS } from '@/tools/executors/client/connectors/constants';
import { ConnectorToolsResponseError } from '@/tools/executors/client/connectors/errors';
import {
  formatAuthRequired,
  formatCallToolResult,
  formatMcpSuppressedConnector,
  formatToolList,
  formatToolListWithSuppressedConnectors,
  formatToolSchemaDetail,
} from '@/tools/executors/client/connectors/format';
import {
  connectorDisplayName,
  getMcpCoveredSignalTokens,
  isConnectorMcpCovered,
} from '@/tools/executors/client/connectors/mcp-overlap';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

function unexpectedResponseFeedback(): DraftToolFeedback<string> {
  return {
    type: DraftToolFeedbackType.Result,
    isError: true,
    errorType: ToolExecutionErrorType.ExternalAPIError,
    llmError: 'Unexpected response shape from the connectors API.',
    userError: 'Failed to use connector',
  };
}

/**
 * Steer the model to an enabled MCP server instead of connectors when both
 * cover the same service. Returned as a non-error result so the model retries
 * via the MCP server's tools without surfacing a redundant connector OAuth.
 */
function mcpSuppressedFeedback(slug: string): DraftToolFeedback<string> {
  return {
    type: DraftToolFeedbackType.Result,
    isError: false,
    value: formatMcpSuppressedConnector(connectorDisplayName(slug)),
  };
}

export class ConnectorSearchCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: z.infer<typeof connectorSearchSchema>
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { action, toolName, toolArguments, authenticatedOnly } = parameters;

    // An enabled MCP server (or owned skill) covering the same service takes
    // priority over connectors, so refuse connector discovery/execution for a
    // covered service before any API call rather than surfacing a redundant
    // connector OAuth flow.
    const mcpSignalTokens = getMcpCoveredSignalTokens();

    try {
      if (action === 'list_tools') {
        if (toolName && isConnectorMcpCovered(toolName, mcpSignalTokens)) {
          yield mcpSuppressedFeedback(connectorOf(toolName, toolName));
          return;
        }
        let tools;
        try {
          tools = await fetchConnectorTools(authenticatedOnly, {
            signal: dependencies.abortSignal,
          });
        } catch (error) {
          if (error instanceof ConnectorToolsResponseError) {
            yield unexpectedResponseFeedback();
            return;
          }
          throw error;
        }
        if (toolName) {
          yield {
            type: DraftToolFeedbackType.Result,
            isError: false,
            value: formatToolSchemaDetail(
              toolName,
              tools.find((tool) => tool.name === toolName)
            ),
          };
          return;
        }
        const visibleTools = tools.filter(
          (tool) => !isConnectorMcpCovered(tool.name, mcpSignalTokens)
        );
        const suppressedConnectorNames = [
          ...new Set(
            tools
              .filter((tool) =>
                isConnectorMcpCovered(tool.name, mcpSignalTokens)
              )
              .map((tool) =>
                connectorDisplayName(connectorOf(tool.name, tool.name))
              )
          ),
        ];
        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value:
            suppressedConnectorNames.length > 0
              ? formatToolListWithSuppressedConnectors(
                  visibleTools,
                  suppressedConnectorNames
                )
              : formatToolList(visibleTools),
        };
        return;
      }

      if (!toolName) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError: 'toolName is required when action is "call_tool".',
          userError: 'Invalid parameters: toolName is required',
        };
        return;
      }

      if (isConnectorMcpCovered(toolName, mcpSignalTokens)) {
        yield mcpSuppressedFeedback(connectorOf(toolName, toolName));
        return;
      }

      const body: CallConnectorToolRequest = {
        toolName,
        arguments: toolArguments,
      };
      const response = await fetch(
        CONNECTORS_API_ROUTES.toolsCall,
        {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
          ...(dependencies.abortSignal
            ? { signal: dependencies.abortSignal }
            : {}),
        },
        getIndustryApiConfig()
      );
      const parsed = CallConnectorToolResponseSchema.safeParse(
        await response.json()
      );
      if (!parsed.success) {
        yield unexpectedResponseFeedback();
        return;
      }
      const data = parsed.data;

      if (data.status === 'authentication_required') {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: false,
          value: formatAuthRequired(data),
        };
        return;
      }

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: formatCallToolResult(data.content),
      };
    } catch (error) {
      // A user cancellation must surface as a clean abort, not a connectors
      // API failure, matching the abort contract in sibling executors.
      if (error instanceof ToolAbortError) {
        throw error;
      }
      if (
        dependencies.abortSignal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw new ToolAbortError();
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ExternalAPIError,
        llmError: `Error calling connector tool: ${errorMessage}`,
        userError: 'Failed to use connector',
      };
    }
  }
}
