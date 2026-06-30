/**
 * FuseSearch - Enhanced fuzzy file search using Fuse.js
 *
 * Provides VSCode-quality file search with:
 * - Path-aware scoring
 * - camelCase matching
 * - Word boundary detection
 * - Consecutive character bonuses
 */

import Fuse, { type FuseResult } from 'fuse.js';

import type { FuseSearchOptions, ProcessedQuery, SearchResult } from './types';

const DEFAULT_OPTIONS: Required<FuseSearchOptions> = {
  maxResults: 50,
  threshold: 0.4,
  includeMatches: false,
  excludePatterns: [],
};

export class FuseSearch {
  private fuse: Fuse<string>;

  private haystack: string[];

  private options: Required<FuseSearchOptions>;

  constructor(files: string[], options: FuseSearchOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // IMPORTANT: All file paths must be normalized to POSIX format (forward slashes)
    // before passing to FuseSearch. This ensures cross-platform compatibility.
    // Path operations below assume forward slashes.

    // Pre-filter excluded files
    this.haystack = this.filterExcludedFiles(files);

    // Configure Fuse.js for file search
    this.fuse = new Fuse(this.haystack, {
      // Scoring configuration
      threshold: this.options.threshold,
      distance: 1000, // Allow far-apart chars in long paths
      ignoreLocation: false, // Prefer matches near start
      location: 0, // Start position preference

      // Match configuration
      minMatchCharLength: 1,
      findAllMatches: false,

      // Output configuration
      includeScore: true,
      includeMatches: this.options.includeMatches,
    });
  }

  /**
   * Search for files matching the query
   */
  search(query: string): SearchResult[] {
    if (!query || query.trim() === '') {
      return [];
    }

    const processedQuery = FuseSearch.preprocessQuery(query);

    // Get results from Fuse.js (request 3x to have room for re-ranking)
    const fuseResults = this.fuse.search(processedQuery.normalized, {
      limit: this.options.maxResults * 3,
    });

    // Enhance scores with VSCode-inspired bonuses
    const enhancedResults = fuseResults.map((result) =>
      FuseSearch.enhanceResult(result, processedQuery)
    );

    // Sort by enhanced score with deterministic tie-breaking
    enhancedResults.sort((a, b) => {
      const scoreDiff = b.score - a.score;

      // If scores are EXACTLY equal (floating point comparison), use deterministic tie-breaking
      // Use a very tight epsilon (0.001) to only catch true ties, not close scores
      const EPSILON = 0.001; // Only for true floating-point ties
      if (Math.abs(scoreDiff) < EPSILON) {
        // 1. Prefer shorter paths (fewer directory levels = more specific)
        const depthA = a.item.split('/').length;
        const depthB = b.item.split('/').length;
        if (depthA !== depthB) {
          return depthA - depthB;
        }

        // 2. Prefer non-test files over test files (production code > tests)
        const isTestA = /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(a.item);
        const isTestB = /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(b.item);
        if (isTestA !== isTestB) {
          return isTestA ? 1 : -1; // Non-test files first
        }

        // 3. Alphabetical order (final deterministic tie-breaker)
        return a.item.localeCompare(b.item);
      }

      return scoreDiff;
    });

    return enhancedResults.slice(0, this.options.maxResults);
  }

  /**
   * Pre-process query for better matching
   */
  private static preprocessQuery(query: string): ProcessedQuery {
    const normalized = query.toLowerCase().trim();
    const hasUppercase = /[A-Z]/.test(query);

    return {
      original: query,
      normalized,
      hasUppercase,
      length: normalized.length,
    };
  }

  /**
   * Enhance Fuse.js result with VSCode-inspired scoring
   */
  private static enhanceResult(
    result: FuseResult<string>,
    query: ProcessedQuery
  ): SearchResult {
    const filePath = result.item;
    const fuseScore = result.score ?? 1;

    // Start with inverted Fuse score (higher = better)
    let score = 1 - fuseScore;

    // Pre-compute all values to avoid redundant calculations
    const fileName = filePath.split('/').pop() ?? '';
    const fileNameLower = fileName.toLowerCase();
    const fileNameWithoutExt = fileName.replace(/\.[^.]+$/, '');
    const fileNameWithoutExtLower = fileNameWithoutExt.toLowerCase();
    const lowerPath = filePath.toLowerCase();
    const normalized = query.normalized;
    const original = query.original;
    const hasMixedCase = /[a-z]/.test(original) && /[A-Z]/.test(original);

    // Fast path: Check for consecutive match first
    const hasConsecutive = lowerPath.includes(normalized);

    score += FuseSearch.calculatePathBonus(
      filePath,
      query,
      fileName,
      fileNameLower,
      fileNameWithoutExt,
      fileNameWithoutExtLower,
      hasMixedCase
    );

    // Only calculate expensive bonuses if query length warrants it
    if (query.length >= 2) {
      score += FuseSearch.calculateCamelCaseBonus(fileName, query);
    }

    if (query.hasUppercase) {
      score += FuseSearch.calculateCasePatternBonus(fileName, query);
    }

    // Features removed during ablation study (neutral impact on nDCG):
    // - Word boundary bonus
    // - Start position bonus
    // - Consecutive character bonus
    // - Length ratio bonus
    // - Scattered match penalty (actually hurt quality when enabled)

    // Only run expensive multi-segment for longer queries
    if (normalized.length >= 6) {
      score += FuseSearch.calculateMultiSegmentBonus(filePath, query);
    }

    // Apply sequence penalty for missing/out-of-order letters (only if not consecutive)
    if (!hasConsecutive) {
      score -= FuseSearch.calculateSequencePenalty(
        fileNameLower,
        query,
        normalized
      );
    }

    // Apply position penalty (penalize late-starting matches)
    score -= FuseSearch.calculatePositionPenalty(
      fileName,
      fileNameLower,
      query,
      normalized
    );

    // Penalize short filenames (prevents single-char files from ranking too high)
    if (fileNameWithoutExt.length <= 2 && normalized.length >= 2) {
      score -= 15.0; // Heavy penalty for 1-2 char filenames
    }

    // Penalty for same-length short matches (ambiguous)
    if (
      fileNameWithoutExt.length === normalized.length &&
      normalized.length <= 3
    ) {
      score -= 10.0; // Penalty for same-length short matches
    }

    // Extra penalty for single-char files
    if (fileNameWithoutExt.length === 1 && normalized.length > 1) {
      score -= 6.0; // Additional strong penalty for single-char files
    }

    return {
      item: filePath,
      fuseScore,
      score,
      matches: result.matches as
        | ReadonlyArray<{
            indices: readonly [number, number][];
            value?: string;
            key?: string;
          }>
        | undefined,
    };
  }

  /**
   * Calculate path-aware bonuses for filename matches and path depth
   */
  private static calculatePathBonus(
    filePath: string,
    query: ProcessedQuery,
    fileName: string,
    fileNameLower: string,
    fileNameWithoutExt: string,
    fileNameWithoutExtLower: string,
    hasMixedCase: boolean
  ): number {
    const segments = filePath.split('/');
    const normalized = query.normalized;
    const original = query.original;

    let bonus = 0;

    // 0. EXACT PATH MATCH (highest priority, before filename checks)
    const lowerPath = filePath.toLowerCase();
    if (lowerPath === normalized) {
      return 300.0; // MAXIMUM POSSIBLE - exact path match
    }

    // Directory prefix match: query is "src/hooks", path is "src/hooks/"
    if (lowerPath === `${normalized}/` || `${lowerPath}/` === normalized) {
      return 290.0; // Nearly maximum - directory form of exact match
    }

    // Query is drilling into this directory: "src/hooks/foo" query, "src/hooks" path
    if (normalized.startsWith(`${lowerPath}/`)) {
      return 280.0; // Very high - user is typing a path under this directory
    }

    // Path is a prefix match of query: "src/ho" query, "src/hooks" or "src/hooks/" path
    // This handles both exact segment matches and partial directory name matches
    // Works for paths with or without trailing slashes
    if (lowerPath.startsWith(normalized)) {
      // Check if this is a directory path (not a file)
      // A path is a directory if:
      // 1. It ends with "/" (explicit directory marker), OR
      // 2. It contains "/" AND doesn't have a file extension after the last "/"
      const lastSlash = lowerPath.lastIndexOf('/');
      const hasSlash = lastSlash >= 0;
      const hasFileExtension =
        hasSlash && lowerPath.indexOf('.', lastSlash) > lastSlash;
      const looksLikeDirectory =
        lowerPath.endsWith('/') || (hasSlash && !hasFileExtension);

      if (looksLikeDirectory) {
        let directoryBonus = 270.0;

        // For path queries (containing "/"), add extra bonus
        if (normalized.includes('/')) {
          directoryBonus += 10.0;
        }

        // Bonus for how well the last segment matches the query suffix
        // Example: "src/ho" matches "src/hooks" better than "src/home"
        // Longer segments are more specific, so we prefer them
        const lastSlashInQuery = normalized.lastIndexOf('/');
        if (lastSlashInQuery >= 0) {
          const querySegment = normalized.substring(lastSlashInQuery + 1);
          const pathSegments = lowerPath.split('/').filter((s) => s.length > 0);
          const lastPathSegment = pathSegments[pathSegments.length - 1] || '';

          // Check if last path segment starts with query segment
          if (lastPathSegment.startsWith(querySegment)) {
            // Bonus based on segment length (longer segments are more specific)
            // "hooks" (5 chars) should rank higher than "home" (4 chars) for query "ho"
            const lengthBonus = Math.min(lastPathSegment.length, 10) * 0.5;
            directoryBonus += lengthBonus;
          }
        }

        return directoryBonus;
      }
    }

    // 1. EXACT FILENAME MATCH (early exit)
    // Query matches filename including extension (most specific)
    if (fileNameLower === normalized) {
      // Base bonus for exact match (case-insensitive)
      let exactBonus = 490.0; // ABSOLUTE MAXIMUM - exact filename match with extension

      // Add bonus for exact case match
      if (fileName === original) {
        exactBonus += 10.0; // Prefer exact case match
      }

      return exactBonus;
    }

    // Query matches filename without extension (very strong)
    if (fileNameWithoutExtLower === normalized) {
      // Base bonus for exact match without extension (case-insensitive)
      let exactBonus = 450.0; // Nearly maximum - exact filename match without extension

      // Add bonus for exact case match
      if (fileNameWithoutExt === original) {
        exactBonus += 10.0; // Prefer exact case match
      }

      return exactBonus;
    }

    // 2. PREFIX MATCH
    if (fileNameWithoutExtLower.startsWith(normalized)) {
      const coverage = normalized.length / fileNameWithoutExt.length;
      bonus += 20.0 * coverage; // Strong prefix bonus (up to +20.0)
    }

    // 3. CONSECUTIVE SUBSTRING (with mixed-case handling)
    if (hasMixedCase) {
      // For mixed-case queries (like "cC"), ONLY reward consecutive if case matches
      if (fileName.includes(original)) {
        let consecutiveBonus = 35.0; // MASSIVE bonus: consecutive + exact case

        // Penalize if surrounded by noise (like "foo-cC-bar")
        const matchIdx = fileName.indexOf(original);
        if (matchIdx > 0 && matchIdx + original.length < fileName.length) {
          consecutiveBonus -= 20.0; // Heavy penalty for noise around consecutive match
        }

        bonus += consecutiveBonus;
      }
      // Do NOT give any bonus for case-insensitive match with mixed-case queries
    } else if (fileNameLower.includes(normalized)) {
      // For uniform-case queries, case-insensitive consecutive is fine
      bonus += 12.0; // Strong bonus for consecutive match in filename

      // Extra bonus if case also matches
      if (fileName.includes(original)) {
        bonus += 6.0; // Additional bonus for exact case
      }
    }

    // 4. ADDITIONAL BONUSES

    // Check if the full path starts with query (for path prefix searches)
    if (filePath.toLowerCase().startsWith(normalized)) {
      bonus += 4.0; // Strong bonus for path prefix
    }

    // Slash-based path queries (e.g., "comp/index" should match "components/index.ts")
    if (normalized.includes('/')) {
      const queryParts = normalized.split('/').filter((p) => p.length > 0);
      if (queryParts.length >= 2) {
        // Try to match query parts to path segments
        let matchedParts = 0;
        let totalScore = 0;

        for (const queryPart of queryParts) {
          let bestMatch = 0;
          for (const segment of segments) {
            const segmentLower = segment.toLowerCase();

            // Prefer startsWith over includes, and prefer longer segments (abbreviations)
            if (segmentLower.startsWith(queryPart)) {
              // Prefix match: favor longer segment names (likely abbreviations)
              // "comp" -> "components" (10 chars) is better than "comp" -> "compose" (7 chars)
              const segmentLength = segmentLower.length;
              const matchScore = 1.0 + segmentLength / 100.0; // Base score + length bonus
              if (matchScore > bestMatch) {
                bestMatch = matchScore;
              }
            } else if (segmentLower.includes(queryPart)) {
              // Substring match: much lower score
              const matchScore = 0.3;
              if (matchScore > bestMatch) {
                bestMatch = matchScore;
              }
            }
          }

          if (bestMatch > 0) {
            matchedParts++;
            totalScore += bestMatch;
          }
        }

        // If we matched all query parts, give a strong bonus
        if (matchedParts === queryParts.length) {
          const avgScore = totalScore / queryParts.length;
          bonus += 200.0 * avgScore; // Massive bonus for slash queries (up to +200)
        }
      }
    }

    // Suffix digit patterns (e.g., "v2" in "dropv2")
    const suffixMatch = normalized.match(/([a-z]\d+|\d+[a-z])$/);
    if (suffixMatch && fileNameLower.includes(suffixMatch[0])) {
      bonus += 8.0; // Strong bonus for suffix digit pattern match
    }

    // 5. PATH DEPTH (prefer files closer to root - fewer segments = higher bonus)
    const depth = segments.length;
    if (depth === 1) {
      bonus += 15.0; // Root level - strongest preference
    } else if (depth === 2) {
      bonus += 10.0; // One level deep - strong preference
    } else if (depth === 3) {
      bonus += 5.0; // Two levels deep - moderate preference
    } else if (depth === 4) {
      bonus += 2.0; // Three levels deep - small preference
    }
    // No bonus for deeper paths (depth >= 5)

    return bonus;
  }

  /**
   * camelCase bonus: "ur" should match "UserRoute"
   */
  private static calculateCamelCaseBonus(
    fileName: string, // Pre-computed
    query: ProcessedQuery
  ): number {
    const normalized = query.normalized;
    const original = query.original;

    // Extract uppercase letters as potential acronym
    const upperChars = fileName.match(/[A-Z]/g);
    if (!upperChars || upperChars.length === 0) {
      return 0;
    }

    const acronym = upperChars.join('').toLowerCase();

    // Check if query matches the acronym
    if (acronym.startsWith(normalized)) {
      return 3.0; // Strong bonus for acronym match
    }

    // Check if query chars match at camelCase boundaries with case sensitivity
    let queryIdx = 0;
    let matchCount = 0;
    let exactCaseMatches = 0;

    for (let i = 0; i < fileName.length && queryIdx < original.length; i++) {
      const char = fileName[i];

      if (char >= 'A' && char <= 'Z') {
        // This is a camelCase boundary
        if (char.toLowerCase() === original[queryIdx].toLowerCase()) {
          matchCount++;
          // Check if case also matches
          if (char === original[queryIdx]) {
            exactCaseMatches++;
          }
          queryIdx++;
        }
      }
    }

    if (matchCount > 0) {
      const baseBonus = 1.5 * (matchCount / original.length);
      const caseSensitiveBonus = 2.0 * (exactCaseMatches / original.length);
      return baseBonus + caseSensitiveBonus;
    }

    return 0;
  }

  /**
   * Case pattern bonus: exact case pattern matching (e.g., "cC" prefers "camelCase")
   * Matches characters non-consecutively but with exact case pattern
   */
  private static calculateCasePatternBonus(
    fileName: string, // Pre-computed
    query: ProcessedQuery
  ): number {
    const original = query.original;

    // Only apply if query has mixed case
    if (!/[a-z]/.test(original) || !/[A-Z]/.test(original)) {
      return 0;
    }

    // Try to match query characters in order with exact case pattern
    let queryIdx = 0;
    let exactCaseMatches = 0;
    let lastMatchPos = -1;
    let hasConsecutiveMismatch = false;

    for (let i = 0; i < fileName.length && queryIdx < original.length; i++) {
      const qChar = original[queryIdx];
      const fChar = fileName[i];

      // Check if characters match (case-insensitive)
      if (qChar.toLowerCase() === fChar.toLowerCase()) {
        // Check if case also matches
        const qIsUpper = qChar >= 'A' && qChar <= 'Z';
        const fIsUpper = fChar >= 'A' && fChar <= 'Z';

        if (qIsUpper === fIsUpper) {
          exactCaseMatches++;
        } else if (lastMatchPos >= 0 && i === lastMatchPos + 1) {
          // If chars are consecutive in filename but case mismatches, this is bad
          hasConsecutiveMismatch = true;
        }
        lastMatchPos = i;
        queryIdx++;
      }
    }

    // If we matched all query chars and all had exact case match
    if (queryIdx === original.length && exactCaseMatches === original.length) {
      let bonus = 30.0; // MASSIVE bonus for exact case pattern match (increased from 10.0)

      // Penalize if the match is surrounded by other characters (noise)
      // For example: "cC" in "foo-cC-bar" should score lower than "cC" in "camelCase"
      const matchIdx = fileName.toLowerCase().indexOf(original.toLowerCase());
      if (matchIdx > 0 && matchIdx + original.length < fileName.length) {
        // Match is in the middle with characters on both sides
        bonus -= 15.0; // Strong penalty for noise around the match
      }

      return bonus;
    }

    // Penalize consecutive case mismatches (like "cc" for query "cC")
    if (hasConsecutiveMismatch) {
      return 0;
    }

    // Partial case pattern match (non-consecutive only)
    if (queryIdx === original.length && exactCaseMatches > 0) {
      return 3.0 * (exactCaseMatches / original.length);
    }

    return 0;
  }

  /**
   * Sequence completeness penalty: Heavily penalize matches where query letters
   * don't appear in order or are missing.
   *
   * Examples:
   * - Query "leo" in "logging" has 'l', 'o', but missing 'e' in sequence → HIGH PENALTY
   * - Query "leo" in "fileOperations" has 'l', 'e', 'o' in order → NO PENALTY
   * - Query "abc" in "bac" has letters out of order → HIGH PENALTY
   */
  private static calculateSequencePenalty(
    fileNameLower: string,
    query: ProcessedQuery,
    normalized: string
  ): number {
    // Find all query characters in order
    let queryIdx = 0;
    let lastMatchPos = -1;
    let outOfOrderCount = 0;

    for (
      let i = 0;
      i < fileNameLower.length && queryIdx < normalized.length;
      i++
    ) {
      if (fileNameLower[i] === normalized[queryIdx]) {
        // Check if this match is before the last one (out of order)
        if (lastMatchPos !== -1 && i < lastMatchPos) {
          outOfOrderCount++;
        }
        lastMatchPos = i;
        queryIdx++;
      }
    }

    // Calculate penalties
    const missingChars = normalized.length - queryIdx;

    // VERY high penalty for missing characters (each missing char = -20 penalty)
    const missingPenalty = missingChars * 20.0;

    // High penalty for out-of-order characters (each = -15 penalty)
    const outOfOrderPenalty = outOfOrderCount * 15.0;

    return missingPenalty + outOfOrderPenalty;
  }

  /**
   * Position penalty: VSCode-style penalty for matches starting late in the string
   * Penalizes matches that don't start near the beginning
   */
  private static calculatePositionPenalty(
    fileName: string,
    fileNameLower: string,
    query: ProcessedQuery,
    normalized: string
  ): number {
    // Find first match position in filename
    const firstMatchIdx = fileNameLower.indexOf(normalized);
    if (firstMatchIdx === -1) {
      // If not consecutive, try to find first character match
      let idx = 0;
      for (let i = 0; i < fileNameLower.length; i++) {
        if (fileNameLower[i] === normalized[0]) {
          idx = i;
          break;
        }
      }
      // VSCode formula: min(position, 3) * 3, scaled to 4 for stronger effect
      return Math.min(idx, 3) * 4;
    }

    // Consecutive match found - use its position
    // VSCode formula: min(position, 3) * 3, scaled to 4 for stronger effect (max penalty 12)
    return Math.min(firstMatchIdx, 3) * 4;
  }

  /**
   * Multi-segment matching bonus: Queries like "chatroute" should match
   * paths like "chat/route.ts" where query parts map to different path segments.
   *
   * Examples:
   * - "chatroute" → "chat/route.ts" (bonus for chat + route segments)
   * - "orgtyp" → "organization/types.ts" (bonus for org + typ segments)
   */
  private static calculateMultiSegmentBonus(
    filePath: string,
    query: ProcessedQuery
  ): number {
    const normalized = query.normalized;

    // Only apply for queries 6+ chars (avoid false matches on short queries)
    if (normalized.length < 6) {
      return 0;
    }

    const segments = filePath.split('/');

    // Try to find if query can be split into parts that match different segments
    // We'll look for the longest matching prefix in each segment
    let totalMatchLength = 0;
    let segmentsMatched = 0;
    let queryIdx = 0;

    for (const segment of segments) {
      if (queryIdx >= normalized.length) break;

      const segmentLower = segment.toLowerCase();
      let segmentMatchLength = 0;
      const startQueryIdx = queryIdx;

      // Try to match as many consecutive chars as possible from current query position
      for (
        let i = 0;
        i < segmentLower.length && queryIdx < normalized.length;
        i++
      ) {
        if (segmentLower[i] === normalized[queryIdx]) {
          segmentMatchLength++;
          queryIdx++;
        } else if (segmentMatchLength > 0) {
          // Stop on first mismatch after we've started matching
          break;
        }
      }

      if (segmentMatchLength >= 3) {
        // Require at least 3 chars matched in a segment
        totalMatchLength += segmentMatchLength;
        segmentsMatched++;
      } else if (segmentMatchLength > 0) {
        // Backtrack if match was too short
        queryIdx = startQueryIdx;
      }
    }

    // If we matched most of the query across multiple segments, give VERY strong bonus
    if (segmentsMatched >= 2 && totalMatchLength >= normalized.length * 0.8) {
      const completeness = totalMatchLength / normalized.length;
      // MASSIVELY boost multi-segment matches - these are highly intentional queries
      return 150.0 * completeness * segmentsMatched; // Massive bonus for multi-segment matches
    }

    return 0;
  }

  /**
   * Filter files based on exclusion patterns
   */
  private filterExcludedFiles(files: string[]): string[] {
    if (this.options.excludePatterns.length === 0) {
      return files;
    }

    const patterns = FuseSearch.compileExcludePatterns(
      this.options.excludePatterns
    );

    return files.filter(
      (file) => !patterns.some((pattern) => pattern.test(file))
    );
  }

  /**
   * Compile glob patterns to RegExp
   */
  private static compileExcludePatterns(patterns: string[]): RegExp[] {
    return patterns.map((pattern) => {
      // Escape special regex chars except glob wildcards
      let regex = pattern
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\+/g, '\\+')
        .replace(/\^/g, '\\^')
        .replace(/\$/g, '\\$')
        .replace(/\|/g, '\\|');

      // Convert glob patterns to regex
      regex = regex
        .replace(/\*\*/g, '___GLOBSTAR___')
        .replace(/\*/g, '[^/]*')
        .replace(/___GLOBSTAR___/g, '.*')
        .replace(/\?/g, '[^/]');

      // Handle special case: pattern starting with **/ (match anywhere in path)
      if (pattern.startsWith('**/')) {
        // Remove the leading .* to match the pattern anywhere
        const cleanedRegex = regex.replace(/^\.\*\//, '');
        return new RegExp(`(^|/)${cleanedRegex}$`);
      }

      return new RegExp(`^${regex}$`);
    });
  }
}
