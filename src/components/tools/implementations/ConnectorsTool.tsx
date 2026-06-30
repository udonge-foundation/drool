import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { DefaultTool } from '@/components/tools/implementations/DefaultTool';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import type { ToolResultContent } from '@/hooks/types';
import { getI18n } from '@/i18n';
import {
  connectorOf,
  friendlyToolName,
} from '@/tools/executors/client/connectors/connector-name';
import {
  formatJsonResultAsMarkdown,
  getTextContent,
} from '@/utils/tool-result-helpers';

const AUTH_REQUIRED_PREFIX = 'Authentication required';
const NOT_FOUND_PREFIX = 'No connector tool named';
const NO_TOOLS_PREFIX = 'No connector tools are available';
const SCHEMA_DETAIL_PREFIX = 'Tool: ';
const TOOL_LINE_PATTERN = /^\s*-\s/gm;
const CONNECTOR_HEADER_PATTERN = /^[\w-]+ \(\d+\):$/gm;
// Matches the collapsed `authenticate_*` summary section, e.g.
// "Connectable apps (3): call authenticate_<app> ...".
const CONNECTABLE_APPS_PATTERN = /^Connectable apps \((\d+)\):/m;

function getAction(input: Record<string, unknown>): string {
  return typeof input.action === 'string' ? input.action : '';
}

function getInputToolName(input: Record<string, unknown>): string {
  return typeof input.toolName === 'string' ? input.toolName : '';
}

function isAuthRequired(result: string): boolean {
  return result.startsWith(AUTH_REQUIRED_PREFIX);
}

/**
 * The auth-required result text carries the real connector slug (e.g. a
 * `call_tool` on `authenticate_github` yields a "github" connector), so prefer
 * it over the input tool name, which would otherwise render the raw tool name.
 */
function connectorFromAuthResult(result: string, toolName: string): string {
  return (
    result.match(/the "([^"]+)" connector/)?.[1] ??
    connectorOf(toolName, toolName)
  );
}

function extractMagicLink(result: string): string | undefined {
  return result.match(/https:\/\/\S+/)?.[0];
}

function countMatches(result: string, pattern: RegExp): number {
  return (result.match(pattern) ?? []).length;
}

function summarizeListResult(
  input: Record<string, unknown>,
  result: string
): string {
  const t = getI18n().t;
  const firstLine = result.split('\n')[0]?.trim() ?? '';
  if (firstLine.startsWith(NOT_FOUND_PREFIX)) {
    return firstLine;
  }
  if (result.startsWith(SCHEMA_DETAIL_PREFIX)) {
    const tool =
      getInputToolName(input) ||
      result.slice(SCHEMA_DETAIL_PREFIX.length).split('\n')[0].trim();
    return t('common:toolDisplay.connectors.summarySchema', {
      tool: friendlyToolName(tool),
    });
  }
  const tools = countMatches(result, TOOL_LINE_PATTERN);
  const apps = countMatches(result, CONNECTOR_HEADER_PATTERN);
  if (apps > 0) {
    return t('common:toolDisplay.connectors.summaryListed', { tools, apps });
  }
  if (tools > 0) {
    return t('common:toolDisplay.connectors.summaryListedFlat', { tools });
  }
  // No grouped tool lines: surface the connect guidance / empty state instead
  // of a misleading "Listed 0 connector tools".
  const connectable = result.match(CONNECTABLE_APPS_PATTERN);
  if (connectable) {
    return t('common:toolDisplay.connectors.summaryConnectable', {
      apps: Number(connectable[1]),
    });
  }
  if (firstLine.startsWith(NO_TOOLS_PREFIX)) {
    return t('common:toolDisplay.connectors.summaryNoTools');
  }
  return t('common:toolDisplay.connectors.summaryListedFlat', { tools });
}

function renderBody(
  { input, result, isError, contentWidth }: ToolComponentProps,
  detailed: boolean
) {
  const t = getI18n().t;
  const resultText = getTextContent(result) || '';

  if (isError) {
    return (
      <Box flexDirection="column">
        <Text color={COLORS.error}>{resultText}</Text>
      </Box>
    );
  }

  const action = getAction(input);

  if (action === 'list_tools') {
    if (!resultText) {
      return null;
    }
    return (
      <Text color={COLORS.text.muted}>
        ↳ {summarizeListResult(input, resultText)}
      </Text>
    );
  }

  if (isAuthRequired(resultText)) {
    const connector = connectorFromAuthResult(
      resultText,
      getInputToolName(input)
    );
    const link = extractMagicLink(resultText);
    return (
      <Box flexDirection="column">
        <Text color={COLORS.warning}>
          ↳ {t('common:toolDisplay.connectors.authConnect', { connector })}
        </Text>
        {link && (
          <Text color={COLORS.text.secondary}>
            {'  '}
            {link}
          </Text>
        )}
      </Box>
    );
  }

  if (!resultText.trim()) {
    return (
      <Text color={COLORS.text.muted}>
        ↳ {t('common:toolDisplay.connectors.noOutput')}
      </Text>
    );
  }

  // Render call_tool JSON output as a markdown list (matching MCP tools) so the
  // raw JSON payload is legible in the chat view. Falls back to the raw result
  // for plain-text or non-JSON output.
  const markdownResult = formatJsonResultAsMarkdown(resultText);
  const displayResult = markdownResult ?? result;

  return detailed
    ? DefaultTool.renderDetailedView?.({
        input,
        result: displayResult,
        isError,
        contentWidth,
      })
    : DefaultTool.renderResult({
        input,
        result: displayResult,
        isError,
        contentWidth,
      });
}

function createConnectorsTool(): ToolComponent {
  return {
    getHeaderLabel(input: Record<string, unknown>): string {
      const t = getI18n().t;
      const action = getAction(input);
      const toolName = getInputToolName(input);

      if (action === 'call_tool') {
        return friendlyToolName(toolName);
      }

      if (action === 'list_tools') {
        if (toolName) {
          return t('common:toolDisplay.connectors.schemaLabel', {
            tool: friendlyToolName(toolName),
          });
        }
        return input.authenticatedOnly === true
          ? t('common:toolDisplay.connectors.listToolsConnectedLabel')
          : t('common:toolDisplay.connectors.listToolsLabel');
      }

      return '';
    },

    renderResult(props: ToolComponentProps) {
      return renderBody(props, false);
    },

    renderDetailedView(props: ToolComponentProps) {
      return renderBody(props, true);
    },

    getSummaryLine(
      input: Record<string, unknown>,
      result: ToolResultContent,
      isError: boolean
    ): string {
      const t = getI18n().t;
      const resultText = getTextContent(result) || '';

      if (isError) {
        return resultText || t('common:toolDisplay.connectors.summaryFailed');
      }

      const action = getAction(input);
      const toolName = getInputToolName(input);

      if (action === 'list_tools') {
        return summarizeListResult(input, resultText);
      }

      if (isAuthRequired(resultText)) {
        return t('common:toolDisplay.connectors.summaryAuthRequired', {
          connector: connectorFromAuthResult(resultText, toolName),
        });
      }

      if (toolName) {
        return t('common:toolDisplay.connectors.summaryUsed', {
          tool: friendlyToolName(toolName),
        });
      }

      return t('common:toolDisplay.connectors.summaryCompleted');
    },
  };
}

export const ConnectorsTool: ToolComponent = createConnectorsTool();
