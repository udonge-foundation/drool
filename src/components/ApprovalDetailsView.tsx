import { Box, Text } from 'ink';

import {
  ToolConfirmationType,
  type ApplyPatchToolConfirmationDetails,
  type CreateToolConfirmationDetails,
  type EditToolConfirmationDetails,
  type ExecuteToolConfirmationDetails,
} from '@industry/drool-sdk-ext/protocol/drool';

import { COLORS } from '@/components/chat/themedColors';
import { UnifiedToolDisplay } from '@/components/UnifiedToolDisplay';
import { ToolCallStatus } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import type { BatchToolConfirmationDetails } from '@/types/types';
import { generateUnifiedDiff } from '@/utils/diff-utils';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';
import type { DiffLine } from '@/utils/types';

interface ApprovalDetailsViewProps {
  confirmationDetails: BatchToolConfirmationDetails;
  width: number;
}

function getExecuteRiskLabel(impactLevel: string | undefined): string | null {
  const t = getI18n().t;
  if (impactLevel === 'low')
    return t('common:batchConfirmation.commandRiskLow');
  if (impactLevel === 'medium')
    return t('common:batchConfirmation.commandRiskMedium');
  if (impactLevel === 'high')
    return t('common:batchConfirmation.commandRiskHigh');
  return null;
}

function getDiffContextLines(oldContent: string, newContent: string): number {
  return Math.max(oldContent.split('\n').length, newContent.split('\n').length);
}

function getDiffText(oldContent: string, newContent: string): string {
  return generateUnifiedDiff(
    oldContent,
    newContent,
    getDiffContextLines(oldContent, newContent)
  )
    .map((line) => {
      if (line.type === 'added') return `+${line.content}`;
      if (line.type === 'removed') return `-${line.content}`;
      return ` ${line.content}`;
    })
    .join('\n');
}

function getEditDiffLines(oldContent: string, newContent: string): DiffLine[] {
  return generateUnifiedDiff(
    oldContent,
    newContent,
    getDiffContextLines(oldContent, newContent)
  );
}

function ApprovalToolDisplay({
  toolName,
  toolInput,
  result,
  width,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  result?: string;
  width: number;
}) {
  return (
    <UnifiedToolDisplay
      toolName={toolName}
      toolInput={toolInput}
      status={ToolCallStatus.Completed}
      result={result}
      contentWidth={width}
      isDetailedView
    />
  );
}

function ApprovalToolDetails({
  tool,
  index,
  width,
}: {
  tool: BatchToolConfirmationDetails['tools'][number];
  index: number;
  width: number;
}) {
  const t = getI18n().t;

  if (tool.confirmationType === ToolConfirmationType.Execute) {
    const details = tool.details as ExecuteToolConfirmationDetails;
    const riskLabel = getExecuteRiskLabel(details.impactLevel);
    const reason =
      typeof details.riskLevelReason === 'string'
        ? sanitizeTerminalDisplayText(details.riskLevelReason, {
            stripSgr: true,
          }).trim()
        : '';

    return (
      <Box flexDirection="column" marginBottom={1}>
        <ApprovalToolDisplay
          toolName="Execute"
          toolInput={{ command: details.fullCommand ?? details.command ?? '' }}
          width={width}
        />
        {reason.length > 0 && (
          <Box marginLeft={4} marginTop={0}>
            <Text color={COLORS.text.muted} wrap="wrap">
              {riskLabel ? `${riskLabel} · ` : ''}
              {t('common:batchConfirmation.commandRiskReasonHeader')} {reason}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (tool.confirmationType === ToolConfirmationType.Create) {
    const details = tool.details as CreateToolConfirmationDetails;
    return (
      <Box key={`${tool.toolUseId}-${index}`} marginBottom={1}>
        <ApprovalToolDisplay
          toolName="Create"
          toolInput={{
            file_path: details.filePath,
            content: details.content,
          }}
          result={JSON.stringify({
            success: true,
            file_path: details.filePath,
          })}
          width={width}
        />
      </Box>
    );
  }

  if (tool.confirmationType === ToolConfirmationType.Edit) {
    const details = tool.details as EditToolConfirmationDetails;
    const diffText =
      typeof details.oldContent === 'string' &&
      typeof details.newContent === 'string'
        ? getDiffText(details.oldContent, details.newContent)
        : t('common:batchConfirmation.previewUnavailable');
    return (
      <Box key={`${tool.toolUseId}-${index}`} marginBottom={1}>
        <ApprovalToolDisplay
          toolName="Edit"
          toolInput={{
            file_path: details.filePath,
          }}
          result={
            typeof details.oldContent === 'string' &&
            typeof details.newContent === 'string'
              ? JSON.stringify({
                  success: true,
                  file_path: details.filePath,
                  diffLines: getEditDiffLines(
                    details.oldContent,
                    details.newContent
                  ),
                })
              : diffText
          }
          width={width}
        />
      </Box>
    );
  }

  if (tool.confirmationType === ToolConfirmationType.ApplyPatch) {
    const details = tool.details as ApplyPatchToolConfirmationDetails;
    let applyPatchResult = JSON.stringify({
      success: true,
      file_path: details.filePath,
    });
    if (
      typeof details.oldContent === 'string' &&
      typeof details.newContent === 'string'
    ) {
      applyPatchResult = JSON.stringify({
        success: true,
        file_path: details.filePath,
        display_operation: 'update',
        diff: getDiffText(details.oldContent, details.newContent),
      });
    }
    return (
      <Box key={`${tool.toolUseId}-${index}`} marginBottom={1}>
        <ApprovalToolDisplay
          toolName="ApplyPatch"
          toolInput={{ input: details.patchContent }}
          result={applyPatchResult}
          width={width}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={COLORS.primary}>{`${index + 1}. ${tool.toolName}`}</Text>
      <Text color={COLORS.text.muted} wrap="wrap">
        {t('common:batchConfirmation.defaultOperation', {
          toolName: tool.toolName,
        })}
      </Text>
    </Box>
  );
}

export function ApprovalDetailsView({
  confirmationDetails,
  width,
}: ApprovalDetailsViewProps) {
  const t = getI18n().t;

  return (
    <Box flexDirection="column" width={width}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.primary}>
          {t('common:approvalDetails.title')}
        </Text>
      </Box>
      {confirmationDetails.tools.map((tool, index) => (
        <ApprovalToolDetails
          key={tool.toolUseId}
          tool={tool}
          index={index}
          width={width}
        />
      ))}
    </Box>
  );
}
