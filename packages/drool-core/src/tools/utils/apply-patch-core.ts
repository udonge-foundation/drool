import { MetaError } from '@industry/logging/errors';

import {
  PATCH_END_MARKER,
  UPDATE_FILE_MARKER,
  END_OF_FILE_MARKER,
  LINE_ADDITION_PREFIX,
  LINE_DELETION_PREFIX,
  CONTEXT_LINE_PREFIX,
  PATCH_START_MARKER,
  ADD_FILE_MARKER,
} from './constants';
import { FileOperation } from './enums';
import { PatchApplicationError } from './errors';
import { FileAction, ChangeChunk, FileCommit, ParsedPatch } from './types';

/**
 * Line Ending Utilities
 * These utilities help normalize and restore line endings for cross-platform compatibility
 */

/**
 * Detects the line ending style used in content
 * @param content - The content to analyze
 * @returns '\r\n' for Windows CRLF, '\n' for Unix LF
 */
export function detectLineEnding(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Normalizes content to use LF line endings
 * @param content - The content to normalize
 * @returns Content with only LF line endings
 */
export function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Converts content to use specified line ending
 * @param content - The content to convert
 * @param lineEnding - The target line ending style
 * @returns Content with the specified line endings
 */
export function convertLineEndings(
  content: string,
  lineEnding: '\r\n' | '\n'
): string {
  if (lineEnding === '\r\n') {
    // First normalize to LF, then convert to CRLF
    return normalizeToLF(content).replace(/\n/g, '\r\n');
  }
  return normalizeToLF(content);
}

/**
 * Parser class responsible for converting patch text into structured patch data
 */
class PatchTextParser {
  private readonly originalFileContents: Record<string, string>;

  private readonly patchLines: Array<string>;

  currentLineIndex = 0;

  parsedPatch: ParsedPatch = { actions: {} };

  fuzzyMatchScore = 0;

  constructor(
    originalFiles: Record<string, string>,
    patchLines: Array<string>
  ) {
    this.originalFileContents = originalFiles;
    this.patchLines = patchLines;
  }

  /**
   * Checks if parsing is complete or if we've encountered a stopping condition
   */
  private isParsingComplete(stopMarkers?: Array<string>): boolean {
    if (this.currentLineIndex >= this.patchLines.length) {
      return true;
    }

    if (stopMarkers) {
      const currentLine = this.patchLines[this.currentLineIndex]!;
      return stopMarkers.some((marker) =>
        currentLine.startsWith(marker.trim())
      );
    }

    return false;
  }

  /**
   * Checks if the current line starts with any of the given prefixes
   */
  private currentLineStartsWith(prefixes: string | Array<string>): boolean {
    const prefixArray = Array.isArray(prefixes) ? prefixes : [prefixes];
    const currentLine = this.patchLines[this.currentLineIndex]!;
    return prefixArray.some((prefix) => currentLine.startsWith(prefix));
  }

  /**
   * Reads a line with the specified prefix and advances the parser index
   */
  private readLineWithPrefix(
    expectedPrefix = '',
    includePrefix = false
  ): string {
    if (this.currentLineIndex >= this.patchLines.length) {
      throw new PatchApplicationError('Parser index exceeds patch length', {
        index: this.currentLineIndex,
        length: this.patchLines.length,
      });
    }

    const currentLine = this.patchLines[this.currentLineIndex]!;
    if (currentLine.startsWith(expectedPrefix)) {
      const extractedText = includePrefix
        ? currentLine
        : currentLine.slice(expectedPrefix.length);
      this.currentLineIndex += 1;
      return extractedText ?? '';
    }

    return '';
  }

  /**
   * Main parsing method that processes the patch text
   */
  public parsePatch(): void {
    while (!this.isParsingComplete([PATCH_END_MARKER])) {
      let filePath = this.readLineWithPrefix(UPDATE_FILE_MARKER);

      if (filePath) {
        this.validateFilePathForProcessing({ filePath });

        const originalFileContent = this.originalFileContents[filePath];
        const fileAction = this.parseFileUpdateAction(
          originalFileContent ?? ''
        );

        this.parsedPatch.actions[filePath] = fileAction;
        continue;
      }

      filePath = this.readLineWithPrefix(ADD_FILE_MARKER);

      if (filePath) {
        this.validateFilePathForProcessing({ filePath, isAddAction: true });

        const fileAction = this.parseFileAddAction();

        this.parsedPatch.actions[filePath] = fileAction;
        continue;
      }

      throw new PatchApplicationError('Unexpected line encountered', {
        line: this.patchLines[this.currentLineIndex],
      });
    }

    this.validatePatchEnd();
  }

  /**
   * Validates that a file path can be processed
   */
  private validateFilePathForProcessing({
    filePath,
    isAddAction = false,
  }: {
    filePath: string;
    isAddAction?: boolean;
  }): void {
    if (this.parsedPatch.actions[filePath]) {
      throw new PatchApplicationError('Duplicate file path in patch', {
        filePath,
      });
    }

    if (!isAddAction && !(filePath in this.originalFileContents)) {
      throw new PatchApplicationError('File not found in original files', {
        filePath,
      });
    }
  }

  /**
   * Validates that the patch ends correctly
   */
  private validatePatchEnd(): void {
    if (!this.currentLineStartsWith(PATCH_END_MARKER.trim())) {
      throw new PatchApplicationError('Patch missing end marker');
    }
    this.currentLineIndex += 1;
  }

  /**
   * Parses the add action for a new file
   */
  private parseFileAddAction(): FileAction {
    const lines: Array<string> = [];

    while (
      !this.isParsingComplete([
        PATCH_END_MARKER,
        UPDATE_FILE_MARKER,
        'Delete File:', // Note: DELETE_FILE_MARKER constant doesn't exist yet
        ADD_FILE_MARKER,
      ])
    ) {
      if (this.currentLineIndex >= this.patchLines.length) {
        throw new PatchApplicationError('Parser index exceeds patch length', {
          index: this.currentLineIndex,
          length: this.patchLines.length,
        });
      }

      const line = this.patchLines[this.currentLineIndex]!;

      if (!line.startsWith(LINE_ADDITION_PREFIX)) {
        throw new PatchApplicationError(
          `Invalid Add File line (missing '+'):`,
          { line }
        );
      }

      lines.push(line.slice(1)); // Strip leading '+'
      this.currentLineIndex += 1;
    }

    return {
      type: FileOperation.Create,
      chunks: [
        { originalLineIndex: 0, linesToDelete: [], linesToInsert: lines },
      ],
    };
  }

  /**
   * Parses the update action for a specific file
   */
  private parseFileUpdateAction(fileContent: string): FileAction {
    const action: FileAction = {
      type: FileOperation.Update,
      chunks: [],
    };

    const fileLines = fileContent.split('\n');
    let currentFileLineIndex = 0;

    while (
      !this.isParsingComplete([
        PATCH_END_MARKER,
        UPDATE_FILE_MARKER,
        END_OF_FILE_MARKER,
      ])
    ) {
      const contextDefinition = this.readLineWithPrefix('@@ ');
      let sectionMarker = '';

      // Handle special case where @@ appears alone
      if (
        !contextDefinition &&
        this.patchLines[this.currentLineIndex] === '@@'
      ) {
        sectionMarker = this.patchLines[this.currentLineIndex]!;
        this.currentLineIndex += 1;
      }

      // Validate that we have a valid section start
      if (!(contextDefinition || sectionMarker || currentFileLineIndex === 0)) {
        throw new PatchApplicationError('Invalid section start', {
          line: this.patchLines[this.currentLineIndex],
        });
      }

      // Find the context line in the file if specified
      if (contextDefinition.trim()) {
        currentFileLineIndex = this.findContextLineInFile(
          fileLines,
          contextDefinition,
          currentFileLineIndex
        );
      }

      // Parse the next section of changes
      const [contextLines, changeChunks, nextIndex, isEndOfFile] =
        PatchTextParser.parseNextChangeSection(
          this.patchLines,
          this.currentLineIndex
        );

      // Find where these changes should be applied
      const [updatedLineIndex, matchFuzziness, failedContextLine] =
        PatchTextParser.findContextInFile(
          fileLines,
          contextLines,
          currentFileLineIndex,
          isEndOfFile
        );

      if (updatedLineIndex === -1) {
        const contextText = contextLines.join('\n');
        const errorMessage = isEndOfFile
          ? 'Invalid end-of-file context'
          : 'Invalid context';

        // Include information about which specific line failed if available
        const errorDetails: Record<string, unknown> = {
          index: currentFileLineIndex,
          line: contextText,
        };

        if (failedContextLine !== undefined) {
          errorDetails.failedLine = failedContextLine;
          errorDetails.message = `Could not find context line: "${failedContextLine}"`;
        }

        throw new PatchApplicationError(errorMessage, errorDetails);
      }

      this.fuzzyMatchScore += matchFuzziness;

      // Update chunk positions and add to action

      for (const chunk of changeChunks) {
        chunk.originalLineIndex += updatedLineIndex;
        action.chunks.push(chunk);
      }

      currentFileLineIndex = updatedLineIndex + contextLines.length;
      this.currentLineIndex = nextIndex;
    }

    return action;
  }

  /**
   * Finds a context line in the file using fuzzy matching
   */
  private findContextLineInFile(
    fileLines: Array<string>,
    contextLine: string,
    startIndex: number
  ): number {
    let contextFound = false;

    // Try exact match first
    if (
      !fileLines
        .slice(0, startIndex)
        .some(
          (line) =>
            PatchTextParser.normalizeTextForComparison(line) ===
            PatchTextParser.normalizeTextForComparison(contextLine)
        )
    ) {
      for (let i = startIndex; i < fileLines.length; i++) {
        if (
          PatchTextParser.normalizeTextForComparison(fileLines[i]!) ===
          PatchTextParser.normalizeTextForComparison(contextLine)
        ) {
          startIndex = i + 1; // eslint-disable-line no-param-reassign
          contextFound = true;
          break;
        }
      }
    }

    // Try fuzzy match if exact match failed
    if (
      !contextFound &&
      !fileLines
        .slice(0, startIndex)
        .some(
          (line) =>
            PatchTextParser.normalizeTextForComparison(line.trim()) ===
            PatchTextParser.normalizeTextForComparison(contextLine.trim())
        )
    ) {
      for (let i = startIndex; i < fileLines.length; i++) {
        if (
          PatchTextParser.normalizeTextForComparison(fileLines[i]!.trim()) ===
          PatchTextParser.normalizeTextForComparison(contextLine.trim())
        ) {
          startIndex = i + 1; // eslint-disable-line no-param-reassign
          this.fuzzyMatchScore += 1;
          break;
        }
      }
    }

    return startIndex;
  }

  /**
   * Normalizes text for comparison by handling Unicode variants
   */
  private static normalizeTextForComparison(text: string): string {
    return text.normalize('NFC').replace(/./gu, (char) => {
      const unicodeEquivalents: Record<string, string> = {
        '-': '-',
        '\u2010': '-',
        '\u2011': '-',
        '\u2012': '-',
        '\u2013': '-',
        '\u2014': '-',
        '\u2212': '-',
        '\u0022': '"',
        '\u201C': '"',
        '\u201D': '"',
        '\u201E': '"',
        '\u00AB': '"',
        '\u00BB': '"',
        '\u0027': "'",
        '\u2018': "'",
        '\u2019': "'",
        '\u201B': "'",
        '\u00A0': ' ',
        '\u202F': ' ',
      };
      return unicodeEquivalents[char] ?? char;
    });
  }

  /**
   * Gets the parsed patch and fuzzy match score
   */
  public getParseResult(): [ParsedPatch, number] {
    return [this.parsedPatch, this.fuzzyMatchScore];
  }

  /**
   * Parses the next section of changes in the patch
   */
  private static parseNextChangeSection(
    patchLines: Array<string>,
    startIndex: number
  ): [Array<string>, Array<ChangeChunk>, number, boolean] {
    let currentIndex = startIndex;
    const contextLines: Array<string> = [];
    let linesToDelete: Array<string> = [];
    let linesToInsert: Array<string> = [];
    const chunks: Array<ChangeChunk> = [];
    let currentMode: 'context' | 'addition' | 'deletion' = 'context';

    while (currentIndex < patchLines.length) {
      const currentLine = patchLines[currentIndex]!;

      // Check for section terminators
      const terminators = [
        '@@',
        PATCH_END_MARKER,
        UPDATE_FILE_MARKER,
        END_OF_FILE_MARKER,
      ];
      if (
        terminators.some((terminator) =>
          currentLine.startsWith(terminator.trim())
        )
      ) {
        break;
      }

      if (currentLine === '***') {
        break;
      }

      if (currentLine.startsWith('***')) {
        throw new PatchApplicationError('Invalid line format', {
          line: currentLine,
        });
      }

      currentIndex += 1;
      const previousMode: 'context' | 'addition' | 'deletion' = currentMode;
      let processedLine = currentLine;

      // Determine line type and mode
      if (processedLine[0] === LINE_ADDITION_PREFIX) {
        currentMode = 'addition';
      } else if (processedLine[0] === LINE_DELETION_PREFIX) {
        currentMode = 'deletion';
      } else if (processedLine[0] === CONTEXT_LINE_PREFIX) {
        currentMode = 'context';
      } else {
        // Handle lines missing leading whitespace (model sometimes omits it)
        currentMode = 'context';
        processedLine = CONTEXT_LINE_PREFIX + processedLine;
      }

      // Remove the line prefix
      const lineContent = processedLine.slice(1);

      // Create chunk when transitioning from modifications back to context
      if (currentMode === 'context' && previousMode !== currentMode) {
        if (linesToInsert.length || linesToDelete.length) {
          chunks.push({
            originalLineIndex: contextLines.length - linesToDelete.length,
            linesToDelete,
            linesToInsert,
          });
        }
        linesToDelete = [];
        linesToInsert = [];
      }

      // Process line based on its type
      if (currentMode === 'deletion') {
        linesToDelete.push(lineContent);
        contextLines.push(lineContent);
      } else if (currentMode === 'addition') {
        linesToInsert.push(lineContent);
      } else {
        contextLines.push(lineContent);
      }
    }

    // Create final chunk if there are pending changes
    if (linesToInsert.length || linesToDelete.length) {
      chunks.push({
        originalLineIndex: contextLines.length - linesToDelete.length,
        linesToDelete,
        linesToInsert,
      });
    }

    // Check for end-of-file marker
    const isEndOfFile =
      currentIndex < patchLines.length &&
      patchLines[currentIndex] === END_OF_FILE_MARKER;

    if (isEndOfFile) {
      currentIndex += 1;
    }

    return [contextLines, chunks, currentIndex, isEndOfFile];
  }

  /**
   * Performs an ordered subsequence match that allows gaps between context lines.
   * Allows unmatched context lines as wildcards, but requires >= 75% of lines to match.
   * This handles cases where lines were inserted or some context is imperfect.
   *
   * Returns [matchIndex, fuzzScore, failedContextLine] where failedContextLine is set
   * when matching fails to indicate which context line could not be found.
   */
  private static findOrderedSubsequenceMatch(
    fileLines: Array<string>,
    contextLines: Array<string>,
    startPosition: number,
    maxGap = 100, // Safety limit to prevent excessive scanning
    normalizeFunc: (s: string) => string = (s) => s,
    minMatchRatio = 0.75 // Minimum ratio of context lines that must match (inclusive)
  ): [number, number, string | undefined] {
    if (contextLines.length === 0) {
      return [startPosition, 0, undefined];
    }

    let firstMatchIndex = -1;
    let skippedLines = 0;
    let wildcardPenalty = 0;
    let fileIndex = startPosition;
    const matchedContextIndices = new Set<number>();
    const unmatchedLines: Array<string> = [];

    // Try to match context lines in order, allowing wildcards
    for (const [contextIndex, contextLine] of contextLines.entries()) {
      if (fileIndex >= fileLines.length) {
        // Reached end of file, remaining context lines are wildcards
        unmatchedLines.push(contextLine);
        wildcardPenalty += 50;
        continue;
      }

      let matched = false;
      let matchPosition = -1;

      // Look ahead up to maxGap lines for a match
      for (
        let offset = 0;
        offset < maxGap && fileIndex + offset < fileLines.length;
        offset++
      ) {
        if (
          normalizeFunc(fileLines[fileIndex + offset]) ===
          normalizeFunc(contextLine)
        ) {
          matched = true;
          matchPosition = fileIndex + offset;
          break;
        }
      }

      if (matched) {
        // Found a match
        if (firstMatchIndex === -1) {
          firstMatchIndex = matchPosition;
        }
        matchedContextIndices.add(contextIndex);
        // Count skipped lines (gap between matches)
        if (matchedContextIndices.size > 1) {
          skippedLines += matchPosition - fileIndex;
        }
        // Advance past the match
        fileIndex = matchPosition + 1;
      } else {
        // No match found (wildcard)
        wildcardPenalty += 50;
        unmatchedLines.push(contextLine);
        // Don't advance fileIndex - allow next context line to search from same position
        // This enables overlapping searches without re-scanning (we use offset in lookahead)
      }
    }

    // Calculate match ratio
    const matchRatio = matchedContextIndices.size / contextLines.length;

    // Require >= minMatchRatio of context lines to match
    if (matchRatio < minMatchRatio) {
      const firstUnmatchedLine = unmatchedLines[0] ?? contextLines[0];
      return [-1, 0, firstUnmatchedLine];
    }

    // Return match position and fuzz score
    const fuzzScore = skippedLines * 5 + wildcardPenalty;
    return [firstMatchIndex, fuzzScore, undefined];
  }

  /**
   * Finds the context location in the file with fuzzy matching support
   *
   * Returns [matchIndex, fuzzScore, failedContextLine] where failedContextLine is set
   * when matching fails to indicate which context line could not be found.
   */
  private static findContextInFile(
    fileLines: Array<string>,
    contextLines: Array<string>,
    startPosition: number,
    isEndOfFile: boolean
  ): [number, number, string | undefined] {
    if (isEndOfFile) {
      // For end-of-file contexts, try matching from the end first
      let [matchIndex, fuzziness, failedLine] =
        PatchTextParser.findExactContextMatch(
          fileLines,
          contextLines,
          fileLines.length - contextLines.length
        );

      if (matchIndex !== -1) {
        return [matchIndex, fuzziness, undefined];
      }

      // Fallback to normal search with high fuzziness penalty
      [matchIndex, fuzziness, failedLine] =
        PatchTextParser.findExactContextMatch(
          fileLines,
          contextLines,
          startPosition
        );
      return [matchIndex, fuzziness + 10000, failedLine];
    }

    return PatchTextParser.findExactContextMatch(
      fileLines,
      contextLines,
      startPosition
    );
  }

  /**
   * Core context matching algorithm with multiple fuzzy matching passes
   *
   * Returns [matchIndex, fuzzScore, failedContextLine] where failedContextLine is set
   * when matching fails in ordered subsequence matching to indicate which line failed.
   */
  private static findExactContextMatch(
    fileLines: Array<string>,
    contextLines: Array<string>,
    startPosition: number
  ): [number, number, string | undefined] {
    if (contextLines.length === 0) {
      return [startPosition, 0, undefined];
    }

    const normalizeText = PatchTextParser.normalizeTextForComparison;

    // Pass 1: Exact match after Unicode normalization
    for (let i = startPosition; i < fileLines.length; i++) {
      const fileSegment = normalizeText(
        fileLines.slice(i, i + contextLines.length).join('\n')
      );
      const contextSegment = normalizeText(contextLines.join('\n'));

      if (fileSegment === contextSegment) {
        return [i, 0, undefined];
      }
    }

    // Pass 2: Ignore trailing whitespace
    for (let i = startPosition; i < fileLines.length; i++) {
      const fileSegment = normalizeText(
        fileLines
          .slice(i, i + contextLines.length)
          .map((line) => line.trimEnd())
          .join('\n')
      );
      const contextSegment = normalizeText(
        contextLines.map((line) => line.trimEnd()).join('\n')
      );

      if (fileSegment === contextSegment) {
        return [i, 1, undefined];
      }
    }

    // Pass 3: Ignore all surrounding whitespace
    for (let i = startPosition; i < fileLines.length; i++) {
      const fileSegment = normalizeText(
        fileLines
          .slice(i, i + contextLines.length)
          .map((line) => line.trim())
          .join('\n')
      );
      const contextSegment = normalizeText(
        contextLines.map((line) => line.trim()).join('\n')
      );

      if (fileSegment === contextSegment) {
        return [i, 100, undefined];
      }
    }

    // Pass 4: Try ordered subsequence matching with exact text
    const [subseqMatchIndex, subseqFuzz, subseqFailedLine] =
      PatchTextParser.findOrderedSubsequenceMatch(
        fileLines,
        contextLines,
        startPosition,
        100,
        normalizeText
      );

    if (subseqMatchIndex !== -1) {
      return [subseqMatchIndex, 200 + subseqFuzz, undefined];
    }

    // Pass 5: Try ordered subsequence matching with trimmed text
    const [trimmedMatchIndex, trimmedFuzz, trimmedFailedLine] =
      PatchTextParser.findOrderedSubsequenceMatch(
        fileLines,
        contextLines,
        startPosition,
        100,
        (s) => normalizeText(s.trim())
      );

    if (trimmedMatchIndex !== -1) {
      return [trimmedMatchIndex, 500 + trimmedFuzz, undefined];
    }

    // Return failed line from the last attempt (trimmed matching)
    // If that didn't have a failed line, use the one from exact subsequence matching
    const failedLine = trimmedFailedLine ?? subseqFailedLine;
    return [-1, 0, failedLine];
  }
}

/**
 * Applies changes to a file based on the parsed patch action
 */
function applyChangesToFile(
  originalFileContent: string,
  fileAction: FileAction,
  filePath: string
): string {
  if (fileAction.type !== FileOperation.Update) {
    throw new MetaError('Unsupported action type', { type: fileAction.type });
  }

  const originalLines = originalFileContent.split('\n');
  const modifiedLines: Array<string> = [];
  let currentOriginalIndex = 0;

  for (const chunk of fileAction.chunks) {
    // Validate chunk position
    if (chunk.originalLineIndex > originalLines.length) {
      throw new PatchApplicationError('chunk position exceeds file length', {
        filePath,
        index: chunk.originalLineIndex,
        length: originalLines.length,
      });
    }

    if (currentOriginalIndex > chunk.originalLineIndex) {
      throw new PatchApplicationError('chunks out of order', {
        filePath,
        index: chunk.originalLineIndex,
        currentIndex: chunk.originalLineIndex,
      });
    }

    // Copy unchanged lines before this chunk
    modifiedLines.push(
      ...originalLines.slice(currentOriginalIndex, chunk.originalLineIndex)
    );
    currentOriginalIndex = chunk.originalLineIndex;

    // Add inserted lines
    if (chunk.linesToInsert.length > 0) {
      modifiedLines.push(...chunk.linesToInsert);
    }

    // Skip deleted lines
    currentOriginalIndex += chunk.linesToDelete.length;
  }

  // Copy remaining unchanged lines
  modifiedLines.push(...originalLines.slice(currentOriginalIndex));

  return modifiedLines.join('\n');
}

/**
 * Public API Functions
 */

/**
 * Parses patch text and converts it to a structured patch object
 *
 * @param patchText - The patch text to parse
 * @param originalFiles - Map of file paths to their original content
 * @returns Tuple of [parsed patch, fuzzy match score]
 */
export function convertTextToPatch(
  patchText: string,
  originalFiles: Record<string, string>
): [ParsedPatch, number] {
  const patchLines = patchText.trim().split('\n');

  // Validate patch format
  if (
    patchLines.length < 2 ||
    !(patchLines[0] ?? '').startsWith(PATCH_START_MARKER.trim()) ||
    patchLines[patchLines.length - 1] !== PATCH_END_MARKER.trim()
  ) {
    throw new PatchApplicationError(
      'Invalid patch format - missing start or end markers'
    );
  }

  const parser = new PatchTextParser(originalFiles, patchLines);
  parser.currentLineIndex = 1; // Skip the start marker
  parser.parsePatch();

  return parser.getParseResult();
}

/**
 * Applies a parsed patch to the original files and returns the commit
 *
 * @param patch - The parsed patch to apply
 * @param originalFiles - Map of file paths to their original content
 * @returns Commit object containing the file changes
 */
export function applyPatchToFiles(
  patch: ParsedPatch,
  originalFiles: Record<string, string>
): FileCommit {
  const commit: FileCommit = { changes: {} };

  for (const [filePath, fileAction] of Object.entries(patch.actions)) {
    if (fileAction.type === FileOperation.Update) {
      const modifiedContent = applyChangesToFile(
        originalFiles[filePath]!,
        fileAction,
        filePath
      );

      commit.changes[filePath] = {
        type: FileOperation.Update,
        oldContent: originalFiles[filePath],
        newContent: modifiedContent,
      };
    }
  }

  return commit;
}
