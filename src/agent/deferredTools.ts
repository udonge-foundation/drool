import { ToolSearchPhase } from '@industry/drool-core/llms/client/enums';
import {
  SYSTEM_REMINDER_START,
  SYSTEM_REMINDER_END,
} from '@industry/drool-sdk-ext/protocol/drool';
import { approxTokensFromChars } from '@industry/utils/llm';

import type { ToolSearchMetricsMetadata } from '@industry/drool-core/llms/client/types';
import type {
  LLMToolSpec,
  LLMToolDescriptor,
} from '@industry/drool-core/tools/types';

const CACHE_CONTROL = { type: 'ephemeral' as const };
const TOOL_SEARCH_NAME = 'ToolSearch';
const MAX_SCHEMA_HINT_PARAMS = 5;
const MAX_PARAM_DESCRIPTION_LENGTH = 80;
const MAX_SCHEMA_HINT_LENGTH = 360;

type ToolWithCacheControl = LLMToolSpec & {
  cache_control?: typeof CACHE_CONTROL;
};

function normalizeDescriptionLine(line: string): string {
  const trimmed = line.trim();
  const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
  return headingMatch?.[1]?.trim() ?? trimmed;
}

function isGenericDescriptionHeading(line: string): boolean {
  return /^(overview|description|summary)$/i.test(line);
}

function truncateDescription(desc: string, max: number): string {
  if (desc.length <= max) return desc;
  return `${desc.slice(0, max - 1).trimEnd()}\u2026`;
}

/**
 * Shorten a tool description to at most `max` characters,
 * taking the first meaningful line and truncating with an ellipsis if needed.
 */
export function shortenDescription(desc: string, max = 200): string {
  if (!desc) return '';
  const lines = desc
    .split('\n')
    .map((line) => normalizeDescriptionLine(line))
    .filter((line) => line.length > 0);
  const firstLine = lines[0] ?? '';
  const meaningfulLine =
    isGenericDescriptionHeading(firstLine) && lines[1]
      ? `${firstLine} — ${lines[1]}`
      : firstLine;

  return truncateDescription(meaningfulLine, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(schema: Record<string, unknown>, key: string): string {
  const value = schema[key];
  return typeof value === 'string' ? value : '';
}

function formatSchemaType(schema: unknown): string {
  if (!isRecord(schema)) return '';

  const type = schema.type;
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type) && type.every((item) => typeof item === 'string')) {
    return type.join('|');
  }
  if (Array.isArray(schema.enum)) {
    return 'enum';
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return 'union';
  }
  if (typeof schema.$ref === 'string') {
    return 'ref';
  }

  return '';
}

function formatSchemaDescription(schema: unknown): string {
  if (!isRecord(schema)) return '';

  return shortenDescription(
    getStringField(schema, 'description') || getStringField(schema, 'title'),
    MAX_PARAM_DESCRIPTION_LENGTH
  );
}

function formatInputSchemaHint(schema: LLMToolSpec['input_schema']): string {
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) {
    return '';
  }

  const required = new Set(schema.required ?? []);
  const params = entries
    .slice(0, MAX_SCHEMA_HINT_PARAMS)
    .map(([name, prop]) => {
      const requiredMarker = required.has(name) ? '*' : '';
      const type = formatSchemaType(prop);
      const description = formatSchemaDescription(prop);
      const param = `${name}${requiredMarker}${type ? ` (${type})` : ''}`;
      return description ? `${param}: ${description}` : param;
    });

  const more =
    entries.length > MAX_SCHEMA_HINT_PARAMS
      ? `; +${entries.length - MAX_SCHEMA_HINT_PARAMS} more`
      : '';
  const prefix = required.size > 0 ? 'Inputs (* required): ' : 'Inputs: ';

  return shortenDescription(
    `${prefix}${params.join('; ')}${more}`,
    MAX_SCHEMA_HINT_LENGTH
  );
}

export function getMcpServerName(toolName: string): string {
  const separatorIndex = toolName.indexOf('___');
  if (separatorIndex <= 0) {
    return '';
  }

  return toolName.slice(0, separatorIndex);
}

export function formatDeferredToolLine(tool: LLMToolDescriptor): string {
  const description =
    shortenDescription(tool.spec.description) || 'No description provided';
  const parts = [`${tool.spec.name}: ${description}`];
  const mcpServerName = getMcpServerName(tool.spec.name);
  const inputHint = formatInputSchemaHint(tool.spec.input_schema);

  if (mcpServerName) {
    parts.push(`MCP server: ${mcpServerName}`);
  }
  if (inputHint) {
    parts.push(inputHint);
  }

  return parts.join(' | ');
}

export function hasDeferredToolDescriptors(
  tools: LLMToolDescriptor[]
): boolean {
  return tools.some((tool) => tool.deferred);
}

export function selectCoreToolsForDeferredState<T extends { name: string }>(
  coreTools: T[],
  hasDeferredTools: boolean
): T[] {
  if (hasDeferredTools) {
    return coreTools;
  }

  return coreTools.filter((tool) => tool.name !== TOOL_SEARCH_NAME);
}

/**
 * Partition tool descriptors into exposed (sent to LLM with full schema)
 * and hidden (deferred — listed in system reminder only).
 *
 * Tools whose name appears in `loaded` are promoted out of the
 * deferred set regardless of their `deferred` flag.
 *
 * `exposed` returns bare {@link LLMToolSpec} objects — the `deferred`
 * metadata is stripped so it can never leak to provider APIs.
 */
export function partitionDeferredTools(
  tools: LLMToolDescriptor[],
  loaded: ReadonlySet<string>
): {
  exposed: LLMToolSpec[];
  core: LLMToolSpec[];
  loadedDeferred: LLMToolSpec[];
  hidden: LLMToolDescriptor[];
} {
  const core: LLMToolSpec[] = [];
  const loadedDeferred: LLMToolSpec[] = [];
  const hidden: LLMToolDescriptor[] = [];

  for (const tool of tools) {
    if (tool.deferred) {
      if (loaded.has(tool.spec.name)) {
        loadedDeferred.push(tool.spec);
      } else {
        hidden.push(tool);
      }
    } else {
      core.push(tool.spec);
    }
  }

  return {
    exposed: [...core, ...loadedDeferred],
    core,
    loadedDeferred,
    hidden,
  };
}

/**
 * Add an Anthropic prompt-cache breakpoint to the currently exposed tool prefix.
 *
 * Loaded deferred tools change Anthropic's tool prefix, so cache the expanded
 * prefix by marking the last exposed tool while still using only one breakpoint.
 */
export function addToolCacheControl<T extends { name: string }>(
  coreTools: T[],
  loadedDeferredTools: T[]
): {
  tools: Array<T & { cache_control?: typeof CACHE_CONTROL }>;
  cacheControlBlocksUsed: number;
} {
  const tools: Array<T & { cache_control?: typeof CACHE_CONTROL }> = [
    ...coreTools.map((tool) => ({ ...tool })),
    ...loadedDeferredTools.map((tool) => ({ ...tool })),
  ];
  let cacheControlBlocksUsed = 0;

  const cacheIndex = tools.length - 1;
  if (cacheIndex >= 0) {
    tools[cacheIndex] = {
      ...tools[cacheIndex],
      cache_control: CACHE_CONTROL,
    };
    cacheControlBlocksUsed = 1;
  }

  return { tools, cacheControlBlocksUsed };
}

function estimateToolTokens(tools: LLMToolSpec[]): number {
  return tools.length === 0
    ? 0
    : approxTokensFromChars(JSON.stringify(tools).length);
}

function getToolSearchPhase(
  enabled: boolean,
  loadedDeferredToolCount: number
): ToolSearchPhase {
  if (!enabled) return ToolSearchPhase.Disabled;
  return loadedDeferredToolCount > 0
    ? ToolSearchPhase.PostToolSearch
    : ToolSearchPhase.PreToolSearch;
}

export function buildToolSearchMetricsMetadata({
  enabled,
  allTools,
  exposedTools,
  hiddenTools,
  loadedDeferredTools,
  deferredToolsReminder,
}: {
  enabled: boolean;
  allTools: LLMToolDescriptor[];
  exposedTools: LLMToolSpec[];
  hiddenTools: LLMToolDescriptor[];
  loadedDeferredTools: LLMToolSpec[];
  deferredToolsReminder: string;
}): ToolSearchMetricsMetadata {
  const baselineTools = allTools
    .map((tool) => tool.spec)
    .filter((tool) => tool.name !== TOOL_SEARCH_NAME);
  const baselineToolSchemaTokens = estimateToolTokens(baselineTools);
  const exposedToolSchemaTokens = estimateToolTokens(exposedTools);
  const deferredReminderTokens = approxTokensFromChars(
    deferredToolsReminder.length
  );
  const estimatedNetToolContextTokens =
    exposedToolSchemaTokens + deferredReminderTokens;

  return {
    mcpToolSearchEnabled: enabled,
    toolSearchPhase: getToolSearchPhase(enabled, loadedDeferredTools.length),
    baselineToolSchemaTokens,
    exposedToolSchemaTokens,
    deferredReminderTokens,
    estimatedNetToolContextTokens,
    estimatedTokensSaved:
      baselineToolSchemaTokens - estimatedNetToolContextTokens,
    exposedToolCount: exposedTools.length,
    hiddenToolCount: hiddenTools.length,
    loadedDeferredToolCount: loadedDeferredTools.length,
  };
}

/**
 * Build a system-reminder block listing deferred tools that may be omitted
 * from the current tool list. The wording is stable across a session so the
 * reminder remains true after some deferred tools have been loaded.
 */
export function buildDeferredToolsReminder(
  hidden: LLMToolDescriptor[]
): string {
  if (hidden.length === 0) return '';

  const lines = hidden.map((t) => formatDeferredToolLine(t)).join('\n');

  return `${SYSTEM_REMINDER_START}
The tools listed below are available in this environment, but their schemas may be omitted from the current tool list to save context.
Only use ToolSearch for tools that appear in the Deferred tools list below. The only valid ToolSearch names are the exact strings before the colon on each list entry. Use query "select:<name>[,<name>...]" to load one or more of those listed tools before calling them.
Do NOT call ToolSearch for tools that are already present in the current tool list, including core tools like Read, Grep, Glob, LS, Execute, ApplyPatch, AskUser, Create, Edit, TodoWrite, or ExitSpecMode. Call available tools directly.
Once you load a deferred tool it joins your tool list for the rest of the session, so call it directly afterward and never ToolSearch the same tool again.
Do NOT guess tool names or use aliases, invent MCP namespaces, or search for tools not shown in the Deferred tools list. If a needed tool is neither currently available nor listed below, it is unavailable in this session; do not retry ToolSearch for it. Calling an omitted tool directly will fail with InputValidationError.

IMPORTANT: When a user's task matches one of these tools and the tool is absent from the current tool list, load and use it rather than routing around it via Execute. Examples of routing violations to avoid:
- Using curl, wget, or gh pr view <url> instead of loading and calling FetchUrl
- Using gh search or scraping search engines instead of loading and calling WebSearch
- Hitting MCP server HTTP endpoints via curl instead of the corresponding MCP tool

Deferred tools:
${lines}
${SYSTEM_REMINDER_END}`;
}

export function resolveEffectiveToolContext({
  enabled,
  allTools,
  loaded,
}: {
  enabled: boolean;
  allTools: LLMToolDescriptor[];
  loaded: ReadonlySet<string>;
}): {
  tools: ToolWithCacheControl[];
  hidden: LLMToolDescriptor[];
  loadedDeferred: LLMToolSpec[];
  deferredToolsReminder: string;
  toolSearchMetrics: ToolSearchMetricsMetadata;
} {
  if (!enabled) {
    const exposedTools = allTools
      .filter((tool) => tool.spec.name !== TOOL_SEARCH_NAME)
      .map((tool) => tool.spec);

    return {
      tools: exposedTools,
      hidden: [],
      loadedDeferred: [],
      deferredToolsReminder: '',
      toolSearchMetrics: buildToolSearchMetricsMetadata({
        enabled: false,
        allTools,
        exposedTools,
        hiddenTools: [],
        loadedDeferredTools: [],
        deferredToolsReminder: '',
      }),
    };
  }

  const hasDeferredTools = hasDeferredToolDescriptors(allTools);
  const { core, loadedDeferred, hidden } = partitionDeferredTools(
    allTools,
    loaded
  );
  const coreTools = selectCoreToolsForDeferredState(core, hasDeferredTools);
  const { tools } =
    coreTools.length > 0 || loadedDeferred.length > 0
      ? addToolCacheControl(coreTools, loadedDeferred)
      : {
          tools: [...coreTools, ...loadedDeferred],
        };
  const deferredToolsReminder = buildDeferredToolsReminder(hidden);

  return {
    tools,
    hidden,
    loadedDeferred,
    deferredToolsReminder,
    toolSearchMetrics: buildToolSearchMetricsMetadata({
      enabled: true,
      allTools,
      exposedTools: tools,
      hiddenTools: hidden,
      loadedDeferredTools: loadedDeferred,
      deferredToolsReminder,
    }),
  };
}
