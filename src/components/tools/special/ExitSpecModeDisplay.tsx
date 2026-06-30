import { Box } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import { JsonRenderContent } from '@/components/JsonRenderContent';

interface ExitSpecModeDisplayProps {
  toolInput: Record<string, unknown>;
  contentWidth?: number;
}

export function ExitSpecModeDisplay({
  toolInput,
  contentWidth,
}: ExitSpecModeDisplayProps) {
  // Only render for ExitSpecMode with plan
  if (!('plan' in toolInput) || !toolInput.plan) {
    return null;
  }

  return (
    <Box flexDirection="column" width="100%">
      <Box
        borderBottom
        borderTop
        borderRight={false}
        borderLeft={false}
        borderStyle="round"
        borderColor={COLORS.spec}
        paddingY={1}
        width={contentWidth}
        flexDirection="column"
      >
        <JsonRenderContent maxWidth={contentWidth}>
          {String(toolInput.plan)}
        </JsonRenderContent>
      </Box>
    </Box>
  );
}
