/**
 * Search configuration constants.
 * Adjust these values to tune search behavior, performance, and resource usage.
 */

// =============================================================================
// Default Search Options
// =============================================================================

/** Default maximum number of sessions to return in search results. */
export const DEFAULT_LIMIT_SESSIONS = 100;

/** Default maximum number of hits to return per session. */
export const DEFAULT_LIMIT_HITS_PER_SESSION = 3;

/** Default number of characters of context to show around a match in snippets. */
export const DEFAULT_CONTEXT_CHARS = 80;

// =============================================================================
// Candidate Selection
// =============================================================================

/**
 * Multiplier for candidate pre-filtering. We search through (limitSessions * this)
 * top-scoring candidates to account for bloom filter false positives.
 */
export const CANDIDATE_MULTIPLIER = 50;

/**
 * Minimum number of candidates to search through, regardless of limitSessions.
 * Ensures we have enough candidates even with small result limits.
 */
export const MIN_CANDIDATES = 500;

/**
 * Fallback bloom score for queries too short to generate trigrams.
 * Used to ensure short queries still search through candidates.
 */
export const SHORT_QUERY_BASELINE_SCORE = 0.1;

// =============================================================================
// Parallel Processing
// =============================================================================

/**
 * Number of session files to search concurrently.
 * Higher values improve latency but increase memory and file handle usage.
 * 16 balances parallelism with resource usage on most systems.
 */
export const SEARCH_BATCH_SIZE = 16;

// =============================================================================
// Fuzzy Matching
// =============================================================================

/**
 * Minimum query length for fuzzy matching. Shorter queries are too ambiguous
 * and would produce too many false positives with edit distance matching.
 */
export const MIN_FUZZY_QUERY_LEN = 5;

/**
 * Minimum trigram overlap ratio (0-1) required for a fuzzy match candidate.
 * 0.8 means 80% of query trigrams must match the candidate token, ensuring
 * high similarity before allowing edit-distance based fuzzy matching.
 */
export const MIN_TOKEN_TRIGRAM_OVERLAP = 0.8;

// =============================================================================
// Cache Configuration
// =============================================================================

/**
 * Schema version for the search manifest cache.
 * Increment this when the cache format changes to force rebuild.
 */
export const SEARCH_SCHEMA_VERSION = 2;
