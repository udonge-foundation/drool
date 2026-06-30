import { useSyncExternalStore } from 'react';

import { getDiagnosticsService } from '@/services/diagnostics/DiagnosticsService';
import type { DiagnosticsState } from '@/services/diagnostics/types';

const subscribe = (onStoreChange: () => void): (() => void) =>
  getDiagnosticsService().subscribe(onStoreChange);

const getSnapshot = (): DiagnosticsState => getDiagnosticsService().getState();

export function useDiagnosticsStatus(): DiagnosticsState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
