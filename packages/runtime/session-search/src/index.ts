/**
 * Session search engine.
 * Provides full-text search across local session history.
 *
 * Shared bloom-filter and snippet primitives live in
 * `@industry/utils/session-search`.
 */

// Core search functions
export { runDroolSearch, warmSearchCache } from './search';

// Types
export type {
  BlockExtractor,
  DroolFindHit,
  DroolFindOptions,
  DroolFindResults,
  DroolFindSessionResult,
  DroolMessageEvent,
  DroolSessionEvent,
  ExtractorContext,
  ExtractorOptions,
  ExtractorRegistration,
  LocallyPersistedDroolMessage,
  SessionJsonlFileHandle,
  SessionSearchDoc,
} from './types';

export type { SessionSummaryEvent } from '@industry/common/session/summary';
