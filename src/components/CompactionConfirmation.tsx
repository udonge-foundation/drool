import { Box, Text } from 'ink';
import { Trans, useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { Spinner } from '@/components/Spinner';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

interface CompactionConfirmationProps {
  currentSessionId?: string;
  isProcessing?: boolean;
  instructions?: string;
  variant?: 'confirmation' | 'status';
  width?: number;
  onConfirm?: () => void;
  onCancel?: () => void;
  onAbort?: () => void;
}

export function CompactionConfirmation({
  currentSessionId,
  isProcessing,
  instructions,
  variant = 'confirmation',
  width = 70,
  onConfirm,
  onCancel,
  onAbort,
}: CompactionConfirmationProps) {
  const { t } = useTranslation();
  const isStatus = variant === 'status';

  useKeypressHandler((input, key) => {
    if (isStatus) {
      return;
    }
    if (input === 'q' || key.escape) {
      if (isProcessing) {
        onAbort?.();
      } else {
        onCancel?.();
      }
      return;
    }
    if (key.return && !isProcessing) {
      onConfirm?.();
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={isStatus ? COLORS.primary : COLORS.border}
      paddingX={1}
      width={width}
    >
      <Box flexDirection="column" width="100%">
        <Text bold color={isStatus ? COLORS.primary : undefined}>
          {isStatus
            ? t('common:compaction.statusTitle')
            : t('common:compaction.title')}
        </Text>
        <Box marginTop={1} />
        {isStatus ? (
          <Text color={COLORS.text.muted}>
            {t('common:compaction.queueHint')}
          </Text>
        ) : (
          <>
            {currentSessionId ? (
              <Text>
                <Trans
                  i18nKey="common:compaction.compressSession"
                  components={{
                    session: <Text color={COLORS.primary} />,
                  }}
                  values={{ sessionId: currentSessionId }}
                />
              </Text>
            ) : (
              <Text>{t('common:compaction.compressThis')}</Text>
            )}
            <Text color={COLORS.text.muted}>
              {t('common:compaction.newSessionNote')}
            </Text>
            <Text color={COLORS.text.muted}>
              {t('common:compaction.comeBackNote')}
            </Text>
          </>
        )}
        {instructions && (
          <Box marginTop={1} flexDirection="column">
            <Text color={COLORS.primary}>
              {t('common:compaction.instructions')}
            </Text>
            <Text color={COLORS.text.primary}>{instructions}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          {isProcessing ? (
            <Text color={COLORS.primary}>
              <Spinner /> {t('common:compaction.compressing')}
            </Text>
          ) : !isStatus ? (
            <Text color={COLORS.text.muted}>
              {t('common:compaction.confirmHint')}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
