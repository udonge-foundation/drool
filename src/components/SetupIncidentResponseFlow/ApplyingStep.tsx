import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { Spinner } from '@/components/Spinner';

interface ApplyingStepProps {
  channelName: string;
}

export function ApplyingStep({ channelName }: ApplyingStepProps) {
  const { t } = useTranslation('commands');

  return (
    <MenuContainer
      title={t('slashMessages.setupIncidentResponse.applyingStep.title')}
      showDefaultHelp={false}
    >
      <Box>
        <Spinner />
        <Text color={COLORS.text.muted}>
          {' '}
          {t('slashMessages.setupIncidentResponse.applyingStep.message', {
            channel: `#${channelName}`,
          })}
        </Text>
      </Box>
    </MenuContainer>
  );
}
