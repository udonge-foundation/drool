import { Text, Box } from 'ink';
import { useEffect, useMemo, useState } from 'react';

import { COLORS } from '@/components/chat/themedColors';
import type { ToolHeaderBadge } from '@/components/tools/registry/types';
import { useIsFastMode } from '@/utils/isFastMode';
import { getDisplayNameForTool } from '@/utils/tool-display';
import type { HeaderLabelPart } from '@/utils/types';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}

function lerpColor(
  base: [number, number, number],
  target: [number, number, number],
  t: number
): string {
  return rgbToHex(
    base[0] + (target[0] - base[0]) * t,
    base[1] + (target[1] - base[1]) * t,
    base[2] + (target[2] - base[2]) * t
  );
}

const SHIMMER_CYCLE_STEPS = 20;

const shimmerClock = {
  tick: 0,
  listeners: new Set<() => void>(),
  interval: undefined as ReturnType<typeof setInterval> | undefined,
  subscribe(cb: () => void) {
    this.listeners.add(cb);
    if (!this.interval) {
      this.interval = setInterval(() => {
        this.tick++;
        for (const fn of this.listeners) fn();
      }, 50);
    }
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0 && this.interval) {
        clearInterval(this.interval);
        this.interval = undefined;
      }
    };
  },
};

function useShimmer(text: string, baseColor: string, active: boolean) {
  const [tick, setTick] = useState(shimmerClock.tick);
  const fast = useIsFastMode();

  useEffect(() => {
    if (!active) return;
    return shimmerClock.subscribe(() => setTick(shimmerClock.tick));
  }, [active]);

  const base = useMemo(() => hexToRgb(baseColor), [baseColor]);
  const highlight: [number, number, number] = [230, 230, 230];
  const len = text.length;
  const shimmerWidth = Math.max(3, Math.floor(len * 0.6));

  const chars = useMemo(() => {
    const cycleSteps = fast ? SHIMMER_CYCLE_STEPS / 2 : SHIMMER_CYCLE_STEPS;
    const phase = (tick % cycleSteps) / cycleSteps;
    const totalSpan = len + shimmerWidth;
    const center = phase * totalSpan - shimmerWidth / 2;

    return text.split('').map((char, i) => {
      const dist = Math.abs(i - center);
      const t =
        dist < shimmerWidth / 2
          ? Math.cos((dist / (shimmerWidth / 2)) * (Math.PI / 2)) * 0.7
          : 0;
      return { char, color: lerpColor(base, highlight, t) };
    });
  }, [text, tick, base, len, shimmerWidth, fast]);

  return chars;
}

interface ToolHeaderProps {
  toolName: string;
  headerLabel?: string;
  headerParts?: HeaderLabelPart[];
  overflowText?: string;
  badge?: ToolHeaderBadge;
  isPending?: boolean;
  /** Available width (columns) for the header row */
  contentWidth?: number;
  nameColor?: string;
  paramColor?: string;
  pendingBaseColor?: string;
}

export function ToolHeader({
  toolName,
  headerLabel,
  headerParts,
  overflowText,
  badge,
  isPending = true,
  contentWidth,
  nameColor,
  paramColor,
  pendingBaseColor,
}: ToolHeaderProps) {
  const headerWidth = contentWidth ?? 80;

  const displayName = useMemo(
    () => badge?.text ?? getDisplayNameForTool(toolName),
    [toolName, badge]
  );

  const TOOL_NAME_COLOR = nameColor ?? COLORS.toolName;
  const TOOL_COLOR = paramColor ?? COLORS.toolParam;

  const renderHeader = () => {
    // If headerParts provided, render with mixed styling
    if (headerParts && headerParts.length > 0) {
      const normalParts = headerParts.filter((p) => !p.rightAligned);
      return (
        <Box marginLeft={1} flexShrink={1} flexDirection="row">
          {normalParts.map((part, index) => (
            <Text
              key={index}
              wrap="wrap"
              color={
                part.highlighted
                  ? undefined
                  : (part.color ??
                    (part.muted ? COLORS.text.muted : TOOL_COLOR))
              }
            >
              {part.text}
              {index < normalParts.length - 1 ? ', ' : ''}
            </Text>
          ))}
        </Box>
      );
    }

    // Fall back to simple string label
    if (headerLabel && headerLabel.length > 0) {
      return (
        <Box marginLeft={1} flexShrink={1} flexDirection="row">
          <Text wrap="wrap" color={TOOL_COLOR}>
            {headerLabel}
          </Text>
        </Box>
      );
    }

    return null;
  };

  const isMcpTool = toolName.includes('___');
  const mcpParts = useMemo(() => {
    if (!isMcpTool) return null;
    const colonIdx = displayName.indexOf(': ');
    if (colonIdx === -1) return null;
    return {
      serverName: displayName.slice(0, colonIdx + 2),
      toolPart: displayName.slice(colonIdx + 2),
    };
  }, [isMcpTool, displayName]);

  const shimmerText = mcpParts ? mcpParts.toolPart : displayName;
  const shimmerChars = useShimmer(
    shimmerText,
    pendingBaseColor ?? COLORS.text.muted,
    isPending
  );

  const rightAlignedParts = headerParts?.filter((p) => p.rightAligned);
  const hasRightAligned = rightAlignedParts && rightAlignedParts.length > 0;

  return (
    <Box flexDirection="row" width={headerWidth}>
      <Box flexShrink={1} flexDirection="row">
        <Box flexShrink={0}>
          {isPending ? (
            mcpParts ? (
              <Text bold>
                <Text color={TOOL_NAME_COLOR}>{mcpParts.serverName}</Text>
                {shimmerChars.map(({ char, color }, i) => (
                  <Text key={i} color={color}>
                    {char}
                  </Text>
                ))}
              </Text>
            ) : (
              <Text bold>
                {shimmerChars.map(({ char, color }, i) => (
                  <Text key={i} color={color}>
                    {char}
                  </Text>
                ))}
              </Text>
            )
          ) : (
            <Text color={TOOL_NAME_COLOR} wrap="wrap" bold>
              {displayName}
            </Text>
          )}
        </Box>
        {renderHeader()}
        {overflowText && (
          <Box marginLeft={3} flexShrink={0}>
            <Text color={COLORS.text.muted}>{overflowText}</Text>
          </Box>
        )}
      </Box>
      {hasRightAligned && (
        <>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            {rightAlignedParts.map((p, i) => (
              <Text
                key={i}
                color={p.color ?? COLORS.text.muted}
                wrap="truncate-end"
              >
                {i > 0 ? ' ' : ''}
                {p.text}{' '}
              </Text>
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}
