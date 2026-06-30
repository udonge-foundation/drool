import { Box } from 'ink';
import { useMemo } from 'react';

import { parseJsonRenderTags, SEGMENT_TYPE } from '@industry/utils/jsonRender';

import { JsonRenderBlock } from '@/components/JsonRenderBlock';
import { MarkdownText } from '@/components/MarkdownText';

interface JsonRenderContentProps {
  children: string;
  color?: string;
  maxWidth?: number;
}

/**
 * Renders assistant message content that may contain <json-render> tags
 * interleaved with markdown text.
 */
export function JsonRenderContent({
  children,
  color,
  maxWidth,
}: JsonRenderContentProps) {
  const segments = useMemo(() => {
    const raw = parseJsonRenderTags(children);
    return raw.map((seg, i) => {
      if (seg.type !== SEGMENT_TYPE.TEXT) return seg;
      let text = seg.content;
      // Trim excess blank lines adjacent to json-render blocks
      if (i > 0) text = text.replace(/^\n{2,}/, '\n');
      if (i < raw.length - 1) text = text.replace(/\n{2,}$/, '\n');
      return { ...seg, content: text };
    });
  }, [children]);

  return (
    <Box flexDirection="column">
      {segments.map((segment, index) => {
        if (segment.type === SEGMENT_TYPE.TEXT) {
          return (
            <MarkdownText
              key={`text-${index}`}
              color={color}
              maxWidth={maxWidth}
            >
              {segment.content}
            </MarkdownText>
          );
        }
        if (segment.type === SEGMENT_TYPE.JSON_RENDER_ERROR) {
          return null;
        }
        return (
          <JsonRenderBlock
            key={`chart-${index}`}
            spec={segment.spec}
            maxWidth={maxWidth}
          />
        );
      })}
    </Box>
  );
}
