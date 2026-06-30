import { Box, Text } from 'ink';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { StyledHelpText } from '@/components/common/StyledHelpText';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';

interface MenuPagination {
  current: number;
  total: number;
  visibleCount: number;
}

interface MenuContainerProps {
  title?: string;
  titleBold?: boolean;
  titleColor?: string;
  children: ReactNode;
  helpText?: string;
  helpRight?: string;
  showDefaultHelp?: boolean;
  width?: number;
  minWidth?: number;
  marginTop?: number;
  paddingX?: number;
  paddingY?: number;
  pagination?: MenuPagination;
  headerRight?: ReactNode;
  headerTabs?: ReactNode;
  minContentHeight?: number;
}

/**
 * Standardized wrapper for CLI menu components.
 */
export function MenuContainer({
  title,
  titleBold = true,
  titleColor,
  children,
  helpText,
  helpRight,
  showDefaultHelp = true,
  width,
  minWidth = 78,
  marginTop = 1,
  paddingX = 1,
  paddingY = 0,
  pagination,
  headerRight,
  headerTabs,
  minContentHeight,
}: MenuContainerProps) {
  const { t } = useTranslation();
  const { width: terminalWidth } = useTerminalDimensions();

  const resolvedWidth =
    width && width > terminalWidth ? terminalWidth - 2 : width;

  const resolvedMinWidth = minWidth
    ? Math.min(minWidth, terminalWidth - 2)
    : undefined;

  const finalHelpText =
    helpText ??
    (showDefaultHelp ? t('common:menuContainer.defaultHelpText') : undefined);

  return (
    <Box flexDirection="column" marginTop={marginTop}>
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={paddingX}
        paddingY={paddingY}
        width={resolvedWidth}
        minWidth={resolvedMinWidth}
      >
        <Box flexDirection="column" width="100%">
          {/* Header with optional tabs below title */}
          {(title || headerRight || headerTabs) && (
            <Box flexDirection="column" marginBottom={1}>
              {title && (
                <Text
                  bold={titleBold}
                  color={titleColor ?? COLORS.text.menuTitle}
                >
                  {title}
                </Text>
              )}
              {headerTabs && <Box marginTop={title ? 1 : 0}>{headerTabs}</Box>}
              {headerRight && (
                <Box marginTop={title || headerTabs ? 1 : 0}>{headerRight}</Box>
              )}
            </Box>
          )}

          {/* Main menu content */}
          <Box flexDirection="column" minHeight={minContentHeight}>
            {children}
          </Box>
        </Box>
      </Box>

      {/* Help text + pagination info below menu */}
      {(finalHelpText || pagination || helpRight) && (
        <Box
          marginLeft={2}
          marginTop={0}
          justifyContent="space-between"
          width={(resolvedWidth ?? terminalWidth) - 4}
        >
          <Box>
            {finalHelpText && <StyledHelpText text={finalHelpText} />}
            {pagination && (
              <Text color={COLORS.text.muted}>
                {finalHelpText && ' • '}
                {t('common:menuContainer.paginationInfo', {
                  start: pagination.current + 1,
                  end: Math.min(
                    pagination.current + pagination.visibleCount,
                    pagination.total
                  ),
                  total: pagination.total,
                })}
              </Text>
            )}
          </Box>
          {helpRight && <Text color={COLORS.text.helpLabel}>{helpRight}</Text>}
        </Box>
      )}
    </Box>
  );
}
