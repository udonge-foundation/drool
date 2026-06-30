import { Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';

import { useIsFastMode } from '@/utils/isFastMode';
import { createTuiSpinner } from '@/utils/tuiSpinner';
import { TuiSpinnerPresetName } from '@/utils/tuiSpinner/enums';
import type { TuiSpinnerPresetInput } from '@/utils/tuiSpinner/types';

interface SpinnerProps {
  preset?: TuiSpinnerPresetInput;
  intervalMs?: number;
  offset?: number;
}

export function Spinner({
  preset = TuiSpinnerPresetName.Dots,
  intervalMs,
  offset = 0,
}: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const fast = useIsFastMode();
  const spinner = useMemo(() => {
    let configuredSpinner = createTuiSpinner(preset).withOffset(offset);

    if (intervalMs !== undefined) {
      configuredSpinner = configuredSpinner.withInterval(intervalMs);
    } else if (fast) {
      configuredSpinner = configuredSpinner.withInterval(
        Math.max(1, Math.floor(configuredSpinner.intervalMs / 2))
      );
    }

    return configuredSpinner;
  }, [fast, intervalMs, offset, preset]);

  useEffect(() => {
    setFrame(0);
  }, [spinner]);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prevFrame) => (prevFrame + 1) % spinner.length);
    }, spinner.intervalMs);

    return () => clearInterval(timer);
  }, [spinner]);

  return <Text>{spinner.frame(frame)}</Text>;
}
