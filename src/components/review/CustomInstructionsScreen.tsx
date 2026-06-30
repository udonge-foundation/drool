import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { TextInput } from '@/components/common/TextInput';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

interface Props {
  width: number;
  onSubmit: (instructions: string) => void;
}

export function CustomInstructionsScreen({ width, onSubmit }: Props) {
  const { t } = useTranslation();
  const [instructions, setInstructions] = useState('');

  // Handle keyboard input
  useKeypressHandler((input, key) => {
    if (key.return && instructions.trim()) {
      onSubmit(instructions.trim());
    }
  });

  return (
    <Box
      width={width}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="round"
      borderColor={COLORS.border}
    >
      <Text bold>{t('common:review.customTitle')}</Text>

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {t('common:review.customSubtitle')}
        </Text>
      </Box>

      {/* Instructions input */}
      <Box marginTop={1} flexDirection="column">
        <TextInput
          focus
          value={instructions}
          onChange={setInstructions}
          placeholder={t('common:review.customPlaceholder')}
        />
      </Box>

      {/* Example suggestions */}
      <Box marginTop={1} flexDirection="column">
        <Text color={COLORS.text.muted} dimColor>
          {t('common:review.customExamples')}
        </Text>
        <Text color={COLORS.text.muted} dimColor>
          • {t('common:review.customExample1')}
        </Text>
        <Text color={COLORS.text.muted} dimColor>
          • {t('common:review.customExample2')}
        </Text>
        <Text color={COLORS.text.muted} dimColor>
          • {t('common:review.customExample3')}
        </Text>
        <Text color={COLORS.text.muted} dimColor>
          • {t('common:review.customExample4')}
        </Text>
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {instructions.trim()
            ? t('common:review.customSubmitHelp')
            : t('common:review.customTypeHelp')}
        </Text>
      </Box>
    </Box>
  );
}
