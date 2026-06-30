/**
 * Fast file indexer using fdir for `@` file suggestions.
 *
 * Features:
 * - TTL-based caching (default 30s)
 * - In-flight crawl deduplication (prevents concurrent crawls for the same directory)
 * - Configurable maxFiles cap (default 20k)
 * - Respects common ignore rules (node_modules, .git, build artifacts)
 * - Optional .gitignore support via picomatch
 * - Path normalization to POSIX format
 */

import { readFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';

import { fdir } from 'fdir';
import picomatch from 'picomatch';

import { logInfo, Metrics } from '@industry/logging';
import { Metric } from '@industry/logging/metrics/enums';

import type { FileIndexerOptions } from '@/services/types';
import { getResultCountBucket } from '@/utils/inputLatencyMetrics';
import {
  getCliRuntimeMetricLabels,
  recordStartupLatency,
} from '@/utils/startupLatency';

// Constants
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_TTL_MS = 30_000; // 30 seconds
const DEFAULT_MAX_DEPTH = Infinity;

/**
 * Directories that are always excluded from indexing.
 * These are heavy, auto-generated, or version control directories
 * that pollute search results and hurt performance.
 */
const ALWAYS_EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.DS_Store',
  // Build outputs
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  // Cache directories
  '.cache',
  '.parcel-cache',
  '.turbo',
  // IDE/editor directories
  '.idea',
  '.vscode',
  // Package manager caches
  '.npm',
  '.yarn',
  '.pnpm-store',
  // Coverage/test outputs
  'coverage',
  '__pycache__',
  '.pytest_cache',
  // Virtual environments
  'venv',
  '.venv',
  'env',
  // Dependency lock files (large)
  '.terraform',
  // Industry artifacts (read-only)
  '.industry/artifacts',
] as const;

interface CacheEntry {
  files: string[];
  directories: string[];
  timestamp: number;
  wasTruncated: boolean;
}

interface CompiledGitignorePattern {
  isNegation: boolean;
  matcher: (path: string) => boolean;
}

/**
 * Parse a .gitignore file and return a function that evaluates paths using
 * ordered pattern evaluation (matching real git semantics).
 *
 * Previous implementation passed all patterns as an array to picomatch, which
 * uses OR semantics. This broke negation patterns (e.g. `*` + `!src/**`)
 * because the wildcard always matched first, making the negation useless.
 *
 * Key behaviors matching git:
 * - Patterns are evaluated in order; later rules override earlier ones
 * - Negation patterns (!) properly un-ignore previously matched paths
 * - matchBase is only used for patterns without path separators (like git)
 *
 * @param gitignorePath - Path to the .gitignore file
 * @returns A function that returns true if a path should be ignored
 */
interface GitignoreResult {
  isMatch: (path: string) => boolean;
  hasNegations: boolean;
}

async function parseGitignore(
  gitignorePath: string
): Promise<GitignoreResult | null> {
  try {
    const content = await readFile(gitignorePath, 'utf-8');
    const rawPatterns = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    if (rawPatterns.length === 0) {
      return null;
    }

    // Pre-compile each pattern individually for ordered evaluation.
    // In .gitignore, patterns without `/` match against the basename (matchBase),
    // while patterns with `/` match against the full relative path.
    // Directory patterns (trailing `/`) also match all files under that directory.
    const compiled: CompiledGitignorePattern[] = [];
    for (const raw of rawPatterns) {
      const isNegation = raw.startsWith('!');
      const withoutNeg = isNegation ? raw.slice(1) : raw;
      const isDirectoryPattern = withoutNeg.endsWith('/');
      const clean = withoutNeg.replace(/\/$/, '');
      const hasSlash = clean.includes('/');

      if (isDirectoryPattern) {
        // For directory patterns (e.g. `logs/`), only emit `dir/**` to match
        // files underneath the directory. We skip the bare `dir` matcher to
        // avoid incorrectly matching a *file* named `logs`. The directory-level
        // `.exclude()` callback handles actual directory name matching separately.
        const globPattern = `${clean}/**`;
        const dirContentMatcher = picomatch(globPattern, {
          dot: true,
          matchBase: false,
          nocase: false,
        });
        compiled.push({ isNegation, matcher: dirContentMatcher });
      } else {
        const matcher = picomatch(clean, {
          dot: true,
          matchBase: !hasSlash,
          nocase: false,
        });
        compiled.push({ isNegation, matcher });
      }
    }

    const hasNegations = compiled.some((p) => p.isNegation);

    // Evaluate patterns in order: later rules override earlier ones (like git).
    const isMatch = (path: string): boolean => {
      let ignored = false;
      for (const { isNegation, matcher } of compiled) {
        if (matcher(path)) {
          ignored = !isNegation;
        }
      }
      return ignored;
    };

    return { isMatch, hasNegations };
  } catch {
    // .gitignore doesn't exist or isn't readable
    return null;
  }
}

/**
 * Extract all unique directory paths from a list of file paths.
 *
 * @param filePaths - Array of file paths
 * @returns Array of unique directory paths sorted by depth (shallowest first)
 */
function extractDirectoriesFromFiles(filePaths: string[]): string[] {
  const dirSet = new Set<string>();

  for (const filePath of filePaths) {
    // Normalize to POSIX paths (forward slashes)
    let currentPath = dirname(filePath).replace(/\\/g, '/');

    // Walk up the directory tree until we hit '.' (current directory)
    while (currentPath !== '.' && currentPath !== '') {
      dirSet.add(currentPath);
      currentPath = dirname(currentPath).replace(/\\/g, '/');
    }
  }

  // Convert to array and sort by depth (fewer segments first)
  return Array.from(dirSet).sort((a, b) => {
    const aDepth = a.split('/').length;
    const bDepth = b.split('/').length;
    if (aDepth !== bDepth) {
      return aDepth - bDepth;
    }
    return a.localeCompare(b);
  });
}

/**
 * Singleton file indexer that provides fast file listing with TTL cache
 * and in-flight crawl deduplication.
 */
class FileIndexerImpl {
  private cache = new Map<string, CacheEntry>();

  private inFlightCrawls = new Map<string, Promise<CacheEntry>>();

  private defaultOptions: Required<FileIndexerOptions>;

  constructor(options: FileIndexerOptions = {}) {
    this.defaultOptions = {
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      showHidden: options.showHidden ?? false,
      respectGitignore: options.respectGitignore ?? true,
      excludePatterns: options.excludePatterns ?? [],
    };
  }

  /**
   * Get indexed files for a directory.
   *
   * Returns cached result if TTL hasn't expired.
   * Deduplicates concurrent crawls for the same directory.
   *
   * @param rootDir - The directory to index
   * @param options - Override default options
   * @returns Object containing files and directories arrays
   */
  async getFiles(
    rootDir: string,
    options: FileIndexerOptions = {}
  ): Promise<{
    files: string[];
    directories: string[];
    wasTruncated: boolean;
  }> {
    const resolvedRoot = resolve(rootDir);
    const mergedOptions = { ...this.defaultOptions, ...options };
    const cacheKey = FileIndexerImpl.getCacheKey(resolvedRoot, mergedOptions);

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < mergedOptions.ttlMs) {
      Metrics.addToCounter(Metric.CLI_TUI_FILE_INDEX_LATENCY, 0, {
        ...getCliRuntimeMetricLabels(),
        cacheStatus: 'hit',
        resultCountBucket: getResultCountBucket(
          cached.files.length + cached.directories.length
        ),
        wasTruncated: cached.wasTruncated,
      });
      return {
        files: cached.files,
        directories: cached.directories,
        wasTruncated: cached.wasTruncated,
      };
    }

    // Check if there's an in-flight crawl for this directory
    const inFlight = this.inFlightCrawls.get(cacheKey);
    if (inFlight) {
      const waitStart = performance.now();
      const result = await inFlight;
      recordStartupLatency(Metric.CLI_TUI_FILE_INDEX_LATENCY, waitStart, {
        cacheStatus: 'inflight',
        resultCountBucket: getResultCountBucket(
          result.files.length + result.directories.length
        ),
        wasTruncated: result.wasTruncated,
      });
      return {
        files: result.files,
        directories: result.directories,
        wasTruncated: result.wasTruncated,
      };
    }

    // Start a new crawl and track it
    const crawlStart = Date.now();
    const crawlStartPerformance = performance.now();
    const crawlPromise = FileIndexerImpl.doCrawl(resolvedRoot, mergedOptions);
    this.inFlightCrawls.set(cacheKey, crawlPromise);

    try {
      const result = await crawlPromise;
      // Cache the result
      this.cache.set(cacheKey, result);
      logInfo('[FileIndexer] Crawl completed', {
        directory: resolvedRoot,
        fileCount: result.files.length,
        count: result.directories.length,
        truncated: result.wasTruncated,
        durationMs: Date.now() - crawlStart,
      });
      recordStartupLatency(
        Metric.CLI_TUI_FILE_INDEX_LATENCY,
        crawlStartPerformance,
        {
          cacheStatus: 'miss',
          outcome: 'success',
          resultCountBucket: getResultCountBucket(
            result.files.length + result.directories.length
          ),
          wasTruncated: result.wasTruncated,
        }
      );
      return {
        files: result.files,
        directories: result.directories,
        wasTruncated: result.wasTruncated,
      };
    } catch (error) {
      recordStartupLatency(
        Metric.CLI_TUI_FILE_INDEX_LATENCY,
        crawlStartPerformance,
        { cacheStatus: 'miss', outcome: 'error' }
      );
      throw error;
    } finally {
      // Always clean up in-flight tracking
      this.inFlightCrawls.delete(cacheKey);
    }
  }

  /**
   * Synchronously return the cached file list if the TTL is still valid.
   * Returns null if there is no cached result — never triggers a crawl.
   */
  getFilesIfCached(
    rootDir: string,
    options: FileIndexerOptions = {}
  ): { files: string[]; directories: string[]; wasTruncated: boolean } | null {
    const resolvedRoot = resolve(rootDir);
    const mergedOptions = { ...this.defaultOptions, ...options };
    const cacheKey = FileIndexerImpl.getCacheKey(resolvedRoot, mergedOptions);

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < mergedOptions.ttlMs) {
      return {
        files: cached.files,
        directories: cached.directories,
        wasTruncated: cached.wasTruncated,
      };
    }
    return null;
  }

  /**
   * Invalidate the cache for a specific directory (or all if not specified).
   *
   * @param rootDir - Optional directory to invalidate; if omitted, clears all
   */
  invalidateCache(rootDir?: string): void {
    if (rootDir) {
      const resolvedRoot = resolve(rootDir);
      // Remove all cache entries that are truly at or under this root.
      // We must check for exact match OR that the key continues with a path separator
      // to avoid over-deleting sibling directories that share a prefix
      // (e.g. invalidating /repo/a should NOT delete /repo/ab).
      for (const key of this.cache.keys()) {
        // Cache key format: "{resolvedPath}:{options...}"
        // Extract the path portion (before the first colon after the root path)
        const keyPath = key.substring(0, key.indexOf('\0'));
        if (
          keyPath === resolvedRoot ||
          keyPath.startsWith(`${resolvedRoot}${sep}`)
        ) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get cache statistics for debugging/monitoring.
   */
  getCacheStats(): {
    entriesCount: number;
    inFlightCount: number;
    cacheKeys: string[];
  } {
    return {
      entriesCount: this.cache.size,
      inFlightCount: this.inFlightCrawls.size,
      cacheKeys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Generate a cache key from directory and options.
   */
  private static getCacheKey(
    rootDir: string,
    options: Required<FileIndexerOptions>
  ): string {
    // Include relevant options in the cache key
    return `${rootDir}\0${options.maxFiles}\0${options.maxDepth}\0${options.showHidden}\0${options.respectGitignore}\0${options.excludePatterns.join(',')}`;
  }

  /**
   * Perform the actual file crawl using fdir.
   */
  private static async doCrawl(
    rootDir: string,
    options: Required<FileIndexerOptions>
  ): Promise<CacheEntry> {
    // Build the set of excluded directories
    const excludedDirSet = new Set<string>(ALWAYS_EXCLUDED_DIRS);

    // Parse .gitignore if enabled
    let gitignoreResult: GitignoreResult | null = null;
    if (options.respectGitignore) {
      gitignoreResult = await parseGitignore(join(rootDir, '.gitignore'));
    }

    // Add custom exclude patterns
    let customMatcher: ((path: string) => boolean) | null = null;
    if (options.excludePatterns.length > 0) {
      customMatcher = picomatch(options.excludePatterns, {
        dot: true,
        matchBase: true,
      });
    }

    // Build the fdir crawler
    // eslint-disable-next-line new-cap -- fdir is a lowercase-named class from the fdir library
    let crawler = new fdir()
      .withRelativePaths()
      .withMaxDepth(options.maxDepth)
      .withMaxFiles(options.maxFiles)
      .exclude((dirName, dirPath) => {
        // Always exclude heavy directories
        if (excludedDirSet.has(dirName)) {
          return true;
        }

        // Check .gitignore patterns for directory exclusion.
        // When negation patterns exist (e.g. `*` + `!src/**`), we must NOT
        // exclude directories at the directory level because a directory matched
        // by a positive pattern may still contain un-ignored files. The file-level
        // filter() callback handles per-file gitignore evaluation instead.
        if (gitignoreResult && !gitignoreResult.hasNegations) {
          const relPath = relative(rootDir, dirPath).replace(/\\/g, '/');
          if (relPath && gitignoreResult.isMatch(relPath)) {
            return true;
          }
          if (gitignoreResult.isMatch(dirName)) {
            return true;
          }
        }

        // Check custom exclude patterns
        if (customMatcher) {
          const relPath = relative(rootDir, dirPath).replace(/\\/g, '/');
          if (relPath && customMatcher(relPath)) {
            return true;
          }
        }

        return false;
      });

    // Filter hidden files unless showHidden is true
    if (!options.showHidden) {
      crawler = crawler.filter((path) => {
        // Don't include paths that have hidden segments (starting with .)
        const segments = path.split('/');
        return !segments.some(
          (segment) => segment.startsWith('.') && segment !== '.'
        );
      });
    }

    // Filter files based on gitignore and custom patterns
    if (gitignoreResult || customMatcher) {
      crawler = crawler.filter((path) => {
        if (gitignoreResult && gitignoreResult.isMatch(path)) {
          return false;
        }
        if (customMatcher && customMatcher(path)) {
          return false;
        }
        return true;
      });
    }

    // Normalize paths to POSIX format
    crawler = crawler.normalize();

    // Execute the crawl
    const rawFiles = await crawler.crawl(rootDir).withPromise();

    // Normalize paths and ensure forward slashes
    const files = rawFiles.map((f) => f.replace(/\\/g, '/'));

    // Extract directories from file paths
    const directories = extractDirectoriesFromFiles(files);

    // Check if we hit the maxFiles limit
    const wasTruncated = files.length >= options.maxFiles;

    return {
      files,
      directories,
      timestamp: Date.now(),
      wasTruncated,
    };
  }
}

// Singleton instance
let fileIndexerInstance: FileIndexerImpl | null = null;

/**
 * Get the singleton FileIndexer instance.
 *
 * @param options - Options for the indexer (only used on first call)
 */
export function getFileIndexer(options?: FileIndexerOptions): FileIndexerImpl {
  if (!fileIndexerInstance) {
    fileIndexerInstance = new FileIndexerImpl(options);
  }
  return fileIndexerInstance;
}

/** @public */
export function resetFileIndexer(): void {
  if (fileIndexerInstance) {
    fileIndexerInstance.invalidateCache();
  }
  fileIndexerInstance = null;
}

/** @public */
export { FileIndexerImpl };
