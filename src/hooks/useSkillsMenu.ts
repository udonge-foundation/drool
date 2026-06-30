import { useCallback, useState } from 'react';

import { SkillTab, SkillsFlow } from '@/hooks/enums';
import type { UseSkillsMenu } from '@/hooks/types';

export function useSkillsMenu(): UseSkillsMenu {
  const [show, setShow] = useState(false);
  const [flow, setFlowState] = useState<SkillsFlow>(SkillsFlow.Menu);
  const [activeTab, setActiveTab] = useState<SkillTab>(SkillTab.Project);

  const open = useCallback(() => {
    setShow(true);
  }, []);

  const close = useCallback(() => {
    setShow(false);
    setFlowState(SkillsFlow.Menu);
  }, []);

  const setFlow = useCallback((next: SkillsFlow) => {
    setFlowState(next);
  }, []);

  return { show, open, close, flow, setFlow, activeTab, setActiveTab };
}
