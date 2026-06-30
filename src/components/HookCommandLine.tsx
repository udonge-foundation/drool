import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import {
  EXECUTE_HEADER_NAME,
  HOOK_LEFT_MARGIN,
} from '@/components/hooks/constants';
import { ExecuteTool } from '@/components/tools/implementations/ExecuteTool';
import { ToolHeaderRenderMode } from '@/components/tools/registry/enums';
import { HookEventName } from '@/hooks/enums';
import type { HeaderLabelPart } from '@/utils/types';

import type React from 'react';

export function getHookHeaderWidth(contentWidth?: number): number | undefined {
  return contentWidth
    ? Math.max(20, contentWidth - HOOK_LEFT_MARGIN)
    : undefined;
}

function renderHookHeaderParts(parts: HeaderLabelPart[]): React.ReactNode {
  const normalParts = parts.filter((part) => !part.rightAligned);
  return normalParts.map((part, index) => (
    <Text
      key={`${index}-${part.text}`}
      wrap="wrap"
      color={
        part.highlighted
          ? undefined
          : (part.color ?? (part.muted ? COLORS.text.muted : COLORS.toolParam))
      }
    >
      {part.text}
      {index < normalParts.length - 1 ? ', ' : ''}
    </Text>
  ));
}

export function HookCommandLine({
  command,
  prefix,
  contentWidth,
}: {
  command: string;
  prefix: string;
  contentWidth?: number;
}) {
  const commandWidth = contentWidth
    ? Math.max(20, contentWidth - HOOK_LEFT_MARGIN - prefix.length - 9)
    : undefined;
  const commandParts =
    ExecuteTool.getHeaderParts?.(
      { command },
      commandWidth,
      ToolHeaderRenderMode.Standard
    ) ?? [];

  return (
    <Box flexDirection="row">
      <Text dimColor>{prefix} </Text>
      <Text color={COLORS.toolName} bold>
        {EXECUTE_HEADER_NAME}
      </Text>
      {commandParts.length > 0 && (
        <Box marginLeft={1} flexShrink={1} flexDirection="row">
          {renderHookHeaderParts(commandParts)}
        </Box>
      )}
    </Box>
  );
}

export function getHookContextLabel(
  hookEventName: HookEventName,
  hookMatcher?: string
): string {
  const matcherLabel =
    hookMatcher && hookMatcher !== '*' && hookMatcher !== ''
      ? ` → ${hookMatcher}`
      : '';
  return `${hookEventName}${matcherLabel}`;
}
