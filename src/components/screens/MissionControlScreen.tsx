import { Box } from 'ink';

import type { ReactNode } from 'react';

interface MissionControlScreenProps {
  content: ReactNode;
}

export function MissionControlScreen({ content }: MissionControlScreenProps) {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexGrow={1} width="100%">
        {content}
      </Box>
    </Box>
  );
}
