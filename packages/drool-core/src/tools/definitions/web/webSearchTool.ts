import {
  ToolExecutionLocation,
  TOOL_LLM_ID_WEB_SEARCH,
} from '@industry/drool-sdk-ext/protocol/tools';

import { exaWebSearchToolSchema, WebSearchToolResultSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const PROVIDER_CAPABILITIES_PLACEHOLDER = '{{PROVIDER_CAPABILITIES}}';

const WEB_SEARCH_DESCRIPTION_TEMPLATE = `Performs a web search to find relevant web pages and documents to the input query. ${PROVIDER_CAPABILITIES_PLACEHOLDER} Use this tool ONLY when the query requires finding specific factual information that would benefit from accessing current web content, such as:
      - Recent news, events, or developments
      - Up-to-date statistics, data points, or facts
      - Information about public entities (companies, organizations, people)
      - Specific published content, articles, or references
      - Current trends or technologies
      - API documents for a publicly available API
      - Public github repositories, and other public code resources
    DO NOT use for:
      - Creative generation (writing, poetry, etc.)
      - Mathematical calculations or problem-solving
      - Code generation or debugging unrelated to web resources
      - Finding code files in a repository in industry

    IMPORTANT - Use the correct year in search queries:
      - Use the current date from the latest system reminder when searching for recent information, documentation, or current events.
      - Example: If today is 2025-07-15 and the user asks for "latest React docs", search for "React documentation 2025", NOT "React documentation 2024"
    `;

const WEB_SEARCH_PROVIDER_CAPABILITIES = {
  exa: 'Has options to filter by search type, category, and domains.',
  you: 'Has options to filter by domains and request full-page text. Do not assume category or search type filters are available.',
  parallel:
    'Takes a natural-language objective plus 2-3 concise keyword search queries (3-6 words each) and returns LLM-optimized excerpts. Has options to filter by domains. Do not assume category, search type, or full-page text options are available.',
} as const;

export function getWebSearchDescription({
  provider = 'exa',
}: {
  provider?: keyof typeof WEB_SEARCH_PROVIDER_CAPABILITIES;
} = {}): string {
  return WEB_SEARCH_DESCRIPTION_TEMPLATE.replace(
    PROVIDER_CAPABILITIES_PLACEHOLDER,
    WEB_SEARCH_PROVIDER_CAPABILITIES[provider]
  );
}

const WEB_SEARCH_DESCRIPTION = getWebSearchDescription({
  provider: 'exa',
});

export const webSearchTool = createTool({
  id: 'web_search',
  llmId: TOOL_LLM_ID_WEB_SEARCH,
  uiGroupId: ToolUIGroupId.WebSearch,
  displayName: 'Web Search',
  description: WEB_SEARCH_DESCRIPTION,
  executionLocation: ToolExecutionLocation.Server,
  inputSchema: exaWebSearchToolSchema,
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.Network],
  outputSchemas: {
    result: WebSearchToolResultSchema,
  },
  toolkit: Toolkit.WebSearch,
  isToolEnabled: true,
});
