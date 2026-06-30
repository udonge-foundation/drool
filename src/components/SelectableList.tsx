import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import type { SelectableListProps } from '@/components/types';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';

const DEFAULT_VISIBLE_COUNT = 6;

export function SelectableList({
  items,
  selectedIndex,
  helpText,
  width,
  minWidth = 78,
  marginTop = 1,
  fullWidth = false,
  children,
  minVisibleCount,
  visibleCount,
  noBorder = false,
}: SelectableListProps) {
  const { t } = useTranslation();
  const { width: terminalWidth } = useTerminalDimensions();
  const resolvedWidth = fullWidth
    ? terminalWidth
    : width
      ? Math.min(width, terminalWidth)
      : undefined;
  const resolvedMinWidth = Math.min(minWidth, terminalWidth);
  const effectiveVisibleCount = visibleCount ?? DEFAULT_VISIBLE_COUNT;

  // Compute windowStart synchronously during render (no useEffect)
  // to avoid a flash where the selection appears on the wrong row.
  const anchorRow = 3;
  const computeWindowStart = () => {
    if (selectedIndex < 0 || selectedIndex >= items.length) return 0;
    const idealStart = selectedIndex - anchorRow;
    const maxStart = Math.max(0, items.length - effectiveVisibleCount);
    return Math.max(0, Math.min(idealStart, maxStart));
  };
  const windowStart = computeWindowStart();

  // Calculate visible slice
  const visibleSlice = items.slice(
    windowStart,
    windowStart + effectiveVisibleCount
  );
  const showPagination = items.length > effectiveVisibleCount;

  return (
    <Box
      flexDirection="column"
      width={resolvedWidth}
      minWidth={resolvedMinWidth}
      marginTop={marginTop}
    >
      <Box
        borderStyle={noBorder ? undefined : 'round'}
        borderColor={noBorder ? undefined : COLORS.border}
        paddingX={noBorder ? 0 : 1}
        marginLeft={noBorder ? 2 : 0}
      >
        <Box flexDirection="column">
          {children}
          {visibleSlice.map((item, index) => {
            const globalIndex = windowStart + index;
            const isSelected = globalIndex === selectedIndex;
            const getColor = (overrideDefault?: string) => {
              if (isSelected) {
                return item.selectedColor ?? COLORS.primary;
              }
              if (item.dimmed) {
                return COLORS.text.muted;
              }
              return overrideDefault ?? item.defaultColor;
            };
            return (
              <Text key={`item-${item.value}`} bold={isSelected}>
                <Text color={getColor()}>
                  {isSelected ? (item.selectedPrefix ?? '> ') : '  '}
                </Text>
                {/* Use structured fileDisplay if available, otherwise fall back to label parsing */}
                {item.fileDisplay ? (
                  <>
                    {/* Filename part - use selected color or default */}
                    <Text color={getColor()}>{item.fileDisplay.filename}</Text>
                    {/* Path part if present */}
                    {item.fileDisplay.path && (
                      <>
                        {/* Separator */}
                        <Text color={getColor(COLORS.text.muted)}>{'  '}</Text>
                        {/* Path - use muted color when not selected */}
                        <Text color={getColor(COLORS.text.muted)}>
                          {item.fileDisplay.path}
                        </Text>
                      </>
                    )}
                  </>
                ) : item.label.includes('  ') ? (
                  <>
                    {/* Legacy: Filename part - use selected color or default */}
                    <Text color={getColor()}>
                      {item.label.substring(0, item.label.indexOf('  '))}
                    </Text>
                    {/* Separator */}
                    <Text color={getColor(COLORS.text.muted)}>{'  '}</Text>
                    {/* Path part - use muted color when not selected */}
                    <Text color={getColor(COLORS.text.muted)}>
                      {item.label.substring(item.label.indexOf('  ') + 2)}
                    </Text>
                  </>
                ) : (
                  /* No path separator - render label normally */
                  <Text color={getColor()}>{item.label}</Text>
                )}
                {/* Suffix if any */}
                <Text color={getColor(item.suffixColor)}>
                  {item.suffix || ''}
                </Text>
              </Text>
            );
          })}
          {minVisibleCount &&
            visibleSlice.length < minVisibleCount &&
            Array.from(
              { length: minVisibleCount - visibleSlice.length },
              (_, i) => <Text key={`pad-${i}`}> </Text>
            )}
        </Box>
      </Box>
      {helpText && (
        <Box marginLeft={3}>
          <Text color={COLORS.text.muted}>
            {helpText}
            {showPagination &&
              ` • ${t('common:selectableList.showing', { start: windowStart + 1, end: Math.min(windowStart + effectiveVisibleCount, items.length), total: items.length })}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
