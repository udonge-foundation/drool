import { ToolExecutionErrorType } from '@industry/common/session';
import { fetch } from '@industry/drool-core/api/fetch';
import {
  FetchUrlToolResult,
  FetchUrlToolInput,
  GetUrlContentsResponseSchema,
} from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { ToolAbortError } from '@industry/logging/errors';

import { getIndustryApiConfig } from '@/api/config';
import { enforceSandboxNetworkAccess } from '@/sandbox/sandboxGuard';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

// Helper function to format fetched URL content nicely
function formatFetchedUrlContent(
  result: FetchUrlToolResult,
  url: string
): string {
  const { markdown, title, metadata, linkedUrls } = result;

  if (!markdown) {
    return `URL Content from: "${url}"\n\nNo content found.`;
  }

  const header = `URL Content from: "${url}"`;
  const titleLine = title ? `\nTitle: ${title}` : '';
  const metadataLine = metadata?.statusCode
    ? `\nStatus: ${metadata.statusCode}`
    : '';

  const contentHeader = `\nMarkdown content:\n`;

  // Add linked URLs section if present
  const linkedUrlsSection =
    linkedUrls && linkedUrls.length > 0
      ? `\n\nLinked URLs found in content:\n${linkedUrls.map((linkedUrl) => `- ${linkedUrl}`).join('\n')}`
      : '';

  return `${header}${titleLine}${metadataLine}${contentHeader}\n${markdown}${linkedUrlsSection}`;
}

function makeToolError(
  errorType: ToolExecutionErrorType,
  llmError: string,
  userError: string
): DraftToolFeedback<string> {
  return {
    type: DraftToolFeedbackType.Result,
    isError: true,
    errorType,
    llmError,
    userError,
  };
}

function isHttpUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function makeInvalidEffectiveUrlError(): DraftToolFeedback<string> {
  return makeToolError(
    ToolExecutionErrorType.ToolInternalError,
    'FetchUrl failed closed because the effective URL was missing or invalid',
    'URL fetch failed sandbox validation'
  );
}

// The automatic curl/wget fallback was removed; instead, when the Industry fetch
// service can't return content, tell the agent it can fetch the URL itself. We
// intentionally omit the URL from the hint: the agent already sees the failed
// tool call and its parameters, so it can decide how to proceed.
function curlMitigationHint(): string {
  return ` If you still need this content, you can fetch it yourself with the Execute tool, e.g. \`curl -sSL --max-time 30 -- "<url>"\`.`;
}

export class FetchUrlExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: FetchUrlToolInput
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { url } = parameters;

    if (!url || typeof url !== 'string') {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'url parameter is required and must be a string',
        userError: 'Invalid URL provided',
      };
      return;
    }

    // Reject non-HTTP(S) schemes to prevent file:// and other local access
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.InvalidParameterLLMError,
          llmError: `Unsupported URL scheme: ${parsed.protocol} — only http and https are allowed`,
          userError: 'Only http and https URLs are supported',
        };
        return;
      }
    } catch {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: `Invalid URL: ${url}`,
        userError: 'Invalid URL provided',
      };
      return;
    }

    let parsedResponse: ReturnType<
      typeof GetUrlContentsResponseSchema.safeParse
    >;
    try {
      const response = await fetch(
        '/api/tools/get-url-contents',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url }),
          signal: dependencies.abortSignal,
        },
        getIndustryApiConfig()
      );
      // Validate the backend response shape. A malformed payload (for example,
      // one missing the canonical effective URL) fails closed rather than
      // surfacing unvalidated content.
      parsedResponse = GetUrlContentsResponseSchema.safeParse(
        await response.json()
      );
    } catch (error) {
      if (
        dependencies.abortSignal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw new ToolAbortError();
      }
      yield makeToolError(
        ToolExecutionErrorType.ExternalAPIError,
        `Failed to fetch URL content from the Industry API.${curlMitigationHint()}`,
        'URL fetch failed'
      );
      return;
    }

    if (!parsedResponse.success) {
      yield makeInvalidEffectiveUrlError();
      return;
    }

    const result = parsedResponse.data;

    // Backend returned a structured error — surface it, plus a hint that the
    // agent can fetch the URL manually now that the curl/wget fallback is gone.
    if (!result.data) {
      yield makeToolError(
        result.error?.type ?? ToolExecutionErrorType.ExternalAPIError,
        `${result.error?.llmError ?? 'Failed to fetch URL content'}${curlMitigationHint()}`,
        result.error?.userError ?? 'URL fetch failed'
      );
      return;
    }

    const apiResult = result.data;

    // Revalidate the backend's canonical effective URL against the sandbox
    // before surfacing content. The backend resolves redirects server-side, so a
    // denied final host must fail closed here even though the request itself ran
    // on trusted infrastructure. These security fail-closed paths intentionally
    // omit the curl hint so we never suggest curling a blocked URL.
    if (!isHttpUrl(apiResult.effectiveUrl)) {
      yield makeInvalidEffectiveUrlError();
      return;
    }
    const denial = await enforceSandboxNetworkAccess(apiResult.effectiveUrl, {
      toolCallId: dependencies.toolCallId,
      toolName: 'FetchUrl',
      toolInput: parameters,
      requestPermissionFn: dependencies.requestPermissionFn,
    });
    if (denial) {
      yield makeToolError(
        ToolExecutionErrorType.ToolInternalError,
        denial,
        denial
      );
      return;
    }

    const formattedResult = formatFetchedUrlContent(apiResult, url);
    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: formattedResult,
    };
  }
}
