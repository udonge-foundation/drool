import { Text, Box } from 'ink';

import { COLORS } from '@/components/chat/themedColors';
import {
  ToolComponent,
  ToolComponentProps,
} from '@/components/tools/registry/types';
import { getI18n } from '@/i18n';
import { getTextContent } from '@/utils/tool-result-helpers';

const DEFAULT_CONTENT_WIDTH = 80;
const PREVIEW_CHROME_WIDTH = 6;
const MIN_PREVIEW_LINE_LENGTH = 20;
const SINGLE_ANSWER_INDENT = '  ';
const MULTI_ANSWER_INDENT = '   ';

interface ParsedQA {
  question: string;
  answer: string;
}

function parseQAFromResult(result: string): ParsedQA[] {
  const lines = result.split('\n');
  const qaList: ParsedQA[] = [];
  let currentQuestion = '';
  let currentAnswer = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match question lines like "1. [question] What is..."
    const questionMatch = trimmed.match(/^\d+\.\s*\[question\]\s*(.+)/i);
    if (questionMatch) {
      // Save previous QA if exists
      if (currentQuestion && currentAnswer) {
        qaList.push({ question: currentQuestion, answer: currentAnswer });
      }
      currentQuestion = questionMatch[1];
      currentAnswer = '';
      continue;
    }

    // Match answer lines like "[answer] TypeScript"
    const answerMatch = trimmed.match(/^\[answer\]\s*(.+)/i);
    if (answerMatch) {
      currentAnswer = answerMatch[1];
    }
  }

  // Save last QA
  if (currentQuestion && currentAnswer) {
    qaList.push({ question: currentQuestion, answer: currentAnswer });
  }

  return qaList;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength - 3)}...`;
}

function getPreviewLineLength(
  contentWidth: number | undefined,
  prefixLength: number
): number {
  return Math.max(
    MIN_PREVIEW_LINE_LENGTH,
    (contentWidth ?? DEFAULT_CONTENT_WIDTH) -
      PREVIEW_CHROME_WIDTH -
      prefixLength
  );
}

function AskUserQAList({
  qaList,
  contentWidth,
  shouldTruncate,
}: {
  qaList: ParsedQA[];
  contentWidth?: number;
  shouldTruncate: boolean;
}) {
  const showQuestionNumbers = qaList.length > 1;

  return (
    <Box flexDirection="column">
      {qaList.map((qa, idx) => {
        const questionPrefix = showQuestionNumbers ? `${idx + 1}. ` : '';
        const answerIndent = showQuestionNumbers
          ? MULTI_ANSWER_INDENT
          : SINGLE_ANSWER_INDENT;
        const question = shouldTruncate
          ? truncateText(
              qa.question,
              getPreviewLineLength(contentWidth, questionPrefix.length)
            )
          : qa.question;
        const answer = shouldTruncate
          ? truncateText(
              qa.answer,
              getPreviewLineLength(contentWidth, answerIndent.length)
            )
          : qa.answer;

        return (
          <Box
            key={idx}
            flexDirection="column"
            marginBottom={idx < qaList.length - 1 ? 1 : 0}
          >
            <Box flexDirection="row" flexWrap="wrap">
              {showQuestionNumbers && (
                <Text color={COLORS.text.muted}>{questionPrefix}</Text>
              )}
              <Text>{question}</Text>
            </Box>
            <Box flexDirection="row" flexWrap="wrap">
              <Text color={COLORS.text.muted}>{answerIndent}</Text>
              <Text color={COLORS.success}>{answer}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// eslint-disable-next-line industry/constants-file-organization
export const AskUserTool: ToolComponent = {
  getHeaderLabel(_input: Record<string, unknown>): string {
    return '';
  },

  renderDetailedView({ result, isError }: ToolComponentProps) {
    const resultText = getTextContent(result);

    if (isError) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{resultText}</Text>
        </Box>
      );
    }

    const qaList = parseQAFromResult(resultText);

    if (qaList.length === 0) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>↳ {resultText}</Text>
        </Box>
      );
    }

    return <AskUserQAList qaList={qaList} shouldTruncate={false} />;
  },

  renderResult({ result, isError, contentWidth }: ToolComponentProps) {
    const resultText = getTextContent(result);

    if (isError) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.error}>{resultText}</Text>
        </Box>
      );
    }

    if (!resultText || resultText.trim() === '') {
      return null;
    }

    const qaList = parseQAFromResult(resultText);

    if (qaList.length === 0) {
      return (
        <Box flexDirection="column">
          <Text color={COLORS.text.muted}>↳ {resultText}</Text>
        </Box>
      );
    }

    return (
      <AskUserQAList
        qaList={qaList}
        contentWidth={contentWidth}
        shouldTruncate
      />
    );
  },

  getSummaryLine(
    _input: Record<string, unknown>,
    result: string,
    isError: boolean
  ): string {
    if (isError) {
      return result;
    }

    const qaList = parseQAFromResult(result);
    if (qaList.length === 0) {
      return getI18n().t('common:toolDisplay.askUser.noAnswers');
    }

    return getI18n().t('common:toolDisplay.askUser.summaryCollected', {
      count: qaList.length,
      suffix: qaList.length !== 1 ? 's' : '',
    });
  },
};
