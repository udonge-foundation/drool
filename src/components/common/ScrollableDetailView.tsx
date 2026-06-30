import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import type { DetailLine } from '@/components/common/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

interface ScrollableDetailViewProps {
  lines: DetailLine[];
  viewportHeight: number;
  isActive?: boolean;
}

/**
 * Renders a list of pre-wrapped styled lines inside a fixed-height viewport
 * with arrow/page key scrolling. Used for read-only detail panes (e.g. the
 * skills/drools preview) where content can exceed the visible area but the
 * terminal's native scrollback is unreachable while Ink owns stdin.
 *
 * The parent is expected to remount this component when the underlying
 * source object changes (e.g. by passing a stable `key`) so the scroll
 * offset resets to the top automatically.
 */
export function ScrollableDetailView({
  lines,
  viewportHeight,
  isActive = true,
}: ScrollableDetailViewProps) {
  const [scrollOffset, setScrollOffset] = useState(0);

  const safeViewport = Math.max(1, viewportHeight);
  const maxOffset = Math.max(0, lines.length - safeViewport);

  // Clamp offset whenever the underlying content shrinks.
  useEffect(() => {
    setScrollOffset((prev) => Math.min(prev, maxOffset));
  }, [maxOffset]);

  useKeypressHandler(
    (_input, key) => {
      if (key.upArrow) {
        setScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
        return;
      }
      if (key.pageUp) {
        setScrollOffset((prev) => Math.max(0, prev - safeViewport));
        return;
      }
      if (key.pageDown) {
        setScrollOffset((prev) => Math.min(maxOffset, prev + safeViewport));
        return;
      }
      if (key.home) {
        setScrollOffset(0);
        return;
      }
      if (key.end) {
        setScrollOffset(maxOffset);
      }
    },
    { isActive }
  );

  const startIndex = Math.min(scrollOffset, maxOffset);
  const visible = lines.slice(startIndex, startIndex + safeViewport);

  return (
    <Box flexDirection="column" height={safeViewport}>
      {visible.map((line, i) => {
        // Defensive scrub: a stray \r inside `line.text` would be written to
        // stdout as a literal carriage return, sending the cursor back to
        // column 0 and letting the next rendered line clobber this one
        // (observed on Windows when source files have CRLF endings). We also
        // strip other C0 control bytes (except tab, which Ink handles).
        // eslint-disable-next-line no-control-regex
        const text = line.text.replace(/[\x00-\x08\x0b-\x1f]/g, '');
        return (
          <Text
            key={`detail-line-${startIndex + i}`}
            color={line.color}
            bold={line.bold}
          >
            {text.length === 0 ? ' ' : text}
          </Text>
        );
      })}
    </Box>
  );
}
