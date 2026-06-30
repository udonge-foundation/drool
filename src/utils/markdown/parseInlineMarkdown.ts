import type { MarkdownToken } from '@/utils/markdown/types';

/**
 * Parse inline markdown elements within a line
 */

export function parseInlineMarkdown(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];

  // First, temporarily replace escaped characters
  let processedText = text;
  const escapeMap = new Map<string, string>();
  let escapeIndex = 0;

  // Pattern to detect Windows paths (including UNC paths)
  // Matches: C:\path\to\file, \\server\share\path, etc.
  // This matches drive paths (C:\...) and UNC paths (\\server\...)
  // It stops at spaces to avoid capturing too much
  const WINDOWS_PATH_PATTERN =
    /(?:[A-Za-z]:\\(?:[^\s<>:"|?*\n\r\\]+\\)*[^\s<>:"|?*\n\r\\]*)|(?:\\\\[^\s\\<>:"|?*\n\r]+(?:\\[^\s<>:"|?*\n\r]+)*)/g;

  // Step 1: Protect Windows paths by replacing them with placeholders
  const pathMap = new Map<string, string>();
  let pathIndex = 0;
  processedText = processedText.replace(WINDOWS_PATH_PATTERN, (match) => {
    const placeholder = `\uE100${pathIndex}\uE101`;
    pathMap.set(placeholder, match);
    pathIndex++;
    return placeholder;
  });

  // Step 2: Replace escaped markdown characters only (not all backslashes)
  // Only escape markdown special characters: *, _, ~, `, [, ], (, ), #, >, !, \
  processedText = processedText.replace(
    /\\([*_~`[\]()#>!\\])/g,
    (_match, char) => {
      const placeholder = `\uE000${escapeIndex}\uE001`;
      escapeMap.set(placeholder, char); // Store just the escaped character, not the backslash
      escapeIndex++;
      return placeholder;
    }
  );

  // Pattern to match all inline elements
  const pattern =
    /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)|<(https?:\/\/[^>]+)>)/g;

  let lastIndex = 0;

  // Helper function to restore escaped characters and Windows paths
  const restoreEscapes = (str: string): string => {
    let result = str;
    // Restore escape sequences first
    escapeMap.forEach((original, placeholder) => {
      result = result.replace(placeholder, original);
    });
    // Then restore Windows paths
    pathMap.forEach((original, placeholder) => {
      result = result.replace(placeholder, original);
    });
    return result;
  };

  let match = pattern.exec(processedText);
  while (match !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      const beforeText = processedText.substring(lastIndex, match.index);
      if (beforeText) {
        tokens.push({ type: 'text', content: restoreEscapes(beforeText) });
      }
    }

    const matchedText = match[0];

    // Bold and italic (***text***)
    if (matchedText.match(/^\*\*\*[^*]+\*\*\*$/)) {
      tokens.push({
        type: 'bold_italic',
        content: restoreEscapes(matchedText.slice(3, -3)),
      });
    }

    // Bold (**text**)
    else if (matchedText.match(/^\*\*[^*]+\*\*$/)) {
      tokens.push({
        type: 'bold',
        content: restoreEscapes(matchedText.slice(2, -2)),
      });
    }

    // Italic (*text*)
    else if (matchedText.match(/^\*[^*]+\*$/)) {
      tokens.push({
        type: 'italic',
        content: restoreEscapes(matchedText.slice(1, -1)),
      });
    }

    // Strikethrough (~~text~~)
    else if (matchedText.match(/^~~[^~]+~~$/)) {
      tokens.push({
        type: 'strikethrough',
        content: restoreEscapes(matchedText.slice(2, -2)),
      });
    }

    // Inline code (`code`)
    else if (matchedText.match(/^`[^`]+`$/)) {
      tokens.push({
        type: 'inline_code',
        content: restoreEscapes(matchedText.slice(1, -1)),
      });
    }

    // Links ([text](url "title"))
    else if (match[2] && match[3]) {
      tokens.push({
        type: 'link',
        content: restoreEscapes(match[2]),
        url: restoreEscapes(match[3]),
        title: match[4] ? restoreEscapes(match[4]) : undefined,
      });
    }

    // Autolinks (<url>)
    else if (match[5]) {
      tokens.push({
        type: 'autolink',
        content: restoreEscapes(match[5]),
        url: restoreEscapes(match[5]),
      });
    }

    lastIndex = pattern.lastIndex;
    match = pattern.exec(processedText);
  }

  // Add remaining text
  if (lastIndex < processedText.length) {
    const remainingText = processedText.substring(lastIndex);
    if (remainingText) {
      tokens.push({ type: 'text', content: restoreEscapes(remainingText) });
    }
  }

  // If no inline elements found, return the whole text as a single token
  if (tokens.length === 0) {
    tokens.push({ type: 'text', content: text });
  }

  return tokens;
}
