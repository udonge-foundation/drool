import { useState } from 'react';

import { useMountEffect } from '@/hooks/useMountEffect';
import { getPrService } from '@/services/PrService';
import type { PrState } from '@/services/types';

const PR_POLL_INTERVAL_MS = 60_000;

export function usePrIndicator(): PrState {
  const [state, setState] = useState<PrState>(() => getPrService().getState());

  useMountEffect(() => {
    const service = getPrService();
    const unsubscribe = service.subscribe(setState);
    const interval = setInterval(() => {
      void service.refresh();
    }, PR_POLL_INTERVAL_MS);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  });

  return state;
}
