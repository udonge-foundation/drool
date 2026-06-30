import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

interface ResultStepProps {
  variant: 'success' | 'failure';
  channelName: string;
  errorMessage?: string;
  /** True if the channel was enabled but the settings PATCH failed. */
  partialEnable?: boolean;
  onDismiss: () => void;
}

/**
 * Render an error message that may contain newlines as a stack of rows so each
 * line gets its own fully-bordered Ink row. Inlining a multi-line `<Text>` next
 * to a sibling marker `<Text>` inside a flex-row `<Box>` corrupts the layout
 * (the first line collapses against the border, later lines lose their left
 * pad). `describeFetchError` already strips ANSI/control bytes via
 * `sanitizeTerminalDisplayText({ stripSgr: true })` but explicitly keeps `\n`
 * so legitimate multi-line server errors stay readable -- this component owns
 * the corresponding multi-row layout.
 */
function ErrorBlock({ message }: { message: string }) {
  const lines = message.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={index}>
          {index === 0 ? (
            <Text color={COLORS.error}>{'\u2717 '}</Text>
          ) : (
            <Text>{'  '}</Text>
          )}
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function ResultStep({
  variant,
  channelName,
  errorMessage,
  partialEnable,
  onDismiss,
}: ResultStepProps) {
  const { t } = useTranslation('commands');

  useKeypressHandler(() => {
    onDismiss();
  });

  if (variant === 'success') {
    return (
      <MenuContainer
        title={t('slashMessages.setupIncidentResponse.resultStep.successTitle')}
        helpText={t(
          'slashMessages.setupIncidentResponse.resultStep.dismissHelp'
        )}
        showDefaultHelp={false}
      >
        <Box>
          <Text color={COLORS.success}>{'\u2713 '}</Text>
          <Text>
            {t(
              'slashMessages.setupIncidentResponse.resultStep.successMessage',
              {
                channel: `#${channelName}`,
              }
            )}
          </Text>
        </Box>
      </MenuContainer>
    );
  }

  const message =
    errorMessage ??
    t('slashMessages.setupIncidentResponse.resultStep.failureFallback');

  return (
    <MenuContainer
      title={t('slashMessages.setupIncidentResponse.resultStep.failureTitle')}
      helpText={t('slashMessages.setupIncidentResponse.resultStep.dismissHelp')}
      showDefaultHelp={false}
    >
      <Box flexDirection="column">
        <ErrorBlock message={message} />
        {partialEnable && (
          <Box marginTop={1}>
            <Text color={COLORS.warning}>
              {t(
                'slashMessages.setupIncidentResponse.resultStep.partialEnableWarning',
                { channel: `#${channelName}` }
              )}
            </Text>
          </Box>
        )}
      </Box>
    </MenuContainer>
  );
}
