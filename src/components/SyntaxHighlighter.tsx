import { Text, Box } from 'ink';
import React from 'react';

import { COLORS } from '@/components/chat/themedColors';
import { generateStableKey } from '@/utils/generateStableKey';
import { defaultSyntaxConfig } from '@/utils/syntaxHighlighter/constants';
import {
  convertHtmlToAnsi,
  detectLanguage,
  highlightCodeString,
} from '@/utils/syntaxHighlighter/highlight';
import type { SyntaxHighlighterConfig } from '@/utils/syntaxHighlighter/types';

const GUTTER_WIDTH = 6; // "  1 │ " = 3 padded digits + separator + space

function renderLineWithGutter(
  lineNum: number,
  content: string,
  key: string
): React.ReactElement {
  return (
    <Box key={key} flexDirection="row">
      <Box width={GUTTER_WIDTH} flexShrink={0}>
        <Text color={COLORS.text.muted}>
          {`${lineNum.toString().padStart(3, ' ')} │ `}
        </Text>
      </Box>
      <Text wrap="truncate-end">{content}</Text>
    </Box>
  );
}

interface SyntaxHighlighterProps {
  code: string;
  language?: string;
  config?: SyntaxHighlighterConfig;
}

/**
 * Parse highlighted HTML and render as ANSI-colored single Text lines
 */
function parseHighlightedHtml(
  html: string,
  config: SyntaxHighlighterConfig
): React.ReactNode {
  const processed = convertHtmlToAnsi(html);
  const lines = processed.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => {
        const content = line === '' ? ' ' : line;
        if (config.showLineNumbers) {
          return renderLineWithGutter(
            idx + 1,
            content,
            generateStableKey(line || ' ', idx, 'ansi-line')
          );
        }
        return (
          <Text key={generateStableKey(line || ' ', idx, 'ansi-line')}>
            {content}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Syntax Highlighter React Component
 */
export function SyntaxHighlighter({
  code,
  language,
  config = defaultSyntaxConfig,
}: SyntaxHighlighterProps): React.ReactElement {
  // Handle empty code
  if (!code.trim()) {
    return <Text color={COLORS.text.muted}> </Text>;
  }

  // Detect and normalize language
  const detectedLanguage = detectLanguage(language);

  // If no language or unsupported language, return plain text
  if (!detectedLanguage) {
    const lines = code.split('\n');
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => {
          const content = line || ' ';
          if (config.showLineNumbers) {
            return renderLineWithGutter(
              index + 1,
              content,
              generateStableKey(content, index, 'plain-one')
            );
          }
          return (
            <Text key={generateStableKey(content, index, 'plain-one')}>
              {content}
            </Text>
          );
        })}
      </Box>
    );
  }

  // Perform syntax highlighting
  const highlightedHtml = highlightCodeString(code, detectedLanguage);

  if (highlightedHtml === code) {
    // Highlighting failed, fall back to plain text
    const lines = code.split('\n');
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => {
          const content = line || ' ';
          if (config.showLineNumbers) {
            return renderLineWithGutter(
              index + 1,
              content,
              generateStableKey(line || ' ', index, 'fallback-one')
            );
          }
          return (
            <Text key={generateStableKey(line || ' ', index, 'fallback-one')}>
              {content}
            </Text>
          );
        })}
      </Box>
    );
  }

  return <>{parseHighlightedHtml(highlightedHtml, config)}</>;
}
