import { useCallback, useState } from 'react';

import type { UseDiagnosticsMenu } from '@/hooks/types';

export function useDiagnosticsMenu(): UseDiagnosticsMenu {
  const [show, setShow] = useState(false);

  const open = useCallback(() => {
    setShow(true);
  }, []);

  const close = useCallback(() => {
    setShow(false);
  }, []);

  return { show, open, close };
}
