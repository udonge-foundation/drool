import { useCallback, useState } from 'react';

import { HookEventName, HooksFlow } from '@/hooks/enums';
import type { UseHooksManager } from '@/hooks/types';

import type { HookConfig } from '@industry/common/cli';

export function useHooksManager(): UseHooksManager {
  const [show, setShow] = useState(false);
  const [flow, setFlowState] = useState<HooksFlow>(HooksFlow.Menu);
  const [selectedHookType, setSelectedHookType] =
    useState<HookEventName | null>(null);
  const [editingConfig, setEditingConfig] = useState<HookConfig | null>(null);

  const open = useCallback(() => {
    setShow(true);
    setFlowState(HooksFlow.Menu);
    setSelectedHookType(null);
    setEditingConfig(null);
  }, []);

  const close = useCallback(() => {
    setShow(false);
    setFlowState(HooksFlow.Menu);
    setSelectedHookType(null);
    setEditingConfig(null);
  }, []);

  const setFlow = useCallback((newFlow: HooksFlow) => {
    setFlowState(newFlow);
  }, []);

  return {
    show,
    open,
    close,
    flow,
    setFlow,
    selectedHookType,
    setSelectedHookType,
    editingConfig,
    setEditingConfig,
  };
}
