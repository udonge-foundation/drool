import { Box, Text } from 'ink';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';

import { getSettingsService } from '@/services/SettingsService';
import { getStatusLineService } from '@/services/StatusLineService';
import type { PrState } from '@/services/types';
import {
  renderTerminalLine,
  sanitizeTerminalText,
  textSegment,
  wrapTerminalText,
} from '@/utils/terminalSegments';
import { TerminalTruncationPosition } from '@/utils/terminalSegments/enums';

interface StatusLineProps {
  sessionId: string | null;
  modelId: string;
  reasoningEffort: string;
  width: number;
  lastTokenUsage: number | null;
  prState: PrState;
}

function wrapStatusLineText(
  text: string,
  width: number,
  maxRows: number
): string[] {
  const rows: string[] = [];
  const rawLines = text.split(/\r\n|\n|\r/);

  for (const rawLine of rawLines) {
    if (rows.length >= maxRows) break;

    rows.push(
      ...wrapTerminalText(
        sanitizeTerminalText(rawLine, { preserveSgr: true }),
        width,
        maxRows - rows.length
      )
    );
  }

  return rows.slice(0, maxRows);
}

export function StatusLine({
  sessionId,
  modelId,
  reasoningEffort,
  width,
  lastTokenUsage,
  prState,
}: StatusLineProps) {
  const [statusText, setStatusText] = useState<string | null>(null);
  const [hasConfig, setHasConfig] = useState<boolean>(false);
  const configCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const normalizedLastTokenUsage =
    lastTokenUsage !== null && lastTokenUsage > 0 ? lastTokenUsage : null;
  const runtimeSnapshot = useMemo(
    () => ({ lastTokenUsage: normalizedLastTokenUsage, prState }),
    [
      normalizedLastTokenUsage,
      prState.status,
      prState.prUrl,
      prState.prNumber,
      prState.provider,
      prState.additions,
      prState.deletions,
    ]
  );
  const snapshotRef = useRef(runtimeSnapshot);
  snapshotRef.current = runtimeSnapshot;

  const checkAndUpdate = useCallback(async () => {
    const config = getSettingsService().getStatusLine();
    setHasConfig(!!config);

    if (!config) {
      setStatusText(null);
      return;
    }

    const result = await getStatusLineService().execute(snapshotRef.current);
    setStatusText(result);
  }, []);

  // Update on mount and when dependencies change
  useEffect(() => {
    void checkAndUpdate();
  }, [checkAndUpdate, sessionId, modelId, reasoningEffort, runtimeSnapshot]);

  // Periodically check for config changes (e.g., after /statusline completes)
  useEffect(() => {
    configCheckIntervalRef.current = setInterval(() => {
      const config = getSettingsService().getStatusLine();
      if (!!config !== hasConfig) {
        void checkAndUpdate();
      }
    }, 1000);

    return () => {
      if (configCheckIntervalRef.current) {
        clearInterval(configCheckIntervalRef.current);
      }
    };
  }, [hasConfig, checkAndUpdate]);

  // Don't render anything if no config or no output
  if (!hasConfig || !statusText) {
    return null;
  }

  const config = getSettingsService().getStatusLine();
  const boundedWidth = Math.max(1, Math.floor(width));
  const requestedPadding = Math.max(0, Math.floor(config?.padding ?? 0));
  const horizontalPadding = Math.min(
    requestedPadding,
    Math.max(0, Math.floor((boundedWidth - 1) / 2))
  );
  const maxRows = Math.min(3, Math.max(1, Math.floor(config?.maxRows ?? 1)));
  const contentWidth = Math.max(1, boundedWidth - horizontalPadding * 2);
  const statusLines = wrapStatusLineText(statusText, contentWidth, maxRows);

  return (
    <Box flexDirection="column">
      {statusLines.map((line, index) => (
        <Box
          key={`statusline-${index}`}
          width={boundedWidth}
          paddingLeft={horizontalPadding}
          paddingRight={horizontalPadding}
        >
          <Text>
            {renderTerminalLine(
              [
                textSegment(
                  line,
                  { dim: true },
                  {
                    preserveSgr: true,
                  }
                ),
              ],
              contentWidth,
              TerminalTruncationPosition.Middle
            )}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
