/**
 * FileSearch - AsyncFzf-based fuzzy search for file paths (Gemini-style).
 *
 * Features:
 * - Uses AsyncFzf for non-blocking fuzzy search
 * - Automatic algorithm selection (v1 for short queries, v2 for longer)
 * - Query timeout support (default 5s)
 * - Abort/cancellation support for search operations
 * - Smart scoring with byLengthAsc tiebreaker for consistent results
 * - Integrates with FileIndexer for indexed file paths
 */

import { AsyncFzf, byLengthAsc, FzfResultItem } from 'fzf';

import { Metric } from '@industry/logging/metrics/enums';

import type {
  FileSearchOptions,
  FileSearchResult,
  SearchOutput,
} from '@/services/types';
import {
  getQueryLengthBucket,
  getResultCountBucket,
} from '@/utils/inputLatencyMetrics';
import { recordStartupLatency } from '@/utils/startupLatency';

// Constants
const DEFAULT_TIMEOUT_MS = 5_000; // 5 seconds
const DEFAULT_MAX_RESULTS = 100;

// Threshold for switching from v1 (fast) to v2 (better positions) algorithm
// For queries <= 3 chars, v1 is fast enough and positions don't matter much
const V2_QUERY_LENGTH_THRESHOLD = 3;

// Threshold for considering a dataset "large" (affects algorithm choice)
const LARGE_DATASET_THRESHOLD = 10_000;

/**
 * FileSearch provides async fuzzy search over a list of file paths using AsyncFzf.
 *
 * Key behaviors:
 * - Uses v1 algorithm for short queries (≤3 chars) or large datasets for speed
 * - Uses v2 algorithm for longer queries (better match positions)
 * - Supports query timeout (default 5s) to prevent UI blocking
 * - Supports AbortSignal for cancellation
 * - Sorts by score with byLengthAsc tiebreaker (prefer shorter paths)
 */
export class FileSearch {
  private candidates: string[];

  private options: Required<FileSearchOptions>;

  // Pre-built Fzf instances for reuse
  private fzfV1: AsyncFzf<string[]> | null = null;

  private fzfV2: AsyncFzf<string[]> | null = null;

  constructor(candidates: string[], options: FileSearchOptions = {}) {
    this.candidates = candidates;
    this.options = {
      maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /**
   * Update the candidate list (e.g., after a new index crawl).
   * Invalidates cached Fzf instances.
   */
  setCandidates(candidates: string[]): void {
    this.candidates = candidates;
    // Invalidate cached instances so they get rebuilt
    this.fzfV1 = null;
    this.fzfV2 = null;
  }

  /**
   * Get the current candidate list.
   */
  getCandidates(): string[] {
    return this.candidates;
  }

  /**
   * Get or create a cached Fzf instance for the given algorithm version.
   */
  private getFzfInstance(useV1: boolean): AsyncFzf<string[]> {
    if (useV1) {
      if (!this.fzfV1) {
        // v1 is faster but less accurate match positions
        this.fzfV1 = new AsyncFzf(this.candidates, {
          fuzzy: 'v1',
          limit: this.options.maxResults,
          tiebreakers: [byLengthAsc],
        });
      }
      return this.fzfV1;
    }
    if (!this.fzfV2) {
      // v2 has better match positions but is slower
      this.fzfV2 = new AsyncFzf(this.candidates, {
        fuzzy: 'v2',
        limit: this.options.maxResults,
        tiebreakers: [byLengthAsc],
      });
    }
    return this.fzfV2;
  }

  /**
   * Determine whether to use v1 (fast) or v2 (better positions) algorithm.
   *
   * Strategy:
   * - Short queries (≤3 chars): use v1 (positions matter less, speed matters more)
   * - Large datasets (>10k): use v1 (speed matters more)
   * - Otherwise: use v2 (better positions for longer queries)
   */
  private shouldUseV1Algorithm(queryLength: number): boolean {
    // Short queries: v1 is fast enough and position accuracy doesn't matter much
    if (queryLength <= V2_QUERY_LENGTH_THRESHOLD) {
      return true;
    }

    // Large datasets: prefer v1 for speed
    if (this.candidates.length > LARGE_DATASET_THRESHOLD) {
      return true;
    }

    // Default: use v2 for better match positions
    return false;
  }

  /**
   * Perform fuzzy search with timeout and optional abort support.
   *
   * @param query - The search query string
   * @param abortSignal - Optional AbortSignal for cancellation
   * @returns SearchOutput with results, timeout/abort flags, and duration
   */
  async search(
    query: string,
    abortSignal?: AbortSignal
  ): Promise<SearchOutput> {
    const startTime = Date.now();
    const perfStart = performance.now();

    // Handle empty query: return empty results (recents/all files should be handled by caller)
    if (!query || query.trim() === '') {
      return {
        results: [],
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startTime,
      };
    }

    // Check if already aborted before starting
    if (abortSignal?.aborted) {
      return {
        results: [],
        timedOut: false,
        aborted: true,
        durationMs: Date.now() - startTime,
      };
    }

    // Select algorithm based on query length and dataset size
    const useV1 = this.shouldUseV1Algorithm(query.length);
    const algorithm = useV1 ? 'v1' : 'v2';
    const fzf = this.getFzfInstance(useV1);

    // Track cleanup functions to ensure no resource leaks
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    // Cleanup function to remove listeners and clear timers
    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (abortHandler && abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
    };

    try {
      // Create a promise that rejects on abort
      const abortPromise = abortSignal
        ? new Promise<never>((_, reject) => {
            if (abortSignal.aborted) {
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            abortHandler = () => {
              reject(new DOMException('Aborted', 'AbortError'));
            };
            // Use { once: true } to automatically remove listener after first trigger
            abortSignal.addEventListener('abort', abortHandler, { once: true });
          })
        : null;

      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('Search timeout'));
        }, this.options.timeoutMs);
      });

      // Race between search, timeout, and abort
      const searchPromise = fzf.find(query);

      const racingPromises: Promise<FzfResultItem<string>[]>[] = [
        searchPromise,
        timeoutPromise,
      ];
      if (abortPromise) {
        racingPromises.push(abortPromise);
      }

      const rawResults = await Promise.race(racingPromises);

      // Cleanup before returning successful result
      cleanup();

      // Map Fzf results to our FileSearchResult format
      const results: FileSearchResult[] = rawResults.map((item) => ({
        path: item.item,
        score: item.score,
        positions: item.positions,
      }));
      recordStartupLatency(Metric.CLI_TUI_FILE_SEARCH_LATENCY, perfStart, {
        aborted: 'false',
        algorithm,
        outcome: 'success',
        queryLengthBucket: getQueryLengthBucket(query),
        resultCountBucket: getResultCountBucket(results.length),
        timedOut: 'false',
      });

      return {
        results,
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      // Always cleanup on error path
      cleanup();

      const durationMs = Date.now() - startTime;

      // Check for abort
      if (error instanceof DOMException && error.name === 'AbortError') {
        recordStartupLatency(Metric.CLI_TUI_FILE_SEARCH_LATENCY, perfStart, {
          aborted: 'true',
          algorithm,
          outcome: 'aborted',
          queryLengthBucket: getQueryLengthBucket(query),
          resultCountBucket: '0',
          timedOut: 'false',
        });
        return {
          results: [],
          timedOut: false,
          aborted: true,
          durationMs,
        };
      }

      // Check for timeout
      if (error instanceof Error && error.message === 'Search timeout') {
        recordStartupLatency(Metric.CLI_TUI_FILE_SEARCH_LATENCY, perfStart, {
          aborted: 'false',
          algorithm,
          outcome: 'timeout',
          queryLengthBucket: getQueryLengthBucket(query),
          resultCountBucket: '0',
          timedOut: 'true',
        });
        return {
          results: [],
          timedOut: true,
          aborted: false,
          durationMs,
        };
      }

      // Re-throw unexpected errors
      recordStartupLatency(Metric.CLI_TUI_FILE_SEARCH_LATENCY, perfStart, {
        aborted: 'false',
        algorithm,
        outcome: 'error',
        queryLengthBucket: getQueryLengthBucket(query),
        resultCountBucket: '0',
        timedOut: 'false',
      });
      throw error;
    }
  }
}

// Singleton instance management
let fileSearchInstance: FileSearch | null = null;

/**
 * Get or create a FileSearch instance for the given candidates.
 * @public
 *
 * @param candidates - Array of file paths to search
 * @param options - Optional configuration
 * @returns FileSearch instance
 */
export function getFileSearch(
  candidates: string[],
  options?: FileSearchOptions
): FileSearch {
  // Check if we need to create a new instance or update candidates
  const needsNewInstance = !fileSearchInstance;
  const needsUpdate =
    fileSearchInstance &&
    candidates.length !== fileSearchInstance.getCandidates().length;

  if (needsNewInstance) {
    fileSearchInstance = new FileSearch(candidates, options);
  } else if (needsUpdate && fileSearchInstance) {
    fileSearchInstance.setCandidates(candidates);
  }

  // fileSearchInstance is guaranteed to be non-null at this point
  // (either we just created it, or it already existed)
  return fileSearchInstance!;
}

/** @public */
export function resetFileSearch(): void {
  fileSearchInstance = null;
}
