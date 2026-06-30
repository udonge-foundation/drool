import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import {
  AskUserOptionsList,
  AskUserTopicNavBar,
} from '@/components/askUser/AskUserQuestionView';
import { ASK_USER_MARKDOWN_CONFIG } from '@/components/askUser/constants';
import type { AskUserAnswerState } from '@/components/askUser/types';
import { COLORS } from '@/components/chat/themedColors';
import { MarkdownText } from '@/components/MarkdownText';
import type { AskUserParsedQuestion } from '@/utils/askUser/types';

interface AskUserReadOnlyPreviewProps {
  questions: AskUserParsedQuestion[];
  questionIndex: number;
  answerStates: Record<number, AskUserAnswerState>;
  width?: number;
}

export function AskUserReadOnlyPreview({
  questions,
  questionIndex,
  answerStates,
  width = 95,
}: AskUserReadOnlyPreviewProps) {
  const { t } = useTranslation();
  const currentQuestion = questions[questionIndex];
  if (!currentQuestion) {
    return null;
  }

  const currentState: AskUserAnswerState = answerStates[questionIndex] || {
    selectedIndex: 0,
    ownAnswer: '',
    isTextInputMode: false,
  };

  const { selectedIndex, isTextInputMode, ownAnswer } = currentState;
  const hasMultipleQuestions = questions.length > 1;
  const questionMaxWidth = Math.max(20, width - 3);

  return (
    <Box flexDirection="column" width={width}>
      <Text color={COLORS.text.muted} bold>
        {t('common:askUser.askUserLabel')}
      </Text>

      {hasMultipleQuestions && (
        <Box marginTop={1}>
          <AskUserTopicNavBar
            questions={questions}
            questionIndex={questionIndex}
            answerStates={answerStates}
          />
        </Box>
      )}

      <Box marginTop={hasMultipleQuestions ? 1 : 0}>
        <MarkdownText
          config={ASK_USER_MARKDOWN_CONFIG}
          maxWidth={questionMaxWidth}
        >
          {currentQuestion.question}
        </MarkdownText>
      </Box>

      <AskUserOptionsList
        options={currentQuestion.options}
        selectedIndex={selectedIndex}
        isTextInputMode={isTextInputMode}
      >
        <Box>
          <Text
            wrap="wrap"
            color={isTextInputMode ? COLORS.primary : COLORS.text.muted}
          >
            {isTextInputMode && ownAnswer
              ? ownAnswer
              : t('common:askUser.typeOwnAnswer')}
          </Text>
        </Box>
      </AskUserOptionsList>
    </Box>
  );
}
