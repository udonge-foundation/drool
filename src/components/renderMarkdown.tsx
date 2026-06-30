import { Text, Box } from 'ink';
import React from 'react';

import { COLORS } from '@/components/chat/themedColors';
import { MermaidCodeBlock } from '@/components/MermaidCodeBlock';
import { displayWidth as getDisplayWidth } from '@/utils/displayWidth';
import { generateStableKey } from '@/utils/generateStableKey';
import {
  makeHyperlink,
  sanitizeHyperlinkUrl,
  supportsTerminalHyperlinks,
} from '@/utils/hyperlinks';
import { getThemedMarkdownConfig } from '@/utils/markdown/themedConfig';
import type { MarkdownToken, MarkdownConfig } from '@/utils/markdown/types';
import { highlightCode } from '@/utils/syntaxHighlighter/highlight';
import {
  linkSegment,
  renderWrappedTerminalRows,
  textSegment,
} from '@/utils/terminalSegments';
import type {
  TerminalSegment,
  TerminalStyle,
} from '@/utils/terminalSegments/types';

const BARE_URL_PATTERN = /(?:https?:\/\/|file:\/\/)[^\s<>"'`]+/g;
const TRAILING_URL_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Wrap text to fit within a maximum width
 */
function wrapTextToWidth(text: string, maxWidth: number): string[] {
  if (getDisplayWidth(text) <= maxWidth) return [text];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const wordWidth = getDisplayWidth(word);
    const currentWidth = getDisplayWidth(currentLine);
    const spaceWidth = currentLine ? 1 : 0;

    if (currentWidth + spaceWidth + wordWidth <= maxWidth) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);

      if (wordWidth > maxWidth) {
        let remaining = word;
        while (remaining.length > 0) {
          let chunk = '';
          let chunkWidth = 0;
          for (const char of remaining) {
            const charWidth = getDisplayWidth(char);
            if (chunkWidth + charWidth <= maxWidth) {
              chunk += char;
              chunkWidth += charWidth;
            } else {
              break;
            }
          }
          if (chunk) {
            lines.push(chunk);
            remaining = remaining.slice(chunk.length);
          } else {
            const chars = Array.from(remaining);
            lines.push(chars[0]);
            remaining = chars.slice(1).join('');
          }
        }
        currentLine = '';
      } else {
        currentLine = word;
      }
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [text];
}

function getMinimumRenderableWidth(text: string): number {
  let minimumWidth = 1;

  for (const char of text) {
    minimumWidth = Math.max(minimumWidth, getDisplayWidth(char));
  }

  return minimumWidth;
}

function terminalStyle(
  color: string | undefined,
  options?: Pick<TerminalStyle, 'bold' | 'italic' | 'strikethrough'>
): TerminalStyle | undefined {
  const style: TerminalStyle = {};
  if (color) style.color = color;
  if (options?.bold) style.bold = true;
  if (options?.italic) style.italic = true;
  if (options?.strikethrough) style.strikethrough = true;
  return Object.keys(style).length > 0 ? style : undefined;
}

function splitTrailingUrlPunctuation(rawUrl: string): {
  urlText: string;
  trailingText: string;
} {
  let urlText = rawUrl;
  let trailingText = '';
  const trailing = urlText.match(TRAILING_URL_PUNCTUATION)?.[0] ?? '';
  if (trailing) {
    urlText = urlText.slice(0, -trailing.length);
    trailingText = trailing;
  }

  while (
    urlText.endsWith(')') &&
    urlText.split(')').length > urlText.split('(').length
  ) {
    urlText = urlText.slice(0, -1);
    trailingText = `)${trailingText}`;
  }

  if (!trailingText) return { urlText: rawUrl, trailingText: '' };
  return {
    urlText,
    trailingText,
  };
}

function appendTextWithBareLinks(
  segments: TerminalSegment[],
  content: string,
  style: TerminalStyle | undefined,
  terminalLinksSupported: boolean
): boolean {
  if (!terminalLinksSupported) {
    segments.push(textSegment(content, style));
    return false;
  }

  let foundLink = false;
  let lastIndex = 0;
  BARE_URL_PATTERN.lastIndex = 0;

  let match = BARE_URL_PATTERN.exec(content);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push(textSegment(content.slice(lastIndex, match.index), style));
    }

    const rawMatch = match[0];
    const { urlText, trailingText } = splitTrailingUrlPunctuation(rawMatch);
    const sanitizedUrl = sanitizeHyperlinkUrl(urlText);
    const link = sanitizedUrl
      ? linkSegment(sanitizedUrl, [textSegment(urlText, style)])
      : null;

    if (link) {
      segments.push(link);
      foundLink = true;
    } else {
      segments.push(textSegment(urlText, style));
    }

    if (trailingText) {
      segments.push(textSegment(trailingText, style));
    }

    lastIndex = match.index + rawMatch.length;
    match = BARE_URL_PATTERN.exec(content);
  }

  if (lastIndex < content.length) {
    segments.push(textSegment(content.slice(lastIndex), style));
  }

  return foundLink;
}

/**
 * Render syntax-highlighted code using the new syntax highlighter
 */
function renderCodeBlock(
  content: string,
  config: MarkdownConfig,
  language?: string
): React.ReactNode {
  if (!config.syntaxHighlighting) {
    return (
      <Box flexDirection="column">
        {content.split('\n').map((line, _index) => {
          const lineKey = `code-${(line || ' ').substring(0, 30).replace(/[^a-zA-Z0-9]/g, '')}-${line.length}-${Math.random().toString(36).substring(2, 11)}`;
          return (
            <Text key={lineKey} color={COLORS.text.info}>
              {line || ' '}
            </Text>
          );
        })}
      </Box>
    );
  }

  return highlightCode(content, language, config.syntaxConfig);
}

/**
 * Render markdown tokens to React components
 */
export function renderMarkdown(
  tokens: MarkdownToken[],
  config?: MarkdownConfig,
  parentColor?: string
): React.ReactNode[] {
  const finalConfig = config || getThemedMarkdownConfig();
  const isInline = (type: MarkdownToken['type']) =>
    type === 'text' ||
    type === 'bold' ||
    type === 'italic' ||
    type === 'bold_italic' ||
    type === 'strikethrough' ||
    type === 'inline_code' ||
    type === 'link' ||
    type === 'autolink';

  const renderInlineGroup = (
    group: MarkdownToken[],
    keyBase: string,
    groupConfig: MarkdownConfig = finalConfig
  ): React.ReactNode => {
    const renderTerminalLinkedRows = (): React.ReactNode | null => {
      const terminalLinksSupported =
        Boolean(groupConfig.maxWidth) &&
        groupConfig.allowTerminalLinks &&
        supportsTerminalHyperlinks();
      if (!terminalLinksSupported || !groupConfig.maxWidth) return null;

      const segments: TerminalSegment[] = [];
      let hasLink = false;

      for (const tok of group) {
        switch (tok.type) {
          case 'bold':
            hasLink =
              appendTextWithBareLinks(
                segments,
                tok.content,
                terminalStyle(parentColor || groupConfig.colors.bold, {
                  bold: true,
                }),
                terminalLinksSupported
              ) || hasLink;
            break;
          case 'italic':
            hasLink =
              appendTextWithBareLinks(
                segments,
                tok.content,
                terminalStyle(parentColor || groupConfig.colors.italic, {
                  italic: true,
                }),
                terminalLinksSupported
              ) || hasLink;
            break;
          case 'bold_italic':
            hasLink =
              appendTextWithBareLinks(
                segments,
                tok.content,
                terminalStyle(parentColor || groupConfig.colors.bold, {
                  bold: true,
                  italic: true,
                }),
                terminalLinksSupported
              ) || hasLink;
            break;
          case 'strikethrough':
            hasLink =
              appendTextWithBareLinks(
                segments,
                tok.content,
                terminalStyle(parentColor || groupConfig.colors.strikethrough, {
                  strikethrough: true,
                }),
                terminalLinksSupported
              ) || hasLink;
            break;
          case 'inline_code':
            segments.push(
              textSegment(
                tok.content,
                terminalStyle(parentColor || groupConfig.colors.code, {
                  bold: true,
                })
              )
            );
            break;
          case 'link': {
            const linkUrl = tok.url ?? '';
            const sanitizedUrl = sanitizeHyperlinkUrl(linkUrl);
            const style = terminalStyle(parentColor || groupConfig.colors.link);
            const link = sanitizedUrl
              ? linkSegment(sanitizedUrl, [textSegment(tok.content, style)])
              : null;
            if (link) {
              segments.push(link);
              hasLink = true;
            } else {
              segments.push(textSegment(tok.content, style));
              if (linkUrl && linkUrl !== tok.content) {
                segments.push(textSegment(` (${linkUrl})`, style));
              }
            }
            break;
          }
          case 'autolink': {
            const linkUrl = tok.url ?? '';
            const sanitizedUrl = sanitizeHyperlinkUrl(linkUrl);
            const style = terminalStyle(parentColor || groupConfig.colors.link);
            const label = linkUrl || tok.content;
            const link = sanitizedUrl
              ? linkSegment(sanitizedUrl, [textSegment(label, style)])
              : null;
            if (link) {
              segments.push(link);
              hasLink = true;
            } else {
              segments.push(textSegment(label, style));
            }
            break;
          }
          case 'text':
          default:
            hasLink =
              appendTextWithBareLinks(
                segments,
                tok.content,
                terminalStyle(parentColor),
                terminalLinksSupported
              ) || hasLink;
            break;
        }
      }

      if (!hasLink) return null;

      return (
        <Box key={`${keyBase}-terminal-links`} flexDirection="column">
          {renderWrappedTerminalRows(segments, groupConfig.maxWidth).map(
            (row, rowIndex) => (
              <Text key={`${keyBase}-terminal-link-row-${rowIndex}`}>
                {row || ' '}
              </Text>
            )
          )}
        </Box>
      );
    };

    const terminalLinkedRows = renderTerminalLinkedRows();
    if (terminalLinkedRows) return terminalLinkedRows;

    const spans = group.map((tok, idx) => {
      const spanKey = `${keyBase}-span-${idx}`;
      switch (tok.type) {
        case 'bold':
          return (
            <Text
              key={spanKey}
              color={parentColor || groupConfig.colors.bold}
              bold
            >
              {tok.content}
            </Text>
          );
        case 'italic':
          return (
            <Text
              key={spanKey}
              color={parentColor || groupConfig.colors.italic}
              italic
            >
              {tok.content}
            </Text>
          );
        case 'bold_italic':
          return (
            <Text
              key={spanKey}
              color={parentColor || groupConfig.colors.bold}
              bold
              italic
            >
              {tok.content}
            </Text>
          );
        case 'strikethrough':
          return (
            <Text
              key={spanKey}
              color={parentColor || groupConfig.colors.strikethrough}
              strikethrough
            >
              {tok.content}
            </Text>
          );
        case 'inline_code':
          return (
            <Text
              key={spanKey}
              color={parentColor || groupConfig.colors.code}
              bold
            >
              {tok.content}
            </Text>
          );
        case 'link': {
          const linkUrl = tok.url ?? '';
          const sanitizedUrl = sanitizeHyperlinkUrl(linkUrl);
          if (
            groupConfig.allowTerminalLinks &&
            supportsTerminalHyperlinks() &&
            sanitizedUrl
          ) {
            return (
              <Text
                key={spanKey}
                color={parentColor || groupConfig.colors.link}
              >
                {makeHyperlink(tok.content, sanitizedUrl)}
              </Text>
            );
          }
          return (
            <Text key={spanKey} color={parentColor || groupConfig.colors.link}>
              {tok.content}
              {linkUrl && linkUrl !== tok.content ? (
                <Text
                  color={parentColor || groupConfig.colors.link}
                >{` (${linkUrl})`}</Text>
              ) : null}
            </Text>
          );
        }
        case 'autolink': {
          const linkUrl = tok.url ?? '';
          const sanitizedUrl = sanitizeHyperlinkUrl(linkUrl);
          if (
            groupConfig.allowTerminalLinks &&
            supportsTerminalHyperlinks() &&
            sanitizedUrl
          ) {
            return (
              <Text
                key={spanKey}
                color={parentColor || groupConfig.colors.link}
              >
                {makeHyperlink(tok.content, sanitizedUrl)}
              </Text>
            );
          }
          return (
            <Text key={spanKey} color={parentColor || groupConfig.colors.link}>
              {linkUrl || tok.content}
            </Text>
          );
        }
        case 'text':
        default:
          return (
            <Text key={spanKey} color={parentColor}>
              {tok.content}
            </Text>
          );
      }
    });

    const line = (
      <Text key={`${keyBase}-text`} color={parentColor}>
        {spans}
      </Text>
    );
    if (groupConfig.maxWidth) {
      return (
        <Box key={`${keyBase}-box`} width={groupConfig.maxWidth}>
          {line}
        </Box>
      );
    }
    return line;
  };

  const elements: React.ReactNode[] = [];
  let lastWasBlank = false;
  const pushSpacer = (key: string) => {
    elements.push(<Text key={key}> </Text>);
    lastWasBlank = true;
  };
  const splitHeadInline = (itemTokens: MarkdownToken[]) => {
    const headInline: MarkdownToken[] = [];
    let idx = 0;
    while (idx < itemTokens.length && isInline(itemTokens[idx].type)) {
      headInline.push(itemTokens[idx]);
      idx += 1;
    }
    const tailBlocks = itemTokens.slice(idx);
    return { headInline, tailBlocks };
  };
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    const baseKey = `${token.type}-${i}`;

    if (isInline(token.type)) {
      const group: MarkdownToken[] = [token];
      let j = i + 1;
      while (j < tokens.length && isInline(tokens[j].type)) {
        group.push(tokens[j]);
        j++;
      }
      elements.push(renderInlineGroup(group, baseKey));
      lastWasBlank = false;
      i = j;
      continue;
    }

    switch (token.type) {
      case 'heading': {
        if (elements.length > 0 && !lastWasBlank) {
          pushSpacer(`${baseKey}-spacer-before`);
        }
        const headingElement = (
          <Text
            key={baseKey}
            bold
            color={parentColor || finalConfig.colors.heading}
          >
            {token.content}
          </Text>
        );
        elements.push(headingElement);
        lastWasBlank = false;
        const next = tokens[i + 1];
        if (
          next &&
          next.type !== 'line_break' &&
          next.type !== 'heading' &&
          next.type !== 'code_block' &&
          next.type !== 'unordered_list' &&
          next.type !== 'ordered_list' &&
          next.type !== 'task_list'
        ) {
          pushSpacer(`${baseKey}-spacer-after`);
        }
        i += 1;
        break;
      }

      case 'code_block': {
        if (elements.length > 0 && !lastWasBlank) {
          pushSpacer(`${baseKey}-spacer-before`);
        }

        const isMermaid = token.language?.toLowerCase() === 'mermaid';

        let codeBlockElement: React.ReactNode;

        if (isMermaid && finalConfig.allowMermaid) {
          codeBlockElement = (
            <MermaidCodeBlock
              key={baseKey}
              source={token.content}
              maxWidth={finalConfig.maxWidth}
              showCodeLanguage={finalConfig.showCodeLanguage}
            />
          );
        } else {
          codeBlockElement = (
            <Box
              key={baseKey}
              flexDirection="column"
              borderLeft
              borderColor={COLORS.text.muted}
              marginTop={0}
              marginBottom={0}
              width={finalConfig.maxWidth}
            >
              {finalConfig.showCodeLanguage && token.language ? (
                <Box>
                  <Text color={COLORS.text.muted} italic>
                    {token.language}
                  </Text>
                </Box>
              ) : null}
              <Box paddingLeft={2} width="100%">
                {renderCodeBlock(token.content, finalConfig, token.language)}
              </Box>
            </Box>
          );
        }

        elements.push(codeBlockElement);
        lastWasBlank = false;
        const next = tokens[i + 1];
        if (
          next &&
          next.type !== 'line_break' &&
          next.type !== 'heading' &&
          next.type !== 'code_block'
        ) {
          pushSpacer(`${baseKey}-spacer-after`);
        }
        i += 1;
        break;
      }

      case 'blockquote':
        elements.push(
          <Box
            key={baseKey}
            paddingLeft={1}
            borderLeft
            borderColor={finalConfig.colors.blockquote}
          >
            <Text color={finalConfig.colors.blockquote}>{token.content}</Text>
          </Box>
        );
        lastWasBlank = false;
        i += 1;
        break;

      case 'unordered_list':
        elements.push(
          <Box key={baseKey} flexDirection="column">
            {token.listItems?.map((itemTokens, _itemIndex) => {
              const listItemConfig = {
                ...finalConfig,
                maxWidth: finalConfig.maxWidth
                  ? Math.max(1, finalConfig.maxWidth - 4)
                  : undefined,
              };
              const listHeadConfig = {
                ...finalConfig,
                maxWidth: finalConfig.maxWidth
                  ? Math.max(1, finalConfig.maxWidth - 3)
                  : undefined,
              };
              const { headInline, tailBlocks } = splitHeadInline(itemTokens);
              return (
                <Box
                  key={generateStableKey(
                    itemTokens[0]?.content || '',
                    _itemIndex,
                    `${baseKey}-ul-item`
                  )}
                  flexDirection="column"
                >
                  <Box flexDirection="row" marginBottom={0}>
                    <Box minWidth={3} flexShrink={0}>
                      <Text color={parentColor}>• </Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      {headInline.length > 0
                        ? renderInlineGroup(
                            headInline,
                            `${baseKey}-ul-head-${_itemIndex}`,
                            listHeadConfig
                          )
                        : null}
                    </Box>
                  </Box>
                  {tailBlocks.length > 0 ? (
                    <Box paddingLeft={2}>
                      {renderMarkdown(tailBlocks, listItemConfig, parentColor)}
                    </Box>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        );
        lastWasBlank = false;
        i += 1;
        break;

      case 'ordered_list':
        elements.push(
          <Box key={baseKey} flexDirection="column">
            {token.listItems?.map((itemTokens, itemIndex) => {
              const listItemConfig = {
                ...finalConfig,
                maxWidth: finalConfig.maxWidth
                  ? Math.max(1, finalConfig.maxWidth - 4)
                  : undefined,
              };
              const listPrefix = `${
                (typeof token.start === 'number' ? token.start : 1) + itemIndex
              }. `;
              const listPrefixWidth = getDisplayWidth(listPrefix);
              const listHeadWidth = finalConfig.maxWidth
                ? finalConfig.maxWidth - listPrefixWidth
                : undefined;
              const listHeadConfig = {
                ...finalConfig,
                maxWidth:
                  listHeadWidth === undefined
                    ? undefined
                    : Math.max(1, listHeadWidth),
              };
              const { headInline, tailBlocks } = splitHeadInline(itemTokens);
              const renderHeadInline = (headConfig: MarkdownConfig) =>
                headInline.length > 0
                  ? renderInlineGroup(
                      headInline,
                      `${baseKey}-ol-head-${itemIndex}`,
                      headConfig
                    )
                  : null;

              if (finalConfig.maxWidth && (listHeadWidth ?? 0) <= 0) {
                return (
                  <Box
                    key={generateStableKey(
                      itemTokens[0]?.content || '',
                      itemIndex,
                      `${baseKey}-ol-item`
                    )}
                    flexDirection="column"
                  >
                    <Box width={finalConfig.maxWidth} flexDirection="column">
                      {wrapTextToWidth(
                        listPrefix.trimEnd(),
                        finalConfig.maxWidth
                      ).map((line, lineIndex) => (
                        <Text
                          key={`${baseKey}-ol-marker-${itemIndex}-${lineIndex}`}
                          color={parentColor}
                        >
                          {line}
                        </Text>
                      ))}
                    </Box>
                    {renderHeadInline({
                      ...finalConfig,
                      maxWidth: finalConfig.maxWidth,
                    })}
                    {tailBlocks.length > 0 ? (
                      <Box paddingLeft={2}>
                        {renderMarkdown(
                          tailBlocks,
                          listItemConfig,
                          parentColor
                        )}
                      </Box>
                    ) : null}
                  </Box>
                );
              }

              return (
                <Box
                  key={generateStableKey(
                    itemTokens[0]?.content || '',
                    itemIndex,
                    `${baseKey}-ol-item`
                  )}
                  flexDirection="column"
                >
                  <Box flexDirection="row" marginBottom={0}>
                    <Box minWidth={3} flexShrink={0}>
                      <Text color={parentColor}>{listPrefix}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      {renderHeadInline(listHeadConfig)}
                    </Box>
                  </Box>
                  {tailBlocks.length > 0 ? (
                    <Box paddingLeft={2}>
                      {renderMarkdown(tailBlocks, listItemConfig, parentColor)}
                    </Box>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        );
        lastWasBlank = false;
        i += 1;
        break;

      case 'task_list':
        elements.push(
          <Box key={baseKey} flexDirection="column">
            {token.listItems?.map((itemTokens, _itemIndex) => {
              const taskToken = itemTokens[0];
              const isChecked = taskToken?.checked || false;
              const taskHeadConfig = {
                ...finalConfig,
                maxWidth: finalConfig.maxWidth
                  ? Math.max(1, finalConfig.maxWidth - 4)
                  : undefined,
              };
              const taskTailConfig = {
                ...finalConfig,
                maxWidth: finalConfig.maxWidth
                  ? Math.max(1, finalConfig.maxWidth - 2)
                  : undefined,
              };
              const { headInline, tailBlocks } = splitHeadInline(itemTokens);
              return (
                <Box
                  key={generateStableKey(
                    taskToken?.content || '',
                    _itemIndex,
                    `${baseKey}-task-${isChecked ? 'checked' : 'unchecked'}`
                  )}
                  flexDirection="column"
                >
                  <Box flexDirection="row">
                    <Text color={parentColor}>
                      {isChecked ? '[x]' : '[ ]'}{' '}
                    </Text>
                    <Box>
                      {headInline.length > 0
                        ? renderInlineGroup(
                            headInline,
                            `${baseKey}-task-head-${_itemIndex}`,
                            taskHeadConfig
                          )
                        : null}
                    </Box>
                  </Box>
                  {tailBlocks.length > 0 ? (
                    <Box paddingLeft={2}>
                      {renderMarkdown(tailBlocks, taskTailConfig, parentColor)}
                    </Box>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        );
        lastWasBlank = false;
        i += 1;
        break;

      case 'table': {
        if (!token.table) {
          i += 1;
          break;
        }

        if (elements.length > 0 && !lastWasBlank) {
          pushSpacer(`${baseKey}-spacer-before`);
        }

        const { headers, alignments, rows } = token.table;
        const numCols = headers.length;

        if (numCols === 0) {
          i += 1;
          break;
        }

        const terminalWidth = Math.max(
          1,
          Math.floor(finalConfig.maxWidth ?? 100)
        );
        const separatorText =
          terminalWidth >= numCols + (numCols - 1) * 3 ? ' │ ' : ' ';
        const separatorWidth =
          Math.max(0, numCols - 1) * getDisplayWidth(separatorText);
        const availableWidth = Math.max(1, terminalWidth - separatorWidth);

        const idealWidths = headers.map((header, colIdx) => {
          let maxWidth = getDisplayWidth(header);
          for (const row of rows) {
            const cellWidth = getDisplayWidth(row[colIdx] || '');
            if (cellWidth > maxWidth) {
              maxWidth = cellWidth;
            }
          }
          return maxWidth;
        });
        const minimumRenderableWidths = headers.map((header, colIdx) => {
          let minWidth = getMinimumRenderableWidth(header);
          for (const row of rows) {
            minWidth = Math.max(
              minWidth,
              getMinimumRenderableWidth(row[colIdx] || '')
            );
          }
          return minWidth;
        });

        const totalIdealWidth = idealWidths.reduce((sum, w) => sum + w, 0);

        let colWidths: number[];
        if (totalIdealWidth <= availableWidth) {
          colWidths = idealWidths;
        } else {
          const baseWidth = availableWidth >= numCols ? 1 : 0;
          const minimumTotalWidth = baseWidth * numCols;
          const remainingWidth = Math.max(
            0,
            availableWidth - minimumTotalWidth
          );
          const extraIdealWidths = idealWidths.map((width) =>
            Math.max(0, width - baseWidth)
          );
          const totalExtraIdealWidth = extraIdealWidths.reduce(
            (sum, width) => sum + width,
            0
          );

          colWidths = idealWidths.map((_ideal, index) => {
            if (baseWidth === 0) {
              return index === 0 ? availableWidth : 0;
            }

            if (totalExtraIdealWidth === 0) {
              return baseWidth;
            }

            return (
              baseWidth +
              Math.floor(
                (extraIdealWidths[index] / totalExtraIdealWidth) *
                  remainingWidth
              )
            );
          });

          let assignedWidth = colWidths.reduce((sum, width) => sum + width, 0);
          while (assignedWidth < availableWidth) {
            let targetIndex = -1;
            let largestDeficit = Number.NEGATIVE_INFINITY;
            for (let colIdx = 0; colIdx < idealWidths.length; colIdx++) {
              const deficit = idealWidths[colIdx] - colWidths[colIdx];
              if (deficit > largestDeficit) {
                targetIndex = colIdx;
                largestDeficit = deficit;
              }
            }

            if (targetIndex < 0) {
              break;
            }

            colWidths[targetIndex]++;
            assignedWidth++;
          }
        }

        const getVisibleTableWidth = (widths: number[]): number => {
          const visibleCount = widths.filter((width) => width > 0).length;
          const visibleWidth = widths.reduce((sum, width) => sum + width, 0);
          return (
            visibleWidth +
            Math.max(0, visibleCount - 1) * getDisplayWidth(separatorText)
          );
        };

        colWidths = colWidths.map((width, index) =>
          width > 0 ? Math.max(width, minimumRenderableWidths[index]) : 0
        );

        while (getVisibleTableWidth(colWidths) > terminalWidth) {
          let columnToHide = -1;
          for (let colIdx = colWidths.length - 1; colIdx >= 0; colIdx--) {
            if (colWidths[colIdx] > 0) {
              columnToHide = colIdx;
              break;
            }
          }

          if (columnToHide === -1) {
            break;
          }

          colWidths[columnToHide] = 0;
        }

        const joinVisibleParts = (parts: string[]): string =>
          parts
            .filter((_part, index) => colWidths[index] > 0)
            .join(separatorText);

        const padText = (
          text: string,
          width: number,
          alignment: 'left' | 'center' | 'right' | null
        ): string => {
          const textWidth = getDisplayWidth(text);
          const padding = width - textWidth;
          if (padding <= 0) return text;

          if (alignment === 'right') {
            return ' '.repeat(padding) + text;
          }
          if (alignment === 'center') {
            const leftPad = Math.floor(padding / 2);
            const rightPad = padding - leftPad;
            return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
          }
          return text + ' '.repeat(padding);
        };

        const renderWrappedCell = (
          content: string,
          colIdx: number
        ): string[] => {
          const width = colWidths[colIdx];
          if (width <= 0) {
            return [];
          }
          const wrapped = wrapTextToWidth(content, width);
          return wrapped.map((line) =>
            padText(line, width, alignments[colIdx])
          );
        };

        const headerLines = headers.map((header, idx) =>
          renderWrappedCell(header, idx)
        );

        if (headerLines.length === 0) {
          i += 1;
          break;
        }

        const headerHeight = Math.max(
          ...headerLines.map((lines) => lines.length)
        );

        const headerRows: React.ReactNode[] = [];
        for (let lineIdx = 0; lineIdx < headerHeight; lineIdx++) {
          const lineParts = headerLines.map((lines, colIdx) =>
            colWidths[colIdx] > 0
              ? lines[lineIdx] || ' '.repeat(colWidths[colIdx])
              : ''
          );
          headerRows.push(
            <Text
              key={`${baseKey}-header-${lineIdx}`}
              bold
              color={COLORS.text.info}
            >
              {joinVisibleParts(lineParts)}
            </Text>
          );
        }

        const separatorParts = colWidths.map((width, idx) => {
          if (width <= 0) {
            return '';
          }
          const align = alignments[idx];
          if (align === 'center') {
            if (width <= 2) {
              return '-'.repeat(width);
            }
            return `:${'-'.repeat(width - 2)}:`;
          }
          if (align === 'right') {
            if (width <= 1) {
              return '-'.repeat(width);
            }
            return `${'-'.repeat(width - 1)}:`;
          }
          if (align === 'left') {
            if (width <= 1) {
              return '-'.repeat(width);
            }
            return `:${'-'.repeat(width - 1)}`;
          }
          return '-'.repeat(width);
        });
        const separator = (
          <Text key={`${baseKey}-separator`} color={COLORS.text.muted}>
            {separatorParts
              .filter((_part, index) => colWidths[index] > 0)
              .join(separatorText.replaceAll(' ', '-'))}
          </Text>
        );

        const dataRowElements: React.ReactNode[] = [];
        rows.forEach((row, rowIdx) => {
          const cellLines = row.map((cell, colIdx) =>
            renderWrappedCell(cell || '', colIdx)
          );

          const rowHeight =
            cellLines.length > 0
              ? Math.max(...cellLines.map((lines) => lines.length))
              : 1;

          for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) {
            const lineParts = cellLines.map((lines, colIdx) =>
              colWidths[colIdx] > 0
                ? lines[lineIdx] || ' '.repeat(colWidths[colIdx])
                : ''
            );
            dataRowElements.push(
              <Text key={`${baseKey}-row-${rowIdx}-line-${lineIdx}`}>
                {joinVisibleParts(lineParts)}
              </Text>
            );
          }
        });

        elements.push(
          <Box key={baseKey} flexDirection="column">
            {headerRows}
            {separator}
            {dataRowElements}
          </Box>
        );

        lastWasBlank = false;

        const next = tokens[i + 1];
        if (next && next.type !== 'line_break') {
          pushSpacer(`${baseKey}-spacer-after`);
        }

        i += 1;
        break;
      }

      case 'horizontal_rule':
        elements.push(
          <Text key={baseKey} color={COLORS.text.muted}>
            {'─'.repeat(Math.max(1, finalConfig.maxWidth ?? 42))}
          </Text>
        );
        lastWasBlank = false;
        i += 1;
        break;

      case 'line_break':
        if (token.content === '') {
          pushSpacer(baseKey);
        } else {
          lastWasBlank = false;
        }
        i += 1;
        break;

      default:
        elements.push(renderInlineGroup([token], baseKey));
        lastWasBlank = false;
        i += 1;
        break;
    }
  }
  return elements;
}
