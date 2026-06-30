import chalk from 'chalk';
import hljs from 'highlight.js';
import React from 'react';

import { SyntaxHighlighter } from '@/components/SyntaxHighlighter';
import {
  LANGUAGE_ALIASES,
  SYNTAX_COLORS,
  defaultSyntaxConfig,
} from '@/utils/syntaxHighlighter/constants';
import type { SyntaxHighlighterConfig } from '@/utils/syntaxHighlighter/types';
import { getTerminalTheme } from '@/utils/terminalTheme';

/**
 * Get syntax config with terminal theme applied
 */
export function getThemedSyntaxConfig(): SyntaxHighlighterConfig {
  return {
    ...defaultSyntaxConfig,
    theme: getTerminalTheme(),
  };
}

/**
 * Decode HTML entities in highlighted code
 */
export function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&#x2F;': '/',
    '&#x60;': '`',
    '&#x3D;': '=',
    '&nbsp;': ' ',
  };

  return text.replace(/&[#\w]+;/g, (entity) => entities[entity] || entity);
}

/**
 * Normalize and detect language from input
 */
export function detectLanguage(language?: string): string | undefined {
  if (!language) return undefined;

  const normalized = language.toLowerCase().trim();

  // Check if it's an alias
  if (LANGUAGE_ALIASES[normalized]) {
    return LANGUAGE_ALIASES[normalized];
  }

  // Check if highlight.js recognizes it directly
  if (hljs.getLanguage(normalized)) {
    return normalized;
  }

  // Try some common variations
  const variations = [
    normalized.replace(/script$/, ''), // javascript -> java
    normalized.replace(/^\./, ''), // .js -> js
    normalized.split('.').pop(), // file.ext -> ext
  ];

  for (const variation of variations) {
    if (variation && LANGUAGE_ALIASES[variation]) {
      return LANGUAGE_ALIASES[variation];
    }
    if (variation && hljs.getLanguage(variation)) {
      return variation;
    }
  }

  return undefined;
}

/**
 * Perform syntax highlighting on code
 */
export function highlightCodeString(code: string, language: string): string {
  try {
    const result = hljs.highlight(code, {
      language,
      ignoreIllegals: true,
    });
    return result.value;
  } catch (_error) {
    // Fall back to plain text on error
    return code;
  }
}

/**
 * React component wrapper for syntax highlighting
 */
export function highlightCode(
  code: string,
  language?: string,
  config?: SyntaxHighlighterConfig
): React.ReactNode {
  const effectiveConfig = config ?? getThemedSyntaxConfig();
  return React.createElement(SyntaxHighlighter, {
    code,
    language,
    config: effectiveConfig,
  });
}

/**
 * Convert highlight.js HTML output to a chalk-colored ANSI string.
 */
export function convertHtmlToAnsi(html: string): string {
  const colorMap = SYNTAX_COLORS;
  const applyColor = (text: string, color: string | undefined): string => {
    if (!color) return text;
    if (color.startsWith('#')) {
      return chalk.hex(color)(text);
    }
    const fn = (chalk as unknown as Record<string, unknown>)[color];
    return typeof fn === 'function'
      ? (fn as (str: string) => string)(text)
      : text;
  };

  let processed = html;
  // Match only innermost spans (no nested <span inside the content).
  // The while loop peels spans inside-out on each iteration.
  const spanRegex =
    /<span[^>]*class="([^"]+)"[^>]*>((?:(?!<span)[\s\S])*?)<\/span>/g;
  while (true) {
    spanRegex.lastIndex = 0;
    if (!spanRegex.test(processed)) break;
    processed = processed.replace(
      spanRegex,
      (_m, classes: string, inner: string) => {
        const relevant = classes
          .split(' ')
          .find(
            (cls) =>
              Object.getOwnPropertyDescriptor(colorMap, cls) !== undefined
          );
        const innerStripped = inner.replace(/<[^>]*>/g, '');
        return applyColor(
          innerStripped,
          relevant ? (colorMap as Record<string, string>)[relevant] : undefined
        );
      }
    );
  }
  processed = processed.replace(/<[^>]*>/g, '');
  processed = decodeHtmlEntities(processed);
  return processed;
}

/**
 * Syntax-highlight a single line of code and return a chalk-colored ANSI string.
 * Returns the original text if highlighting is not possible.
 */
export function highlightLineToAnsi(
  line: string,
  language: string | undefined
): string {
  if (!language) return line;
  const html = highlightCodeString(line, language);
  if (html === line) return line;
  return convertHtmlToAnsi(html);
}
