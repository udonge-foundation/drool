/**
 * Shared session-search primitives (bloom filters + snippet building).
 * Used by the search engine (@industry/runtime/session-search) and the backend
 * search API.
 */
export {
  bloomAddText,
  bloomFromBase64,
  bloomMerge,
  bloomScoreForQuery,
  bloomToBase64,
  createBloom,
  extractTrigrams,
} from './bloom';

export { buildSnippet } from './snippet';
