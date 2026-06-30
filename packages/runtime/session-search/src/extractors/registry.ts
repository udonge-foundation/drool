import { SessionSearchDocKind } from '@industry/common/daemon';

import { createDocumentExtractor } from './documentExtractor';
import { createMessageTextExtractor } from './messageTextExtractor';
import { createToolResultExtractor } from './toolResultExtractor';
import { createToolUseExtractor } from './toolUseExtractor';

import type { ExtractorOptions, ExtractorRegistration } from '../types';

// Central registry for extractors and their tweakable output options.
export function getExtractorRegistry(): ExtractorRegistration[] {
  return [
    {
      kind: SessionSearchDocKind.MessageText,
      extractor: createMessageTextExtractor(),
      options: { maxSnippetContextChars: 100 },
    },
    {
      kind: SessionSearchDocKind.Document,
      extractor: createDocumentExtractor(),
      options: { maxSnippetContextChars: 100 },
    },
    {
      kind: SessionSearchDocKind.ToolUse,
      extractor: createToolUseExtractor(),
      options: { maxSnippetContextChars: 100 },
    },
    {
      kind: SessionSearchDocKind.ToolResult,
      extractor: createToolResultExtractor(),
      options: { maxSnippetContextChars: 100 },
    },
  ];
}

export function getExtractorOptionsByKind(): Record<string, ExtractorOptions> {
  return getExtractorRegistry().reduce(
    (acc, item) => {
      acc[item.kind] = item.options;
      return acc;
    },
    {} as Record<string, ExtractorOptions>
  );
}
