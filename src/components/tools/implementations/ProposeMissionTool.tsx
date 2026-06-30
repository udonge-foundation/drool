import { Box, Text } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { getTextContent } from '@/utils/tool-result-helpers';

type MissionProposalResult = {
  accepted?: boolean;
  missionDir?: string;
};

function parseProposalResult(
  result?: ToolComponentProps['result']
): MissionProposalResult | null {
  const text = getTextContent(result);
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as MissionProposalResult;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function renderProposalResult(
  result: ToolComponentProps['result'],
  isError?: boolean
) {
  if (isError) {
    const errorText = getTextContent(result);
    return (
      <Box flexDirection="column">
        <Text color={COLORS.error}>{errorText}</Text>
      </Box>
    );
  }

  const parsed = parseProposalResult(result);

  if (!parsed) {
    const fallback = getTextContent(result);
    if (!fallback) {
      return null;
    }

    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>↳ {fallback}</Text>
      </Box>
    );
  }

  if (parsed.accepted) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={COLORS.success}>
          {getI18n().t('common:toolDisplay.proposeMission.approved')}
        </Text>
        {parsed.missionDir && (
          <Text color={COLORS.text.muted}>
            {getI18n().t('common:toolDisplay.proposeMission.missionDir')}{' '}
            {parsed.missionDir}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={COLORS.error}>
        {getI18n().t('common:toolDisplay.proposeMission.changesRequested')}
      </Text>
    </Box>
  );
}

// eslint-disable-next-line industry/constants-file-organization
export const ProposeMissionTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const title = input.title;
    if (title && typeof title === 'string') {
      return `"${title}"`;
    }
    return '';
  },

  renderResult({ result, isError }: ToolComponentProps) {
    return renderProposalResult(result, isError);
  },

  renderDetailedView({ result, isError }: ToolComponentProps) {
    return renderProposalResult(result, isError);
  },

  getSummaryLine(
    input: Record<string, unknown>,
    _result: ToolComponentProps['result'],
    _isError: boolean
  ): string {
    const title = input.title;
    if (title && typeof title === 'string') {
      return getI18n().t('common:toolDisplay.proposeMission.summaryProposal', {
        title,
      });
    }
    return getI18n().t('common:toolDisplay.proposeMission.summaryReady');
  },
};
