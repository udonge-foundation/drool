import { parseInlineMarkdown } from '@/utils/markdown/parseInlineMarkdown';
import type { MarkdownToken } from '@/utils/markdown/types';

/**
 * Parse a markdown table
 */
function parseTable(
  lines: string[],
  startIndex: number
): { token: MarkdownToken; nextIndex: number } | null {
  let i = startIndex;
  const line = lines[i];

  // Check if this looks like a table header row
  if (!line.includes('|')) return null;

  // Parse header row - handle leading/trailing pipes
  let headerCells = line.split('|').map((cell) => cell.trim());

  // Remove empty first/last elements (from leading/trailing pipes)
  if (headerCells.length > 0 && headerCells[0] === '') {
    headerCells = headerCells.slice(1);
  }
  if (headerCells.length > 0 && headerCells[headerCells.length - 1] === '') {
    headerCells = headerCells.slice(0, -1);
  }

  if (headerCells.length === 0) return null;

  // Check for separator row (next line should be like |---|---|---|)
  i++;
  if (i >= lines.length) return null;

  const separatorLine = lines[i];
  if (!separatorLine.includes('|')) return null;

  let separatorCells = separatorLine.split('|').map((cell) => cell.trim());

  // Remove empty first/last elements (from leading/trailing pipes)
  if (separatorCells.length > 0 && separatorCells[0] === '') {
    separatorCells = separatorCells.slice(1);
  }
  if (
    separatorCells.length > 0 &&
    separatorCells[separatorCells.length - 1] === ''
  ) {
    separatorCells = separatorCells.slice(0, -1);
  }

  // Validate separator format (should be dashes with optional colons for alignment)
  const alignments: Array<'left' | 'center' | 'right' | null> = [];
  for (const cell of separatorCells) {
    if (!/^:?-+:?$/.test(cell)) {
      // Not a valid table separator
      return null;
    }

    // Determine alignment from colons
    if (cell.startsWith(':') && cell.endsWith(':')) {
      alignments.push('center');
    } else if (cell.endsWith(':')) {
      alignments.push('right');
    } else if (cell.startsWith(':')) {
      alignments.push('left');
    } else {
      alignments.push(null); // Default alignment
    }
  }

  // Must have same number of columns
  if (alignments.length !== headerCells.length) return null;

  // Parse data rows
  const rows: string[][] = [];
  i++;
  while (i < lines.length) {
    const rowLine = lines[i];
    // Stop at empty line or non-table line
    if (!rowLine.trim() || !rowLine.includes('|')) break;

    let rowCells = rowLine.split('|').map((cell) => cell.trim());

    // Remove empty first/last elements (from leading/trailing pipes)
    if (rowCells.length > 0 && rowCells[0] === '') {
      rowCells = rowCells.slice(1);
    }
    if (rowCells.length > 0 && rowCells[rowCells.length - 1] === '') {
      rowCells = rowCells.slice(0, -1);
    }

    // Only add row if it has cells
    if (rowCells.length > 0) {
      // Pad or truncate to match header column count
      while (rowCells.length < headerCells.length) {
        rowCells.push('');
      }
      if (rowCells.length > headerCells.length) {
        rowCells.length = headerCells.length;
      }
      rows.push(rowCells);
    }

    i++;
  }

  // Build table token
  const token: MarkdownToken = {
    type: 'table',
    content: lines.slice(startIndex, i).join('\n'),
    table: {
      headers: headerCells,
      alignments,
      rows,
    },
  };

  return { token, nextIndex: i };
}

/**
 * Parse markdown text into tokens
 */
export function parseMarkdown(markdown: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];

  // Handle empty input
  if (!markdown) {
    return tokens;
  }

  // Helpers for list parsing
  type ListKind = 'ul' | 'ol' | 'task';
  interface ListLineInfo {
    isList: true;
    indent: number;
    kind: ListKind;
    content: string;
    number?: number; // for ordered lists
    checked?: boolean; // for task lists
  }

  const getIndent = (line: string): number => {
    const m = line.match(/^\s*/);
    return m ? m[0].length : 0;
  };

  const getListLineInfo = (line: string): ListLineInfo | null => {
    // Task list: - [ ] item or - [x] item (allow *, + as well)
    const taskMatch = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      return {
        isList: true,
        indent: getIndent(line),
        kind: 'task',
        content: taskMatch[2],
        checked: taskMatch[1].toLowerCase() === 'x',
      };
    }
    // Ordered list: 1. item
    const olMatch = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (olMatch) {
      return {
        isList: true,
        indent: getIndent(line),
        kind: 'ol',
        number: parseInt(olMatch[1], 10),
        content: olMatch[2],
      };
    }
    // Unordered list: -, *, +
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ulMatch) {
      return {
        isList: true,
        indent: getIndent(line),
        kind: 'ul',
        content: ulMatch[1],
      };
    }
    // Unordered list with common Unicode bullets: •, ▪, ◦, ‣, ∙
    const ulUnicodeMatch = line.match(/^\s*[•▪◦‣∙]\s+(.*)$/);
    if (ulUnicodeMatch) {
      return {
        isList: true,
        indent: getIndent(line),
        kind: 'ul',
        content: ulUnicodeMatch[1],
      };
    }
    return null;
  };

  const parseListBlock = (
    lines: string[],
    startIndex: number,
    baseIndent: number,
    initialKind?: ListKind
  ): { token: MarkdownToken; nextIndex: number } => {
    let i = startIndex;
    const items: MarkdownToken[][] = [];
    const rawContents: string[] = [];
    let kind: ListKind | undefined = initialKind;
    let orderedStart: number | undefined;

    while (i < lines.length) {
      const line = lines[i];
      // Stop at blank line
      if (line.trim() === '') break;
      const info = getListLineInfo(line);
      if (!info) break;
      // Stop if list dedents
      if (info.indent < baseIndent) break;

      // Nested list case
      if (info.indent > baseIndent) {
        // Must have at least one item to attach nested list to
        if (items.length === 0) {
          // If nested before any top-level item, treat as end
          break;
        }
        const { token: nested, nextIndex } = parseListBlock(
          lines,
          i,
          info.indent
        );
        // Attach nested list to last item's tokens
        items[items.length - 1].push(nested);
        i = nextIndex;
        continue;
      }

      // info.indent === baseIndent
      // Capture starting number for ordered lists on the first encountered item
      if (
        kind === 'ol' &&
        orderedStart == null &&
        typeof info.number === 'number'
      ) {
        orderedStart = info.number;
      }
      if (!kind) {
        kind = info.kind;
        if (kind === 'ol' && typeof info.number === 'number') {
          orderedStart = info.number;
        }
      } else if (kind !== info.kind) {
        // Different list type at same indent -> end current list
        break;
      }

      // New top-level list item
      const itemInline = parseInlineMarkdown(info.content);
      if (kind === 'task') {
        // Propagate checked on first token
        if (itemInline.length > 0) {
          itemInline[0].checked = !!info.checked;
        } else {
          // Ensure an item exists
          itemInline.push({
            type: 'text',
            content: '',
            checked: !!info.checked,
          });
        }
      }
      items.push(itemInline);
      rawContents.push(info.content);
      i++;
    }

    // Build list token
    let token: MarkdownToken;
    if (kind === 'ol') {
      token = {
        type: 'ordered_list',
        content: rawContents.join('\n'),
        start: typeof orderedStart === 'number' ? orderedStart : 1,
        listItems: items,
      };
    } else if (kind === 'task') {
      token = {
        type: 'task_list',
        content: rawContents.join('\n'),
        listItems: items,
      };
    } else {
      token = {
        type: 'unordered_list',
        content: rawContents.join('\n'),
        listItems: items,
      };
    }
    return { token, nextIndex: i };
  };

  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line - add line break token
    if (line.trim() === '') {
      tokens.push({ type: 'line_break', content: '' });
      i++;
      continue;
    }

    // Headers (# ## ### etc.)
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      tokens.push({
        type: 'heading',
        content: headerMatch[2],
        level: headerMatch[1].length,
      });
      i++;
      continue;
    }

    // Horizontal rule (---, ***, ___)
    if (line.match(/^(\*{3,}|-{3,}|_{3,})$/)) {
      tokens.push({ type: 'horizontal_rule', content: line });
      i++;
      continue;
    }

    // Code block (```)
    // Per CommonMark spec, code fences can be indented by 0-3 spaces
    const codeBlockMatch = line.match(/^ {0,3}```(\w+)?$/);
    if (codeBlockMatch) {
      const language = codeBlockMatch[1];
      const codeLines: string[] = [];
      i++; // Skip opening ```

      // Per CommonMark spec, the closing fence can also be indented 0-3 spaces
      while (i < lines.length && !lines[i].match(/^ {0,3}```$/)) {
        codeLines.push(lines[i]);
        i++;
      }

      tokens.push({
        type: 'code_block',
        content: codeLines.join('\n'),
        language,
      });
      i++; // Skip closing ```
      continue;
    }

    // Blockquote (> text)
    if (line.match(/^>\s/)) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].match(/^>\s/)) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }

      tokens.push({
        type: 'blockquote',
        content: quoteLines.join('\n'),
      });
      continue;
    }

    // Table (GitHub Flavored Markdown style)
    // Check if this line looks like a table row (contains |)
    if (line.includes('|')) {
      // Try to parse as a table
      const tableResult = parseTable(lines, i);
      if (tableResult) {
        tokens.push(tableResult.token);
        i = tableResult.nextIndex;
        continue;
      }
    }

    // Unified list handling (task/ordered/unordered) with indentation-aware nesting
    const listInfo = getListLineInfo(line);
    if (listInfo) {
      const { token: listToken, nextIndex } = parseListBlock(
        lines,
        i,
        listInfo.indent,
        listInfo.kind
      );
      tokens.push(listToken);
      i = nextIndex;
      continue;
    }

    // Regular paragraph - parse inline markdown
    const inlineTokens = parseInlineMarkdown(line);
    tokens.push(...inlineTokens);
    // Insert a soft line break to separate consecutive text lines (preserve newlines)
    if (i < lines.length - 1 && lines[i + 1].trim() !== '') {
      tokens.push({ type: 'line_break', content: 'soft' });
    }
    i++;
  }

  return tokens;
}
