import { Box } from 'ink';

import { SkillsMenu } from '@/components/skills/SkillsMenu';
import type { UseSkillsMenu } from '@/hooks/types';

interface SkillsOverlayProps {
  width: number;
  controller: UseSkillsMenu;
}

export function SkillsOverlay({ width, controller }: SkillsOverlayProps) {
  const { activeTab, setActiveTab, close } = controller;

  return (
    <Box width={width}>
      <SkillsMenu
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClose={close}
      />
    </Box>
  );
}
