/**
 * File suggestion system for chat with @path/to/file syntax
 *
 * This module provides fast file suggestions for the @ mention syntax in chat.
 * It uses:
 * - FileIndexer: Fast file crawling with TTL cache and in-flight deduplication
 * - FileSearch (AsyncFzf): Fast fuzzy matching with algorithm selection
 *
 * Key features:
 * - No per-candidate fs.stat() calls (uses indexed directory info)
 * - TTL-cached file list (default 30s)
 * - Directories are suggested with trailing `/`
 */

import { resolve, basename } from 'path';

import { logException, logWarn } from '@industry/logging';
import { getFileSuggestionDisplayParts } from '@industry/utils/file-suggestions';

import { DEFAULTS } from '@/components/chat/constants';
import {
  FileSuggestion,
  ChatFileSuggestionsOptions,
} from '@/components/chat/types';
import { getI18n } from '@/i18n';
import { getFileIndexer } from '@/services/FileIndexer';
import { FileSearch } from '@/services/FileSearch';
import {
  displayWidth as getDisplayWidth,
  padEndByDisplayWidth,
} from '@/utils/displayWidth';
import { truncateMiddle } from '@/utils/truncate';

// Default description for files when we don't have size info (avoiding fs.stat())
const getDefaultFileDescription = () =>
  getI18n().t('common:fileSuggestions.file');

// Max results for fuzzy search (scaled for windowed navigation)
const MAX_SEARCH_RESULTS = 100;

export class ChatFileSuggestions {
  private maxSuggestions: number;

  private showHiddenFiles: boolean;

  private fileExtensions?: string[];

  private workingDirectory: string;

  // FileSearch instance for fuzzy matching (lazily initialized)
  private fileSearch: FileSearch | null = null;

  // Track the last files/directories references from FileIndexer to detect changes
  // (FileIndexer returns the same cached arrays within the TTL window)
  private lastFiles: string[] | null = null;

  private lastDirectories: string[] | null = null;

  private cachedFilesAndDirectories: string[] | null = null;

  // Cached set of directories for O(1) lookup (from FileIndexer)
  private directorySet: Set<string> = new Set();

  // Guard to log empty-index warning only once per instance
  private loggedEmptyIndex = false;

  // Cached result of getSuggestions('') from prewarm — returned instantly for bare @
  private cachedEmptyQuerySuggestions: FileSuggestion[] | null = null;

  constructor(options: ChatFileSuggestionsOptions = {}) {
    this.maxSuggestions = options.maxSuggestions || DEFAULTS.MAX_SUGGESTIONS;
    this.showHiddenFiles =
      options.showHiddenFiles ?? DEFAULTS.SHOW_HIDDEN_FILES;
    this.fileExtensions = options.fileExtensions;
    this.workingDirectory = options.workingDirectory || process.cwd();

    // Defer prewarm to the next macrotask so the TUI can complete its
    // initial render before heavy background indexing starts.
    setTimeout(() => this.prewarm(), 0);
  }

  /**
   * Eagerly warm the FileIndexer cache so the async I/O crawl is already
   * done when the user types @. Fire-and-forget; errors silently ignored.
   *
   * Only the I/O crawl is prewarmed — the CPU-heavy suggestion building
   * (~10-50 ms) runs on demand and is fast enough to not need prewarming.
   */
  prewarm(): void {
    const indexer = getFileIndexer();
    void Promise.resolve()
      .then(() =>
        indexer.getFiles(this.workingDirectory, {
          showHidden: this.showHiddenFiles,
        })
      )
      .catch(() => {
        // Silently ignore — prewarm is best-effort
      });
  }

  /**
   * Synchronous, non-blocking cache check for indexed files.
   * Returns null if the cache is not yet warm — never triggers or awaits a crawl.
   */
  private getIndexedFilesIfCached(): {
    files: string[];
    directories: string[];
    directorySet: Set<string>;
  } | null {
    const indexer = getFileIndexer();
    const result = indexer.getFilesIfCached(this.workingDirectory, {
      showHidden: this.showHiddenFiles,
    });
    if (!result) return null;

    const directorySet = new Set(result.directories);
    this.directorySet = directorySet;
    return {
      files: result.files,
      directories: result.directories,
      directorySet,
    };
  }

  /**
   * Filter and rank files using FileSearch (AsyncFzf).
   * This replaces the old FuseSearch-based approach.
   *
   * @param filesAndDirectories - Combined list of files and directories
   * @param query - The search query
   * @returns Filtered and ranked list of paths
   */
  private async filterFilesByQuery(
    filesAndDirectories: string[],
    query: string
  ): Promise<string[]> {
    if (!query) {
      // Return all files for empty query (windowing handled by UI)
      return filesAndDirectories;
    }

    // Initialize or update FileSearch with current candidates.
    // Reference comparison works here because getSuggestions() caches the combined array
    // and only rebuilds it when FileIndexer returns new data.
    if (!this.fileSearch) {
      this.fileSearch = new FileSearch(filesAndDirectories, {
        maxResults: MAX_SEARCH_RESULTS,
      });
    } else if (this.fileSearch.getCandidates() !== filesAndDirectories) {
      this.fileSearch.setCandidates(filesAndDirectories);
    }

    // Use FileSearch (AsyncFzf) for fuzzy matching
    const searchResult = await this.fileSearch.search(query);

    // If search timed out or was aborted, fall back to simple filtering
    if (searchResult.timedOut || searchResult.aborted) {
      const lowerQuery = query.toLowerCase();
      return filesAndDirectories.filter((filePath) => {
        const fileName = basename(filePath).toLowerCase();
        return (
          fileName.includes(lowerQuery) ||
          filePath.toLowerCase().includes(lowerQuery)
        );
      });
    }

    return searchResult.results.map((r) => r.path);
  }

  /**
   * Create a file suggestion from a path WITHOUT calling fs.stat().
   * Uses the directorySet from FileIndexer to determine if path is a directory.
   *
   * @param filePath - Relative file/directory path
   * @param directorySet - Set of known directory paths for O(1) lookup
   * @returns FileSuggestion or null if filtered out
   */
  private createFileSuggestionWithoutStat(
    filePath: string,
    directorySet: Set<string>
  ): FileSuggestion | null {
    const isDirectory = directorySet.has(filePath);

    // Filter by file extensions if specified (only for files)
    if (!isDirectory && !this.hasValidExtension(filePath)) {
      return null;
    }

    const absolutePath = resolve(this.workingDirectory, filePath);

    return {
      label: filePath, // Temporary label, will be updated in formatSuggestions
      value: filePath + (isDirectory ? '/' : ''),
      // Use generic description to avoid fs.stat() call
      description: isDirectory
        ? getI18n().t('common:fileSuggestions.directory')
        : getDefaultFileDescription(),
      isDirectory,
      fullPath: absolutePath,
    };
  }

  /**
   * Check if file has valid extension
   */
  private hasValidExtension(filePath: string): boolean {
    if (!this.fileExtensions || this.fileExtensions.length === 0) {
      return true;
    }

    const lowerPath = filePath.toLowerCase();
    return this.fileExtensions.some((ext) =>
      lowerPath.endsWith(ext.toLowerCase())
    );
  }

  /**
   * Format suggestions with aligned columns and labels.
   *
   * @param suggestions - Array of FileSuggestion objects to format
   * @returns Formatted suggestions with labels and fileDisplay
   */
  private static formatSuggestions(
    suggestions: FileSuggestion[]
  ): FileSuggestion[] {
    // Calculate dynamic column width based on actual filenames
    const MIN_COLUMN_WIDTH = 15; // Minimum width for very short filenames
    const MAX_COLUMN_WIDTH = 40; // Maximum width to prevent excessive padding
    const PADDING_BUFFER = 2; // Extra padding for visual separation

    // Pre-process to find the optimal column width
    let dynamicColumnWidth = MIN_COLUMN_WIDTH;

    // First pass: determine the longest filename (after potential truncation)
    // Uses display width to account for CJK double-width characters
    for (const suggestion of suggestions) {
      const { filename: displayName } = getFileSuggestionDisplayParts(
        suggestion.value
      );

      // If the filename display width would exceed max, we'll use MAX_COLUMN_WIDTH
      if (getDisplayWidth(displayName) > MAX_COLUMN_WIDTH) {
        dynamicColumnWidth = MAX_COLUMN_WIDTH;
        break; // No need to check further
      }

      // Track the widest actual filename by display width
      dynamicColumnWidth = Math.max(
        dynamicColumnWidth,
        getDisplayWidth(displayName) + PADDING_BUFFER
      );
    }

    // Cap at MAX_COLUMN_WIDTH
    dynamicColumnWidth = Math.min(dynamicColumnWidth, MAX_COLUMN_WIDTH);

    // Update labels to have aligned columns with truncation
    return suggestions.map((suggestion) => {
      const { directory, filename: displayName } =
        getFileSuggestionDisplayParts(suggestion.value);

      // Truncate long filenames to fit within column width
      const truncatedDisplayName = truncateMiddle(
        displayName,
        dynamicColumnWidth
      );

      // Pad the filename to align the directory paths (only if showing path)
      // Uses display-width-aware padding to handle CJK double-width characters
      const paddedFileName =
        directory === ''
          ? truncatedDisplayName
          : padEndByDisplayWidth(truncatedDisplayName, dynamicColumnWidth);

      // Create the aligned label (kept for backwards compatibility)
      // If file is in root directory, don't show path
      const label =
        directory === ''
          ? truncatedDisplayName
          : `${paddedFileName}  ${directory}`;

      // Create structured fileDisplay for robust rendering
      const fileDisplay = {
        filename: paddedFileName,
        path: directory === '' ? undefined : directory,
      };

      return {
        ...suggestion,
        label,
        fileDisplay,
      };
    });
  }

  /**
   * Extract @path syntax from text and return the path part
   */
  static extractPathQuery({
    text,
    cursorPosition,
  }: {
    text: string;
    cursorPosition: number;
  }): {
    pathQuery: string;
    startIndex: number;
    endIndex: number;
  } | null {
    // Find the last @ before cursor position
    const beforeCursor = text.substring(0, cursorPosition);
    const atIndex = beforeCursor.lastIndexOf('@');

    if (atIndex === -1) {
      return null;
    }

    // Extract the path part after @
    const afterAt = text.substring(atIndex + 1);

    // Find where the path ends (space, newline, or end of text)
    const pathEndMatch = afterAt.match(/^[^\s]*/);
    const endOffset = pathEndMatch ? pathEndMatch[0].length : 0;

    // Only consider it a path query if cursor is within the path
    const pathEndIndex = atIndex + 1 + endOffset;
    if (cursorPosition > pathEndIndex) {
      return null;
    }

    const pathQuery = afterAt.substring(0, endOffset);

    return {
      pathQuery,
      startIndex: atIndex,
      endIndex: pathEndIndex,
    };
  }

  /**
   * Get file suggestions for a given path query.
   *
   * This method uses the new FileIndexer + FileSearch engine:
   * - FileIndexer provides TTL-cached file listing (no per-keystroke crawls)
   * - FileSearch (AsyncFzf) provides fast fuzzy matching
   * - No fs.stat() fan-out (uses indexed directory info)
   */
  async getSuggestions(pathQuery: string): Promise<FileSuggestion[] | null> {
    try {
      // Non-blocking fast path: use cached file list if available.
      // If the cache isn't warm yet, ensure the crawl is running and return
      // null so the caller can distinguish "cache miss" from "empty directory".
      const cached = this.getIndexedFilesIfCached();
      if (!cached) {
        const indexer = getFileIndexer();
        indexer
          .getFiles(this.workingDirectory, {
            showHidden: this.showHiddenFiles,
          })
          .catch(() => {});
        return null;
      }
      const { files, directories, directorySet } = cached;

      if (
        files.length === 0 &&
        directories.length === 0 &&
        !this.loggedEmptyIndex
      ) {
        this.loggedEmptyIndex = true;
        logWarn('[ChatFileSuggestions] No files indexed');
      }

      // Fast path: return cached empty-query result when file data hasn't changed.
      // The prewarm() call populates this cache so bare @ is essentially instant.
      if (
        !pathQuery &&
        this.cachedEmptyQuerySuggestions &&
        files === this.lastFiles &&
        directories === this.lastDirectories
      ) {
        return this.cachedEmptyQuerySuggestions;
      }

      // Only rebuild the combined array when the underlying data changes.
      // FileIndexer returns the same cached array references within the TTL window,
      // so reference comparison avoids rebuilding FileSearch on every keystroke.
      let filesAndDirectories: string[];
      if (
        files === this.lastFiles &&
        directories === this.lastDirectories &&
        this.cachedFilesAndDirectories
      ) {
        filesAndDirectories = this.cachedFilesAndDirectories;
      } else {
        filesAndDirectories = [...directories, ...files];
        this.lastFiles = files;
        this.lastDirectories = directories;
        this.cachedFilesAndDirectories = filesAndDirectories;
        // Invalidate empty-query cache when file data changes
        this.cachedEmptyQuerySuggestions = null;
      }

      // Use FileSearch (AsyncFzf) for fast fuzzy matching
      const filteredPaths = await this.filterFilesByQuery(
        filesAndDirectories,
        pathQuery
      );

      // Create suggestions WITHOUT fs.stat() fan-out
      // Use directorySet for O(1) directory lookup
      const suggestions = filteredPaths
        .map((path) => this.createFileSuggestionWithoutStat(path, directorySet))
        .filter((s): s is FileSuggestion => s !== null);

      const formatted = ChatFileSuggestions.formatSuggestions(suggestions);

      if (!pathQuery) {
        this.cachedEmptyQuerySuggestions = formatted;
      }

      return formatted;
    } catch (error) {
      // Return empty array on any error to not break the UI
      logException(error, 'Error occurred while fetching file suggestions');
      return [];
    }
  }

  /**
   * Complete a file path by replacing the query with the selected suggestion
   */
  static completeFilePath({
    text,
    cursorPosition,
    selectedSuggestion,
  }: {
    text: string;
    cursorPosition: number;
    selectedSuggestion: FileSuggestion;
  }): { newText: string; newCursorPosition: number } {
    const extraction = ChatFileSuggestions.extractPathQuery({
      text,
      cursorPosition,
    });

    if (!extraction) {
      return { newText: text, newCursorPosition: cursorPosition };
    }

    const { startIndex, endIndex } = extraction;
    const beforePath = text.substring(0, startIndex + 1); // Include the @
    const afterPath = text.substring(endIndex);

    // Add trailing space when user selects a suggestion (like Claude Code)
    const newText = `${beforePath}${selectedSuggestion.value} ${afterPath}`;
    const newCursorPosition =
      startIndex + 1 + selectedSuggestion.value.length + 1;

    return { newText, newCursorPosition };
  }

  /**
   * Check if cursor is currently in a @path context
   */
  static isInPathContext({
    text,
    cursorPosition,
  }: {
    text: string;
    cursorPosition: number;
  }): boolean {
    return (
      ChatFileSuggestions.extractPathQuery({ text, cursorPosition }) !== null
    );
  }

  /**
   * Update working directory
   */
  setWorkingDirectory(directory: string): void {
    this.workingDirectory = directory;
  }
}
