import {
  SYSTEM_REMINDER_END,
  SYSTEM_REMINDER_START,
} from '@industry/drool-sdk-ext/protocol/drool';

import { shortenDescription } from '@/agent/deferredTools';
import { connectorOf } from '@/tools/executors/client/connectors/connector-name';
import { CONNECTOR_CONNECTIVITY_SENTINEL } from '@/tools/executors/client/connectors/constants';

import type {
  ConnectorAuthenticationRequired,
  ConnectorTool,
} from '@industry/common/api/connectors';

const MAX_ARG_HINTS = 6;

interface JsonSchemaShape {
  type?: unknown;
  properties?: Record<string, JsonSchemaShape>;
  required?: unknown;
}

function parseSchema(inputSchema: unknown): JsonSchemaShape | null {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return null;
  }
  return inputSchema as JsonSchemaShape;
}

function requiredNames(
  schema: JsonSchemaShape | null | undefined
): Set<string> {
  return new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter(
          (name): name is string => typeof name === 'string'
        )
      : []
  );
}

function formatPropertyHints(schema: JsonSchemaShape, depth: number): string[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') {
    return [];
  }
  const names = Object.keys(properties);
  if (names.length === 0) {
    return [];
  }

  const required = requiredNames(schema);
  const hints = names.slice(0, MAX_ARG_HINTS).map((name) => {
    const property = properties[name];
    const requiredLabel = required.has(name) ? '*' : '';
    // Merge wraps tool arguments in a single object property (usually
    // "input"); descend one level so the hint shows the real parameters.
    if (depth === 0 && property?.type === 'object' && property.properties) {
      const nested = formatPropertyHints(property, depth + 1);
      if (nested.length > 0) {
        return `${name}${requiredLabel}{${nested.join(', ')}}`;
      }
    }
    const type = property?.type;
    const typeLabel =
      typeof type === 'string' && type !== 'string' ? `:${type}` : '';
    return `${name}${typeLabel}${requiredLabel}`;
  });

  if (names.length > MAX_ARG_HINTS) {
    hints.push('…');
  }
  return hints;
}

/**
 * Builds a compact, single-line argument hint from a tool's JSON input schema,
 * e.g. "(args: owner*, repo*, state)". Required params are suffixed with `*`,
 * non-string params annotate their type, and the list is capped so the listing
 * stays legible to the model.
 */
function formatArgHint(inputSchema: unknown): string {
  const schema = parseSchema(inputSchema);
  if (!schema) {
    return '';
  }
  const hints = formatPropertyHints(schema, 0);
  return hints.length > 0 ? `(args: ${hints.join(', ')})` : '';
}

function formatToolLine(tool: ConnectorTool): string {
  const argHint = formatArgHint(tool.inputSchema);
  const argSuffix = argHint ? ` ${argHint}` : '';
  // Bound each tool's description to the same char limit as the internal
  // ToolSearch deferred-tools listing so a large connector catalog stays
  // legible (and cheap) when handed to the model.
  const shortened = tool.description
    ? shortenDescription(tool.description)
    : '';
  const description = shortened ? ` — ${shortened}` : '';
  return `  - ${tool.name}${argSuffix}${description}`;
}

function dedupeTools(tools: ConnectorTool[]): ConnectorTool[] {
  const seen = new Set<string>();
  const result: ConnectorTool[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    result.push(tool);
  }
  return result;
}

const AUTHENTICATE_TOOL_PREFIX = 'authenticate_';

function isAuthenticateTool(tool: ConnectorTool): boolean {
  return (
    tool.name.startsWith(AUTHENTICATE_TOOL_PREFIX) && !tool.name.includes('__')
  );
}

/**
 * Merge exposes one boilerplate `authenticate_<connector>` tool per connector,
 * which would otherwise dominate the listing. Collapse them into a single
 * summary line of available connector slugs.
 */
function formatAuthenticateSection(authTools: ConnectorTool[]): string {
  const slugs = authTools
    .map((tool) => tool.name.slice(AUTHENTICATE_TOOL_PREFIX.length))
    .sort((a, b) => a.localeCompare(b));
  return [
    `Connectable apps (${slugs.length}): call authenticate_<app> (e.g. "${AUTHENTICATE_TOOL_PREFIX}${slugs[0]}") to get a connect link for one of:`,
    slugs.join(', '),
  ].join('\n');
}

/**
 * Build the grouped, sorted tool sections (one block per connector) shared by
 * the interactive `list_tools` result and the pre-turn connector reminder.
 * `authenticate_*` tools are collapsed into a single "Connectable apps" line.
 */
function buildToolSections(tools: ConnectorTool[]): string[] {
  const deduped = dedupeTools(tools);
  const authTools = deduped.filter(isAuthenticateTool);
  const groups = new Map<string, ConnectorTool[]>();
  for (const tool of deduped) {
    if (isAuthenticateTool(tool)) {
      continue;
    }
    const connector = connectorOf(tool.name);
    const group = groups.get(connector) ?? [];
    group.push(tool);
    groups.set(connector, group);
  }

  const sections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([connector, group]) => {
      const header = `${connector} (${group.length}):`;
      const lines = group
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(formatToolLine)
        .join('\n');
      return `${header}\n${lines}`;
    });

  if (authTools.length > 0) {
    sections.push(formatAuthenticateSection(authTools));
  }

  return sections;
}

export function formatToolList(tools: ConnectorTool[]): string {
  if (tools.length === 0) {
    return 'No connector tools are available. Ask the user to connect an app in Settings → Connectors.';
  }

  return [
    'Available connector tools, grouped by connector:',
    '',
    buildToolSections(tools).join('\n\n'),
    '',
    "To inspect one tool's full input schema, call list_tools with that toolName. To run a tool, call call_tool with the fully-qualified toolName and toolArguments.",
  ].join('\n');
}

/** Whether a text block is a connectivity reminder (any connected state). */
export function isConnectivityReminder(text: string): boolean {
  return text.includes(CONNECTOR_CONNECTIVITY_SENTINEL);
}

/**
 * Build the pre-turn reminder listing the user's connected connector tools.
 * Only emitted once connectivity is known (the caller omits it while the first
 * background fetch is still pending) so the model is never told "No apps are
 * connected yet." for a user who does have connected apps. Every reminder
 * carries {@link CONNECTOR_CONNECTIVITY_SENTINEL} so stale copies can be pruned.
 */
export function formatConnectorConnectivityReminder(
  tools: ConnectorTool[]
): string {
  const connectedTools = dedupeTools(tools).filter(
    (tool) => !isAuthenticateTool(tool)
  );
  const body =
    connectedTools.length > 0
      ? `Connected connector tools:\n${buildToolSections(connectedTools).join('\n\n')}`
      : 'No apps are connected yet.';

  return `${SYSTEM_REMINDER_START}
${CONNECTOR_CONNECTIVITY_SENTINEL}
${body}
${SYSTEM_REMINDER_END}`;
}

export function formatToolSchemaDetail(
  toolName: string,
  tool: ConnectorTool | undefined
): string {
  if (!tool) {
    return `No connector tool named "${toolName}" is available. Call list_tools to see the current tools.`;
  }

  const lines = [`Tool: ${tool.name}`];
  if (tool.description) {
    lines.push('', tool.description.trim());
  }
  if (tool.inputSchema) {
    lines.push('', 'Input schema:', JSON.stringify(tool.inputSchema, null, 2));
  } else {
    lines.push('', 'This tool takes no documented input schema.');
  }
  return lines.join('\n');
}

export function formatAuthRequired(
  data: ConnectorAuthenticationRequired
): string {
  return [
    `Authentication required: the "${data.connector}" connector must be connected before this tool can run.`,
    `Share this link with the user and ask them to connect:\n${data.magicLinkUrl}`,
    data.message,
    'Once they confirm they have connected, retry the same call_tool request.',
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('\n\n');
}

export function formatMcpSuppressedConnector(connector: string): string {
  return [
    `${connector} connector is suppressed because local MCP settings already provide ${connector} access.`,
    `Use the available MCP tools for ${connector} instead of asking the user to connect the connector.`,
  ].join('\n\n');
}

export function formatToolListWithSuppressedConnectors(
  tools: ConnectorTool[],
  suppressedConnectors: string[]
): string {
  const base =
    tools.length > 0
      ? formatToolList(tools)
      : 'No non-suppressed connector tools are available.';

  if (suppressedConnectors.length === 0) {
    return base;
  }

  return [
    base,
    '',
    `Suppressed connectors: ${suppressedConnectors.join(', ')}.`,
    suppressedConnectors
      .map(
        (connector) =>
          `${connector} is already configured through MCP. Use MCP tools instead of connector OAuth.`
      )
      .join('\n'),
  ].join('\n');
}

export function formatCallToolResult(content: string): string {
  const trimmed = content.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return content;
    }
  }
  return content;
}
