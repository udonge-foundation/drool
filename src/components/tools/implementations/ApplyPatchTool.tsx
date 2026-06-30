import fs from 'fs';
import path from 'path';

import { Text, Box } from 'ink';

import {
  extractFilePathFromPatch,
  getFileOperationFromPatch,
} from '@industry/drool-core/tools/utils/apply-patch';
import { FileOperation } from '@industry/drool-core/tools/utils/enums';
import { ApplyPatchTuiResult } from '@industry/drool-core/tools/utils/types';

import { MAX_DIFF_LINES } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { HorizontalLine } from '@/components/common/HorizontalLine';
import { DiffRenderer } from '@/components/DiffRenderer';
import { CreateTool } from '@/components/tools/implementations/CreateTool';
import { EditTool } from '@/components/tools/implementations/EditTool';
import {
  ToolComponent,
  ToolComponentProps,
  ToolDisplayOverride,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { getDiffSummary, smartTruncateDiff } from '@/utils/diff-utils';
import { getToolErrorMessage } from '@/utils/error-messages';
import { getTextContent } from '@/utils/tool-result-helpers';
import { truncateFilePath } from '@/utils/truncate';
import { DiffLine } from '@/utils/types';

function buildCreateContentLinesFromPatch(patchInput: string): string[] {
  const lines = patchInput.split('\n');
  const addFileIndex = lines.findIndex((line) =>
    line.startsWith('*** Add File: ')
  );

  if (addFileIndex === -1) {
    return [];
  }

  const contentLines: string[] = [];

  for (const line of lines.slice(addFileIndex + 1)) {
    if (line.startsWith('*** End')) {
      break;
    }

    if (line === '@@' || line.startsWith('@@ ')) {
      continue;
    }

    if (!line.startsWith('+')) {
      continue;
    }

    contentLines.push(line.substring(1));
  }

  return contentLines;
}

function buildCreateContentFromPatch(patchInput: string): string {
  return buildCreateContentLinesFromPatch(patchInput).join('\n');
}

function buildCreateDiffLinesFromPatch(patchInput: string): DiffLine[] {
  return buildCreateContentLinesFromPatch(patchInput).map((line, index) => ({
    type: 'added',
    content: line,
    lineNumber: { new: index + 1 },
  }));
}

function parseUnifiedDiffToDiffLines(diff: string): DiffLine[] {
  const diffLines: DiffLine[] = [];
  const lines = diff.split('\n');
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[2], 10);
      }
      continue;
    }

    if (line.startsWith('+')) {
      diffLines.push({
        type: 'added',
        content: line.substring(1),
        lineNumber: { new: newLineNum++ },
      });
      continue;
    }

    if (line.startsWith('-')) {
      diffLines.push({
        type: 'removed',
        content: line.substring(1),
        lineNumber: { old: oldLineNum++ },
      });
      continue;
    }

    if (line.startsWith(' ')) {
      diffLines.push({
        type: 'unchanged',
        content: line.substring(1),
        lineNumber: { old: oldLineNum++, new: newLineNum++ },
      });
      continue;
    }

    if (line !== '') {
      diffLines.push({
        type: 'unchanged',
        content: line,
        lineNumber: { old: oldLineNum++, new: newLineNum++ },
      });
    }
  }

  return diffLines;
}

function isFileOperation(value: unknown): value is FileOperation {
  return value === FileOperation.Create || value === FileOperation.Update;
}

function getApplyPatchDisplayOperation(
  patchInput: string,
  patchResult: ApplyPatchTuiResult
): FileOperation | undefined {
  if (isFileOperation(patchResult.display_operation)) {
    return patchResult.display_operation;
  }

  if ('diff' in patchResult && typeof patchResult.diff === 'string') {
    return FileOperation.Update;
  }

  return getFileOperationFromPatch(patchInput);
}

function getApplyPatchDiffLines(
  patchInput: string,
  patchResult: ApplyPatchTuiResult
): DiffLine[] {
  const operation = getApplyPatchDisplayOperation(patchInput, patchResult);

  if (operation === FileOperation.Create) {
    return buildCreateDiffLinesFromPatch(patchInput);
  }

  if ('diff' in patchResult && typeof patchResult.diff === 'string') {
    return parseUnifiedDiffToDiffLines(patchResult.diff);
  }

  return [];
}

function getApplyPatchFilePath(
  patchInput: string,
  patchResult: ApplyPatchTuiResult
): string | undefined {
  return patchResult.file_path || extractFilePathFromPatch(patchInput);
}

function getApplyPatchCreatedContent(
  patchInput: string,
  patchResult: ApplyPatchTuiResult
): string {
  if ('content' in patchResult && typeof patchResult.content === 'string') {
    return patchResult.content;
  }

  return buildCreateContentFromPatch(patchInput);
}

function getPendingApplyPatchDisplayOperation(
  patchInput: string,
  filePath: string
): FileOperation | undefined {
  const operation = getFileOperationFromPatch(patchInput);

  if (operation !== FileOperation.Create) {
    return operation;
  }

  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(filePath);
    return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
      ? FileOperation.Update
      : FileOperation.Create;
  } catch {
    return FileOperation.Create;
  }
}

function parseApplyPatchResult(
  result: ToolComponentProps['result']
): ApplyPatchTuiResult | undefined {
  const resultContent = getTextContent(result);
  if (!resultContent) {
    return undefined;
  }

  try {
    return JSON.parse(resultContent) as ApplyPatchTuiResult;
  } catch {
    return undefined;
  }
}

function getDelegatedApplyPatchDisplay(
  props: ToolComponentProps
): ToolDisplayOverride | undefined {
  if (props.isError) {
    return undefined;
  }

  const patchInput = props.input.input;
  if (typeof patchInput !== 'string' || !patchInput) {
    return undefined;
  }

  const inputFilePath = extractFilePathFromPatch(patchInput);
  if (props.result === undefined) {
    if (!inputFilePath) {
      return undefined;
    }

    const pendingOperation = getPendingApplyPatchDisplayOperation(
      patchInput,
      inputFilePath
    );
    if (!pendingOperation) {
      return undefined;
    }

    return {
      toolName: pendingOperation === FileOperation.Create ? 'Create' : 'Edit',
      input: {
        file_path: inputFilePath,
        ...(pendingOperation === FileOperation.Create
          ? { content: buildCreateContentFromPatch(patchInput) }
          : {}),
      },
    };
  }

  const patchResult = parseApplyPatchResult(props.result);
  if (!patchResult?.success) {
    return undefined;
  }

  const operation = getApplyPatchDisplayOperation(patchInput, patchResult);
  const filePath = getApplyPatchFilePath(patchInput, patchResult);
  if (!operation || !filePath) {
    return undefined;
  }

  if (operation === FileOperation.Create) {
    return {
      toolName: 'Create',
      input: {
        file_path: filePath,
        content: getApplyPatchCreatedContent(patchInput, patchResult),
      },
      result: JSON.stringify({
        success: true,
        file_path: filePath,
      }),
    };
  }

  const diffLines = getApplyPatchDiffLines(patchInput, patchResult);
  return {
    toolName: 'Edit',
    input: {
      file_path: filePath,
    },
    result: JSON.stringify({
      success: true,
      file_path: filePath,
      diffLines,
    }),
  };
}

function getApplyPatchOperationText(
  operation: FileOperation | undefined
): string {
  if (operation === FileOperation.Create) {
    return getI18n().t('common:toolDisplay.applyPatch.operationCreated');
  }

  if (operation === FileOperation.Update) {
    return getI18n().t('common:toolDisplay.applyPatch.operationEdited');
  }

  return getI18n().t('common:toolDisplay.applyPatch.operationApplied');
}

// eslint-disable-next-line industry/constants-file-organization
export const ApplyPatchTool: ToolComponent = {
  getHeaderLabel(input: Record<string, unknown>): string {
    const patchInput = input.input as string;
    if (!patchInput) return '';

    const filePath = extractFilePathFromPatch(patchInput);
    if (!filePath) return '';
    const label = truncateFilePath(filePath);
    return label;
  },

  renderPreview(input: Record<string, unknown>) {
    const patchInput = input.input as string;
    if (!patchInput) return null;

    const filePath = extractFilePathFromPatch(patchInput);

    return (
      <Box flexDirection="column">
        {filePath && (
          <Text color={COLORS.text.muted} dimColor>
            {filePath}
          </Text>
        )}
      </Box>
    );
  },

  getDisplayOverride(props: ToolComponentProps) {
    return getDelegatedApplyPatchDisplay(props);
  },

  renderResult({ input, result, isError, contentWidth }: ToolComponentProps) {
    if (!isError && result === undefined) {
      return null;
    }

    const delegatedDisplay = getDelegatedApplyPatchDisplay({
      input,
      result,
      isError,
      contentWidth,
    });
    if (delegatedDisplay?.toolName === 'Create') {
      return CreateTool.renderResult({
        input: delegatedDisplay.input,
        result: delegatedDisplay.result,
        isError,
        contentWidth,
      });
    }
    if (delegatedDisplay?.toolName === 'Edit') {
      return EditTool.renderResult({
        input: delegatedDisplay.input,
        result: delegatedDisplay.result,
        isError,
        contentWidth,
      });
    }
    // Calculate maxWidth from provided contentWidth
    const baseWidth = contentWidth ?? 80;
    const maxWidth = Math.max(baseWidth - 2, 40);

    if (isError) {
      const errorMessage = getToolErrorMessage(
        'ApplyPatch',
        getTextContent(result)
      );
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>↳ {errorMessage}</Text>
        </Box>
      );
    }

    try {
      // Parse the result - it should be an ApplyPatchTuiResult object
      const patchResult: ApplyPatchTuiResult =
        typeof result === 'string' ? JSON.parse(result) : result;

      if (!patchResult.success) {
        const errorMessage = getToolErrorMessage(
          'ApplyPatch',
          getI18n().t('common:toolDisplay.applyPatch.failedToApply')
        );
        return (
          <Box flexDirection="column">
            <Text color={COLORS.text.muted}>↳ {errorMessage}</Text>
          </Box>
        );
      }

      // Get the operation type from the input
      const patchInput = input.input as string;
      const operation = getApplyPatchDisplayOperation(patchInput, patchResult);

      const operationText = getApplyPatchOperationText(operation);
      const diffLines = getApplyPatchDiffLines(patchInput, patchResult);

      // Display the diff if we have one
      if (diffLines.length > 0) {
        const summary = getDiffSummary(diffLines);

        // Apply smart truncation to keep diffs readable
        let truncatedDiff = smartTruncateDiff(diffLines, 2, 4);

        // Further limit for very large diffs
        if (truncatedDiff.length > MAX_DIFF_LINES) {
          const hiddenLines = truncatedDiff.length - MAX_DIFF_LINES;
          truncatedDiff = truncatedDiff.slice(0, MAX_DIFF_LINES);
          truncatedDiff.push({
            type: 'unchanged',
            content: getI18n().t('common:toolDisplay.moreLines', {
              count: hiddenLines,
            }),
          });
        }

        // Format status message similar to Edit/Create tools
        const statusMessage = `↳ ${getI18n().t('common:toolDisplay.applyPatch.succeededFile', { operation: operationText })} ${summary}`;
        const patchFilePath =
          patchResult.file_path || extractFilePathFromPatch(patchInput);

        return (
          <Box flexDirection="column">
            <Text color={COLORS.text.muted}>{statusMessage}</Text>
            <Box flexDirection="column" width={maxWidth}>
              {/* Top horizontal line */}
              <HorizontalLine width={maxWidth} />

              <DiffRenderer
                diffLines={truncatedDiff}
                showLineNumbers
                maxWidth={maxWidth}
                filePath={patchFilePath}
              />

              {/* Bottom horizontal line */}
              <HorizontalLine width={maxWidth} />
            </Box>
          </Box>
        );
      }

      // No diff available, just show success message
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            ↳{' '}
            {getI18n().t('common:toolDisplay.applyPatch.succeededFile', {
              operation: operationText,
            })}
          </Text>
        </Box>
      );
    } catch {
      // Unexpected result format: never echo raw content (may be a bare diff).
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>
            ↳ {getI18n().t('common:toolDisplay.applyPatch.summaryApplied')}
          </Text>
        </Box>
      );
    }
  },

  renderDetailedView({
    input,
    result,
    isError,
    contentWidth,
  }: ToolComponentProps) {
    // For errors, use the regular result rendering
    if (isError) {
      return this.renderResult({ input, result, isError, contentWidth });
    }

    const delegatedDisplay = getDelegatedApplyPatchDisplay({
      input,
      result,
      isError,
      contentWidth,
    });
    if (delegatedDisplay?.toolName === 'Create') {
      return CreateTool.renderDetailedView?.({
        input: delegatedDisplay.input,
        result: delegatedDisplay.result,
        isError,
        contentWidth,
      });
    }
    if (delegatedDisplay?.toolName === 'Edit') {
      return EditTool.renderDetailedView?.({
        input: delegatedDisplay.input,
        result: delegatedDisplay.result,
        isError,
        contentWidth,
      });
    }

    const resultContent = getTextContent(result);
    if (!resultContent) {
      return this.renderResult({ input, result, isError, contentWidth });
    }

    try {
      const patchResult: ApplyPatchTuiResult = JSON.parse(resultContent);
      const patchInput = input.input as string;
      const operation = getApplyPatchDisplayOperation(patchInput, patchResult);

      const diffLines = getApplyPatchDiffLines(patchInput, patchResult);

      if (diffLines.length > 0) {
        const summary = getDiffSummary(diffLines);
        const operationText = getApplyPatchOperationText(operation);
        const statusMessage = `↳ ${getI18n().t('common:toolDisplay.applyPatch.succeededFile', { operation: operationText })} ${summary}`;

        // Calculate maxWidth from provided contentWidth
        const baseWidth = contentWidth ?? 80;
        const maxWidth = Math.max(baseWidth - 2, 40);

        return (
          <Box flexDirection="column">
            <Text color={COLORS.text.muted}>{statusMessage}</Text>
            <Box flexDirection="column" marginY={1} width={maxWidth}>
              {/* Top horizontal line */}
              <HorizontalLine width={maxWidth} color={COLORS.text.muted} />

              <Box paddingLeft={1}>
                <DiffRenderer
                  diffLines={diffLines}
                  maxWidth={maxWidth - 1}
                  filePath={
                    patchResult.file_path ||
                    extractFilePathFromPatch(patchInput)
                  }
                />
              </Box>

              {/* Bottom horizontal line */}
              <HorizontalLine width={maxWidth} color={COLORS.text.muted} />
            </Box>
          </Box>
        );
      }
    } catch {
      // If parsing fails, fallback to regular result
    }

    // Fallback to regular result if no diff data available
    return this.renderResult({ input, result, isError, contentWidth });
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
        return getI18n().t('common:toolDisplay.cancelledByUser');
      }
      return `${getI18n().t('common:toolDisplay.applyPatch.failedToApply')}: ${result}`;
    }

    const delegatedDisplay = getDelegatedApplyPatchDisplay({
      input,
      result,
      isError,
    });
    if (delegatedDisplay?.toolName === 'Create') {
      return CreateTool.getSummaryLine(
        delegatedDisplay.input,
        delegatedDisplay.result ?? '',
        false
      );
    }
    if (delegatedDisplay?.toolName === 'Edit') {
      return EditTool.getSummaryLine(
        delegatedDisplay.input,
        delegatedDisplay.result ?? '',
        false
      );
    }

    try {
      const patchResult: ApplyPatchTuiResult =
        typeof result === 'string' ? JSON.parse(result) : result;

      if (!patchResult.success) {
        return getI18n().t('common:toolDisplay.applyPatch.failedToApply');
      }

      const patchInput = input.input as string;
      const diffLines = getApplyPatchDiffLines(patchInput, patchResult);

      if (diffLines.length > 0) {
        const summary = getDiffSummary(diffLines);
        return getI18n().t('common:toolDisplay.applyPatch.summaryAppliedTo', {
          path: patchResult.file_path,
          summary,
        });
      }

      return getI18n().t(
        'common:toolDisplay.applyPatch.summaryAppliedSuccess',
        { path: patchResult.file_path }
      );
    } catch {
      return getI18n().t('common:toolDisplay.applyPatch.summaryApplied');
    }
  },
};
