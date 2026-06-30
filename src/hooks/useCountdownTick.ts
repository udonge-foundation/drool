import { useState } from 'react';

import { useMountEffect } from '@/hooks/useMountEffect';

const TICK_INTERVAL_MS = 1_000;

/**
 * Returns Date.now() and re-renders the calling component once per second.
 * Use to drive live "next fire in 32s" countdowns when nothing else
 * triggers a re-render.
 */
export function useCountdownTick() {
  const [now, setNow] = useState(() => Date.now());
  useMountEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(handle);
  });
  return now;
}
