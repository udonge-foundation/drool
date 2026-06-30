import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';

interface PromptStepProps {
  defaultPrompt: string;
  initialValue: string;
  onSubmit: (prompt: string) => void;
}

export function PromptStep({
  defaultPrompt,
  initialValue,
  onSubmit,
}: PromptStepProps) {
  const { t } = useTranslation('commands');
  const [value, setValue] = useState(initialValue);

  const handleSubmit = (submitted: string) => {
    const trimmed = submitted.trim() || defaultPrompt;
    onSubmit(trimmed);
  };

  return (
    <MenuContainer
      title={t('slashMessages.setupIncidentResponse.promptStep.title')}
      helpText={t('slashMessages.setupIncidentResponse.promptStep.help')}
      showDefaultHelp={false}
    >
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {t('slashMessages.setupIncidentResponse.promptStep.description')}
        </Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>&gt; </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder={defaultPrompt}
          />
        </Box>
      </Box>
    </MenuContainer>
  );
}
