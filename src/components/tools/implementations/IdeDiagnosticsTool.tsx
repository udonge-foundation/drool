import { Text, Box } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { getTextContent } from '@/utils/tool-result-helpers';

// eslint-disable-next-line industry/constants-file-organization
export const IdeDiagnosticsTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const uri = input.uri as string;
    if (!uri) return '';
    const filename = uri.split('/').pop() || uri;
    return filename;
  },

  renderResult({ input: _input, result, isError }: ToolComponentProps) {
    if (isError) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{getTextContent(result)}</Text>
        </Box>
      );
    }

    try {
      const data = JSON.parse(getTextContent(result) || '{}');
      const { diagnostics = [] } = data;

      const counts = { error: 0, warning: 0, information: 0, hint: 0 };
      const severityNames = ['error', 'warning', 'information', 'hint'];

      diagnostics.forEach((d: { severity: number }) => {
        const severityName = severityNames[d.severity] || 'error';
        counts[severityName as keyof typeof counts]++;
      });

      const parts: string[] = [];
      const t = getI18n().t;
      if (counts.error > 0)
        parts.push(
          `${counts.error} ${t('common:toolDisplay.ideDiagnostics.error', { count: counts.error })}`
        );
      if (counts.warning > 0)
        parts.push(
          `${counts.warning} ${t('common:toolDisplay.ideDiagnostics.warning', { count: counts.warning })}`
        );
      if (counts.information > 0)
        parts.push(
          `${counts.information} ${t('common:toolDisplay.ideDiagnostics.info')}`
        );
      if (counts.hint > 0)
        parts.push(
          `${counts.hint} ${t('common:toolDisplay.ideDiagnostics.hint', { count: counts.hint })}`
        );

      const summaryText =
        parts.length > 0
          ? parts.join(', ')
          : t('common:toolDisplay.ideDiagnostics.noIssues');

      return (
        <Box flexDirection="column">
          <Text
            color={
              counts.error > 0
                ? COLORS.error
                : counts.warning > 0
                  ? COLORS.warning
                  : COLORS.success
            }
          >
            {'↳ '}
            {summaryText}
          </Text>
        </Box>
      );
    } catch {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            {'↳ '}
            {getTextContent(result)}
          </Text>
        </Box>
      );
    }
  },

  getSummaryLine(
    input: Record<string, unknown>,
    result: string,
    isError: boolean
  ): string {
    if (isError) {
      if (
        result.includes('cancelled by user') ||
        result.includes('interrupted by user')
      ) {
        return getI18n().t('common:toolDisplay.ideDiagnostics.cancelledByUser');
      }
      return result;
    }

    try {
      const data = JSON.parse(getTextContent(result));
      const { diagnostics = [] } = data;

      const counts = { error: 0, warning: 0 };
      const severityNames = ['error', 'warning', 'information', 'hint'];

      diagnostics.forEach((d: { severity: number }) => {
        const severityName = severityNames[d.severity] || 'error';
        if (severityName === 'error') counts.error++;
        else if (severityName === 'warning') counts.warning++;
      });

      const parts: string[] = [];
      const t = getI18n().t;
      if (counts.error > 0)
        parts.push(
          `${counts.error} ${t('common:toolDisplay.ideDiagnostics.error', { count: counts.error })}`
        );
      if (counts.warning > 0)
        parts.push(
          `${counts.warning} ${t('common:toolDisplay.ideDiagnostics.warning', { count: counts.warning })}`
        );

      const summaryText =
        parts.length > 0
          ? parts.join(', ')
          : t('common:toolDisplay.ideDiagnostics.noIssues');
      return summaryText;
    } catch {
      return result;
    }
  },
};
