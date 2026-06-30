import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import { ToolExecutionErrorType } from '@industry/common/session';

import type { InputJSONSchema } from '../../types';

const exaWebSearchToolResultItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  publishedDate: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
  text: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  summary: z.string().optional(),
  favicon: z.string().optional(),
});

const youWebSearchToolResultItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  snippets: z.array(z.string()).optional(),
  authors: z.array(z.string()).optional(),
  page_age: z.string().optional(),
  favicon_url: z.string().optional(),
  contents: z
    .object({
      markdown: z.string().optional(),
    })
    .optional(),
});

const ExaWebSearchToolResultSchema = z.object({
  results: z.array(exaWebSearchToolResultItemSchema),
  searchType: z.enum(['neural', 'keyword', 'auto']).optional(),
});

export type ExaWebSearchToolResult = z.infer<
  typeof ExaWebSearchToolResultSchema
>;

export const YouWebSearchToolResultSchema = z.object({
  results: z
    .object({
      web: z.array(youWebSearchToolResultItemSchema).optional(),
      news: z.array(youWebSearchToolResultItemSchema).optional(),
    })
    .optional(),
});

export type YouWebSearchToolResult = z.infer<
  typeof YouWebSearchToolResultSchema
>;

const parallelWebSearchToolResultItemSchema = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  publish_date: z.string().nullable().optional(),
  excerpts: z.array(z.string()),
});

export const ParallelWebSearchToolResultSchema = z.object({
  results: z.array(parallelWebSearchToolResultItemSchema),
});

export type ParallelWebSearchToolResult = z.infer<
  typeof ParallelWebSearchToolResultSchema
>;

export const WebSearchToolResultSchema = z.union([
  ParallelWebSearchToolResultSchema,
  ExaWebSearchToolResultSchema,
  YouWebSearchToolResultSchema,
]);

export type WebSearchToolResult = z.infer<typeof WebSearchToolResultSchema>;

// Light coercion: string number to number
const coerceNum = z.preprocess((v) => {
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? v : n;
  }
  return v;
}, z.number().int().positive().max(20));

// Light coercion: string to boolean
const coerceBool = z.preprocess((v) => {
  if (typeof v === 'string') {
    const normalized = v.toLowerCase().trim();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    return v;
  }
  return v;
}, z.boolean());

const querySchema = z.string().describe('The search query string');

const numResultsSchema = coerceNum
  .optional()
  .describe(
    'Number of results to return (default: 10). Must be an integer (e.g., 10), not a string. 1-20 allowed. Optional field.'
  );

const includeDomainsSchema = z
  .array(z.string())
  .optional()
  .describe(
    'Array of domains to include (e.g., ["example.com", "developer.mozilla.org"]). Must be an array of strings. IMPORTANT: Only one of includeDomains or excludeDomains should be used, not both. Optional field.'
  );

const excludeDomainsSchema = z
  .array(z.string())
  .optional()
  .describe(
    'Array of domains to exclude (e.g., ["spam.com"]). Optional; should almost never be used. IMPORTANT: Only one of includeDomains or excludeDomains should be used, not both. Optional field.'
  );

const textSchema = coerceBool
  .optional()
  .describe(
    'Whether to include full text content in results. Boolean true/false, not a string.'
  );

export const youWebSearchToolSchema = z
  .object({
    query: querySchema,
    numResults: numResultsSchema,
    includeDomains: includeDomainsSchema,
    excludeDomains: excludeDomainsSchema,
    text: textSchema,
  })
  .strict();

export type YouWebSearchToolInput = z.infer<typeof youWebSearchToolSchema>;

export const parallelWebSearchToolSchema = z
  .object({
    objective: z
      .string()
      .describe(
        'Natural-language description of the question or goal driving the search. Must be self-contained with enough context to understand the intent of the search.'
      ),
    searchQueries: z
      .array(z.string())
      .min(1)
      .describe(
        'Concise keyword search queries, 3-6 words each. Provide 2-3 queries for best results. Used together with objective to focus results on the most relevant content.'
      ),
    numResults: numResultsSchema,
    includeDomains: includeDomainsSchema,
    excludeDomains: excludeDomainsSchema,
  })
  .strict();

export type ParallelWebSearchToolInput = z.infer<
  typeof parallelWebSearchToolSchema
>;

export const exaWebSearchToolSchema = z
  .object({
    query: querySchema,
    type: z
      .enum(['keyword', 'neural', 'auto'])
      .optional()
      .describe(
        'The type of search. Neural uses embeddings-based model, keyword is google-like SERP. Default is auto. Should use default in most scenarios.'
      ),
    category: z
      .enum([
        'company',
        'research paper',
        'news',
        'pdf',
        'github',
        'tweet',
        'personal site',
        'linkedin profile',
        'financial report',
      ])
      .optional()
      .describe('A data category to focus on. Optional field.'),
    numResults: numResultsSchema,
    includeDomains: includeDomainsSchema,
    excludeDomains: excludeDomainsSchema,
    text: textSchema,
  })
  .strict();

export type ExaWebSearchToolInput = z.infer<typeof exaWebSearchToolSchema>;

export type WebSearchToolInput = ExaWebSearchToolInput;

export const exaWebSearchToolInputJsonSchema = zodToJsonSchema(
  exaWebSearchToolSchema
) as InputJSONSchema;

export const youWebSearchToolInputJsonSchema = zodToJsonSchema(
  youWebSearchToolSchema
) as InputJSONSchema;

export const parallelWebSearchToolInputJsonSchema = zodToJsonSchema(
  parallelWebSearchToolSchema
) as InputJSONSchema;

export const FetchUrlToolResultSchema = z.object({
  markdown: z.string().describe('The scraped content in markdown format'),
  title: z.string().nullable().describe('The title of the webpage'),
  effectiveUrl: z
    .string()
    .url()
    .describe('The final effective URL after redirects, or the requested URL'),
  metadata: z
    .object({
      url: z.string().describe('The URL that was scraped'),
      statusCode: z.number().describe('The HTTP status code of the response'),
      error: z.string().nullable().describe('Error message if any'),
      title: z.string().nullable().describe('The title of the webpage'),
    })
    .describe('Metadata about the scraped webpage'),
  linkedUrls: z
    .array(z.string())
    .optional()
    .describe(
      'Array of integration URLs found in the content (e.g., from Slack threads)'
    ),
});

export type FetchUrlToolResult = z.infer<typeof FetchUrlToolResultSchema>;

const FetchUrlToolErrorResponseSchema = z
  .object({
    type: z.nativeEnum(ToolExecutionErrorType),
    userError: z.string(),
    llmError: z.string(),
  })
  .strict();

export type FetchUrlToolErrorResponse = z.infer<
  typeof FetchUrlToolErrorResponseSchema
>;

export const GetUrlContentsResponseSchema = z.union([
  z
    .object({
      data: FetchUrlToolResultSchema,
      error: z.never().optional(),
    })
    .strict(),
  z
    .object({
      error: FetchUrlToolErrorResponseSchema,
      data: z.never().optional(),
    })
    .strict(),
]);

export type GetUrlContentsResponse = z.infer<
  typeof GetUrlContentsResponseSchema
>;

export const fetchUrlToolSchema = z.object({
  url: z.string().url().describe('The URL to scrape content from'),
});

export type FetchUrlToolInput = z.infer<typeof fetchUrlToolSchema>;
