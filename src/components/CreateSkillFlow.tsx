import { Box, Text } from 'ink';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { useEscapeHandler } from '@/hooks/useEscapeHandler';

interface CreateSkillFlowProps {
  initialValue?: string;
  onCancel: () => void;
  onStart: (description: string) => void;
}

export function CreateSkillFlow({
  initialValue = '',
  onCancel,
  onStart,
}: CreateSkillFlowProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  const handleStart = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(t('common:createSkill.errorEmpty'));
      return;
    }
    onStart(trimmed);
  }, [onStart, value, t]);

  useEscapeHandler(onCancel);

  return (
    <MenuContainer
      title={t('common:createSkill.title')}
      helpText={t('common:createSkill.helpText')}
    >
      <Box flexDirection="column">
        <Text>{t('common:createSkill.mainDescription')}</Text>
        <Text color={COLORS.text.muted}>
          {t('common:createSkill.sessionCopy')}
        </Text>
        <Text color={COLORS.text.muted}>
          {t('common:createSkill.contextReview')}
        </Text>
        <Text color={COLORS.text.muted}>
          {t('common:createSkill.reviewGenerated')}
        </Text>
        <Text color={COLORS.text.muted}>
          {t('common:createSkill.sessionIntact')}
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text color={COLORS.text.secondary}>
            {t('common:createSkill.examplesLabel')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('common:createSkill.example1')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('common:createSkill.example2')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('common:createSkill.example3')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('common:createSkill.example4')}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={COLORS.primary}>
            {t('common:createSkill.workflowLabel')}
          </Text>
          <Text color={COLORS.text.muted}>{t('common:createSkill.tip')}</Text>
          <Text color={COLORS.text.muted}>
            {t('common:createSkill.avoidSteps')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('common:createSkill.suggestedName')}
          </Text>
          <Box>
            <Text color={COLORS.text.muted}>&gt; </Text>
            <TextInput
              value={value}
              onChange={(next) => {
                setValue(next);
                if (error) setError(null);
              }}
              onSubmit={handleStart}
              placeholder={t('common:createSkill.placeholder')}
            />
          </Box>
        </Box>

        {error && (
          <Box marginTop={1}>
            <Text color={COLORS.error}>{error}</Text>
          </Box>
        )}
      </Box>
    </MenuContainer>
  );
}
