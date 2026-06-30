import ansiEscapes from 'ansi-escapes';
import { Box, Text, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import animationFramesJson from '@/assets/drool-animation.json';
import { getClearTerminalSequence } from '@/utils/clearTerminal';
import { clearInkOutput } from '@/utils/inkRendering';

// Convert JSON array of line arrays to array of frame strings
const FRAME_STRINGS: readonly string[] = animationFramesJson.map((frame) =>
  frame.join('\n')
);

// Calculate max frame height
const MAX_FRAME_HEIGHT = FRAME_STRINGS.reduce<number>((maxHeight, frame) => {
  const lines = frame.split('\n');
  return Math.max(maxHeight, lines.length);
}, 0);

// Character density fade levels (dense → sparse)
const FADE_CHARS: Record<string, string[]> = {
  '█': ['▓', '▒', '░', ' '],
  '▐': ['#', '*', '.', ' '],
  '▓': ['▒', '░', ' ', ' '],
  '▒': ['░', ' ', ' ', ' '],
  '░': [' ', ' ', ' ', ' '],
  '#': ['*', '.', ' ', ' '],
  '*': ['.', ' ', ' ', ' '],
  '.': [' ', ' ', ' ', ' '],
};
const DEFAULT_FADE = ['.', ' ', ' ', ' '];
const FADE_LEVELS = 4;

function applyFade(frame: string, level: number): string {
  if (level === 0) return frame;
  return frame
    .split('')
    .map((char) => {
      if (char === ' ' || char === '\n') return char;
      const fadeSequence = FADE_CHARS[char] ?? DEFAULT_FADE;
      return fadeSequence[Math.min(level - 1, fadeSequence.length - 1)];
    })
    .join('');
}

interface FullScreenAnimationProps {
  onComplete: () => void;
  fps?: number;
}

export function FullScreenAnimation({
  onComplete,
  fps = 20,
}: FullScreenAnimationProps) {
  const {
    stdout,
    write: writeToStdout,
    invalidateOutput,
  } = useStdout() as ReturnType<typeof useStdout> & {
    invalidateOutput?: (resetStaticOutput?: boolean) => void;
  };
  const [index, setIndex] = useState(0);
  const [fadeLevel, setFadeLevel] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined
  );
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const clearTerminalSequence = useMemo(() => getClearTerminalSequence(), []);
  const clearInkTerminal = useCallback(() => {
    clearInkOutput({
      clearTerminalSequence,
      writeToStdout,
      invalidateOutput,
    });
  }, [clearTerminalSequence, invalidateOutput, writeToStdout]);

  // Keep onComplete ref updated
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Get terminal dimensions
  const terminalWidth = stdout?.columns ?? 80;
  const terminalHeight = stdout?.rows ?? 24;

  // Clear terminal on mount
  useEffect(() => {
    clearInkTerminal();
    process.stdout.write(ansiEscapes.cursorHide);

    return () => {
      process.stdout.write(ansiEscapes.cursorShow);
    };
  }, [clearInkTerminal]);

  const clearIntervalRef = useCallback(() => {
    if (intervalRef.current !== undefined) {
      clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }
  }, []);

  // Animation loop
  useEffect(() => {
    if (!FRAME_STRINGS.length || process.env.NODE_ENV === 'test') {
      // Skip animation in tests
      if (!completedRef.current) {
        completedRef.current = true;
        onCompleteRef.current();
      }
      return undefined;
    }

    const interval = Math.max(20, Math.floor(1000 / fps));
    const finalIndex = FRAME_STRINGS.length - 1;

    const tick = () => {
      setIndex((prev) => {
        if (prev >= finalIndex) {
          return finalIndex;
        }
        return prev + 1;
      });
    };

    intervalRef.current = setInterval(tick, interval);
    return () => {
      clearIntervalRef();
    };
  }, [clearIntervalRef, fps]);

  // Handle animation completion with fade-out
  useEffect(() => {
    if (!FRAME_STRINGS.length) return;
    const finalIndex = FRAME_STRINGS.length - 1;
    if (index >= finalIndex) {
      clearIntervalRef();
      if (fadeLevel < FADE_LEVELS) {
        const timer = setTimeout(() => {
          setFadeLevel((prev) => prev + 1);
        }, 120);
        return () => clearTimeout(timer);
      }
      if (!completedRef.current) {
        completedRef.current = true;
        setTimeout(() => {
          onCompleteRef.current();
        }, 100);
      }
    }
    return undefined;
  }, [clearIntervalRef, index, fadeLevel]);

  // Render current frame with fade effect
  const content = useMemo(() => {
    if (!FRAME_STRINGS.length) return '';
    const safeIndex = Math.min(index, FRAME_STRINGS.length - 1);
    const raw = FRAME_STRINGS[safeIndex];
    const lines = raw.split('\n');

    // Pad to max height for consistent frame size
    while (lines.length < MAX_FRAME_HEIGHT) {
      lines.push('');
    }

    const frame = lines.join('\n');
    return applyFade(frame, fadeLevel);
  }, [index, fadeLevel]);

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={terminalHeight}
      alignItems="center"
      justifyContent="center"
    >
      <Text bold>{content}</Text>
    </Box>
  );
}
