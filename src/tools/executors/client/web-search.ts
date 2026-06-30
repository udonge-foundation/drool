import { ToolExecutionErrorType } from '@industry/common/session';
import { fetch } from '@industry/drool-core/api/fetch';
import {
  ExaWebSearchToolResult,
  ParallelWebSearchToolInput,
  ParallelWebSearchToolResult,
  WebSearchToolInput,
  WebSearchToolResult,
  YouWebSearchToolResult,
} from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { ToolAbortError } from '@industry/logging/errors';

import { getIndustryApiConfig } from '@/api/config';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

type DisplayWebSearchResult = ExaWebSearchToolResult['results'][number];
type YouWebSearchResultGroups = NonNullable<YouWebSearchToolResult['results']>;
type YouWebSearchResultItem = NonNullable<
  YouWebSearchResultGroups['web']
>[number];
type ParallelWebSearchResultItem =
  ParallelWebSearchToolResult['results'][number];

type WebSearchExecutorParameters =
  | WebSearchToolInput
  | ParallelWebSearchToolInput;

const MAX_DISPLAY_URL_LENGTH = 80;
const MAX_DISPLAY_SUMMARY_LENGTH = 200;

function truncateDisplayUrl(url: string): string {
  return url.length > MAX_DISPLAY_URL_LENGTH
    ? `${url.slice(0, MAX_DISPLAY_URL_LENGTH - 3)}...`
    : url;
}

function truncateDisplaySummary(summary: string): string {
  return summary.length > MAX_DISPLAY_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_DISPLAY_SUMMARY_LENGTH)}...`
    : summary;
}

interface GetFormattedResultParams {
  title: string;
  url: string;
  publishedDate?: string | null;
  author?: string | null;
  summary?: string;
  text?: string;
}

function isParallelWebSearchToolResult(
  result: WebSearchToolResult
): result is ParallelWebSearchToolResult {
  return (
    Array.isArray(result.results) &&
    result.results.some(
      (item) => typeof item === 'object' && item !== null && 'excerpts' in item
    )
  );
}

function isExaWebSearchToolResult(
  result: WebSearchToolResult
): result is ExaWebSearchToolResult {
  return Array.isArray(result.results);
}

function getFormattedResultEntry({
  title,
  url,
  publishedDate,
  author,
  summary,
  text,
}: GetFormattedResultParams): string {
  const displayUrl = truncateDisplayUrl(url);
  const metadata = [];

  if (publishedDate) {
    metadata.push(`Published: ${publishedDate}`);
  }

  if (author) {
    metadata.push(`Author: ${author}`);
  }

  const metadataLine = metadata.length > 0 ? `   ${metadata.join(' | ')}` : '';
  const description = summary || text;
  const displayDescription = description
    ? truncateDisplaySummary(description)
    : undefined;
  const summaryLine = description ? `\n   \n   ${displayDescription}` : '';

  return `**${title}**\n   URL: ${displayUrl}${metadataLine ? `\n${metadataLine}` : ''}${summaryLine}`;
}

function formatExaResults(results: DisplayWebSearchResult[]): string[] {
  return results.map((item) =>
    getFormattedResultEntry({
      title: item.title || 'Untitled',
      url: item.url,
      publishedDate: item.publishedDate,
      author: item.author,
      summary: item.summary,
      text: item.text,
    })
  );
}

function formatParallelResults(
  results: ParallelWebSearchResultItem[]
): string[] {
  return results.map((item) =>
    getFormattedResultEntry({
      title: item.title || 'Untitled',
      url: item.url,
      publishedDate: item.publish_date,
      summary: item.excerpts.join(' '),
    })
  );
}

function formatYouResults(result: YouWebSearchToolResult): string[] {
  return [...(result.results?.web ?? []), ...(result.results?.news ?? [])]
    .filter(
      (item): item is YouWebSearchResultItem & { title: string; url: string } =>
        Boolean(item.title && item.url)
    )
    .map((item) =>
      getFormattedResultEntry({
        title: item.title,
        url: item.url,
        publishedDate: item.page_age,
        author: item.authors?.[0],
        summary: item.description ?? item.snippets?.join(' '),
        text: item.contents?.markdown,
      })
    );
}

function getFormattedResults(result: WebSearchToolResult): string[] {
  if (isParallelWebSearchToolResult(result)) {
    return formatParallelResults(result.results);
  }

  if (isExaWebSearchToolResult(result)) {
    return formatExaResults(result.results);
  }

  return formatYouResults(result);
}

function formatWebSearchResults(
  result: WebSearchToolResult,
  query: string
): string {
  const formattedResults = getFormattedResults(result);

  if (formattedResults.length === 0) {
    return `Web Search Results for: "${query}"\n\nNo results found.`;
  }

  const header = `Web Search Results for: "${query}"`;
  const separator = '\n\n---\n\n';
  const footer = `\nFound ${formattedResults.length} result${formattedResults.length === 1 ? '' : 's'}`;

  return `${header}\n\n${formattedResults.join(separator)}${footer}`;
}

export class WebSearchExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: WebSearchExecutorParameters
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const query =
      'query' in parameters ? parameters.query : parameters.objective;

    if (!query || typeof query !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError:
          'query parameter (or objective, depending on the tool schema) is required and must be a string',
        userError: 'Invalid query provided',
      };
      return;
    }

    try {
      const response = await fetch(
        '/api/tools/web-search',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(parameters),
          signal: dependencies.abortSignal,
        },
        getIndustryApiConfig()
      );
      const result = (await response.json()) as WebSearchToolResult;
      const formattedResult = formatWebSearchResults(result, query);
      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: formattedResult,
      };
    } catch (error) {
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
        llmError: `Error performing web search: ${errorMessage}`,
        userError: 'Web search failed',
      };
    }
  }
}
