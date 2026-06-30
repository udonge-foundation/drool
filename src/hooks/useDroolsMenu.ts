import { useCallback, useState } from 'react';

import { DroolsFlow } from '@/hooks/enums';
import type { UseDroolsMenu } from '@/hooks/types';
import type { DroolConfig } from '@/services/drools/types';

export function useDroolsMenu(): UseDroolsMenu {
  const [show, setShow] = useState(false);
  const [flow, setFlowState] = useState<DroolsFlow>(DroolsFlow.Menu);
  const [selected, setSelected] = useState<DroolConfig | null>(null);

  const open = useCallback(() => {
    setShow(true);
  }, []);

  const close = useCallback(() => {
    setShow(false);
    setFlowState(DroolsFlow.Menu);
    setSelected(null);
  }, []);

  const setFlow = useCallback((next: DroolsFlow) => {
    setFlowState(next);
  }, []);

  return { show, open, close, flow, setFlow, selected, setSelected };
}
