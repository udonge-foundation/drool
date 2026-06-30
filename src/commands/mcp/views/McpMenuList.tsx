import { Box, Text } from 'ink';

import type { McpMenuListProps } from '@/commands/mcp/views/types';
import { COLORS } from '@/components/chat/themedColors';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';

const DEFAULT_VISIBLE_COUNT = 10;

export function McpMenuList({
  title,
  helpText,
  items,
  selectedIndex,
  visibleCount = DEFAULT_VISIBLE_COUNT,
  children,
  footer,
  minContentHeight,
}: McpMenuListProps) {
  const { width: terminalWidth } = useTerminalDimensions();
  const clampedSelectedIndex =
    items.length > 0
      ? Math.max(0, Math.min(selectedIndex, items.length - 1))
      : 0;
  const { windowStart, visibleItems } = getWindowedListSlice({
    items,
    selectedIndex,
    visibleCount,
    anchorRow: 3,
  });

  const pagination =
    items.length > visibleCount
      ? {
          current: windowStart,
          total: items.length,
          visibleCount: visibleItems.length,
        }
      : undefined;

  return (
    <MenuContainer
      title={title}
      titleBold={false}
      width={terminalWidth}
      helpText={helpText}
      showDefaultHelp={false}
      pagination={pagination}
      minContentHeight={minContentHeight}
    >
      {children}
      <Box flexDirection="column">
        {visibleItems.map((item, index) => {
          const globalIndex = windowStart + index;
          const isSelected = globalIndex === clampedSelectedIndex;
          const labelColor = isSelected
            ? COLORS.text.primary
            : item.dimmed
              ? COLORS.text.muted
              : (item.labelColor ?? COLORS.text.muted);
          const suffixColor = isSelected
            ? COLORS.text.primary
            : item.dimmed
              ? COLORS.text.muted
              : (item.suffixColor ?? COLORS.text.secondary);

          return (
            <Box key={item.key} marginTop={item.marginTop}>
              <Box width={2}>
                <Text> </Text>
              </Box>
              <Text bold={isSelected} color={labelColor}>
                {item.label}
              </Text>
              {item.suffix ? (
                <Text bold={isSelected} color={suffixColor}>
                  {item.suffix}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {footer}
    </MenuContainer>
  );
}
