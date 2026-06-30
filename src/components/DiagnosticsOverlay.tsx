import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useDiagnosticsStatus } from '@/hooks/useDiagnosticsStatus';
import { useEscapeHandler } from '@/hooks/useEscapeHandler';

const MAX_DISPLAYED_FAILURES = 10;

interface DiagnosticsOverlayProps {
  onClose: () => void;
}

export function DiagnosticsOverlay({ onClose }: DiagnosticsOverlayProps) {
  const { t } = useTranslation();
  const { failures } = useDiagnosticsStatus();

  useEscapeHandler(onClose);

  const displayed = failures.slice(0, MAX_DISPLAYED_FAILURES);
  const remaining = failures.length - displayed.length;
  const title =
    failures.length !== 1
      ? t('common:diagnostics.title_other', { count: failures.length })
      : t('common:diagnostics.title', { count: failures.length });

  return (
    <MenuContainer
      title={title}
      helpText={t('common:diagnostics.helpText')}
      showDefaultHelp={false}
    >
      {failures.length === 0 ? (
        <Text color={COLORS.text.muted}>
          {t('common:diagnostics.noFailures')}
        </Text>
      ) : (
        <Box flexDirection="column">
          {displayed.map((f, i) => (
            <Text key={`${f.path}-${i}`}>
              {i + 1}. {f.path} | {f.message}
            </Text>
          ))}
          {remaining > 0 && (
            <Box marginTop={1}>
              <Text color={COLORS.text.muted}>
                {remaining !== 1
                  ? t('common:diagnostics.moreIssues_other', {
                      count: remaining,
                    })
                  : t('common:diagnostics.moreIssues_one', {
                      count: remaining,
                    })}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </MenuContainer>
  );
}
