import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import type { WizardSelections } from '@/components/SetupIncidentResponseFlow/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

interface ConfirmStepProps {
  selections: WizardSelections;
  onConfirm: () => void;
}

const PROMPT_PREVIEW_LINES = 2;

function previewPrompt(prompt: string): string {
  const lines = prompt.split('\n');
  if (lines.length <= PROMPT_PREVIEW_LINES) return prompt;
  return `${lines.slice(0, PROMPT_PREVIEW_LINES).join('\n')}\n…`;
}

export function ConfirmStep({ selections, onConfirm }: ConfirmStepProps) {
  const { t } = useTranslation('commands');

  useKeypressHandler((_input, key) => {
    if (key.return) onConfirm();
  });

  const channelName = selections.channel
    ? `#${selections.channel.name}`
    : t('slashMessages.setupIncidentResponse.confirmStep.unknown');
  const computerName =
    selections.computer?.name ??
    t('slashMessages.setupIncidentResponse.confirmStep.unknown');

  return (
    <MenuContainer
      title={t('slashMessages.setupIncidentResponse.confirmStep.title')}
      helpText={t('slashMessages.setupIncidentResponse.confirmStep.help')}
      showDefaultHelp={false}
    >
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {t('slashMessages.setupIncidentResponse.confirmStep.description')}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Box width={14}>
              <Text color={COLORS.text.muted}>
                {t(
                  'slashMessages.setupIncidentResponse.confirmStep.fieldChannel'
                )}
              </Text>
            </Box>
            <Text>{channelName}</Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text color={COLORS.text.muted}>
                {t(
                  'slashMessages.setupIncidentResponse.confirmStep.fieldComputer'
                )}
              </Text>
            </Box>
            <Text>{computerName}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('slashMessages.setupIncidentResponse.confirmStep.fieldPrompt')}
            </Text>
            <Box marginLeft={2}>
              <Text>{previewPrompt(selections.prompt)}</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    </MenuContainer>
  );
}
