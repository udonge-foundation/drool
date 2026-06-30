import { Box, Text } from 'ink';

import { ApprovalDetailsView } from '@/components/ApprovalDetailsView';
import { COLORS } from '@/components/chat/themedColors';
import { getI18n } from '@/i18n';
import type { BatchToolConfirmationDetails } from '@/types/types';

interface ApprovalDetailsScreenProps {
  confirmationDetails: BatchToolConfirmationDetails;
  width: number;
}

export function ApprovalDetailsScreen({
  confirmationDetails,
  width,
}: ApprovalDetailsScreenProps) {
  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexGrow={1} flexDirection="column" width="100%">
        <ApprovalDetailsView
          confirmationDetails={confirmationDetails}
          width={width}
        />
      </Box>
      <Box flexShrink={0} width={width} justifyContent="center" paddingY={1}>
        <Text color={COLORS.text.muted}>
          {getI18n().t('common:approvalDetails.returnHint')}
        </Text>
      </Box>
    </Box>
  );
}
