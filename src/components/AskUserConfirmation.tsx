import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AskUserOptionsList,
  AskUserTopicNavBar,
} from '@/components/askUser/AskUserQuestionView';
import { ASK_USER_MARKDOWN_CONFIG } from '@/components/askUser/constants';
import type { AskUserAnswerState } from '@/components/askUser/types';
import { COLORS } from '@/components/chat/themedColors';
import { TextInput } from '@/components/common/TextInput';
import { MarkdownText } from '@/components/MarkdownText';
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import type { KeyEvent } from '@/contexts/types';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import type { AskUserCollectedAnswer } from '@/services/askUser/types';

type AskUserQuestion = {
  index: number;
  topic: string;
  question: string;
  options: string[];
};

interface AskUserConfirmationProps {
  questions: AskUserQuestion[];
  parseError?: { message: string; line?: number };
  onComplete: (answers: AskUserCollectedAnswer[]) => void;
  onCancel: () => void;
  isFocused?: boolean;
  width?: number;
  questionIndex?: number;
  onQuestionIndexChange?: (index: number) => void;
  answerStates?: Record<number, AskUserAnswerState>;
  onAnswerStatesChange?: (states: Record<number, AskUserAnswerState>) => void;
}

export function AskUserConfirmation({
  questions,
  parseError,
  onComplete,
  onCancel,
  isFocused = true,
  width = 95,
  questionIndex: controlledQuestionIndex,
  onQuestionIndexChange: controlledSetQuestionIndex,
  answerStates: controlledAnswerStates,
  onAnswerStatesChange: controlledSetAnswerStates,
}: AskUserConfirmationProps) {
  const { t, i18n } = useTranslation();
  const keypressProvider = useKeypressProvider();

  const [internalQuestionIndex, setInternalQuestionIndex] = useState(0);
  const [internalAnswerStates, setInternalAnswerStates] = useState<
    Record<number, AskUserAnswerState>
  >({});

  const questionIndex = controlledQuestionIndex ?? internalQuestionIndex;
  const setQuestionIndex =
    controlledSetQuestionIndex ?? setInternalQuestionIndex;
  const answerStates = controlledAnswerStates ?? internalAnswerStates;
  const setAnswerStates = controlledSetAnswerStates ?? setInternalAnswerStates;

  const currentQuestion = questions[questionIndex];

  // Get current question's state or default
  const currentState = useMemo(
    (): AskUserAnswerState =>
      answerStates[questionIndex] || {
        selectedIndex: 0,
        ownAnswer: '',
        isTextInputMode: false,
      },
    [answerStates, questionIndex]
  );

  const { selectedIndex, ownAnswer, isTextInputMode } = currentState;
  const hasMultipleQuestions = questions.length > 1;
  const questionMaxWidth = Math.max(20, width - 3);

  // Update state for current question
  const updateCurrentState = useCallback(
    (updates: Partial<AskUserAnswerState>) => {
      setAnswerStates({
        ...answerStates,
        [questionIndex]: { ...currentState, ...updates },
      });
    },
    [answerStates, questionIndex, currentState, setAnswerStates]
  );

  // Submit answer for current question and advance or complete
  const submitAnswer = useCallback(
    (answerText: string) => {
      // Check if this is a custom answer (not in the options list)
      const isCustomAnswer = !currentQuestion.options.includes(answerText);
      const selectedOptionIndex = currentQuestion.options.indexOf(answerText);

      const newStates = {
        ...answerStates,
        [questionIndex]: {
          selectedIndex: isCustomAnswer ? 0 : selectedOptionIndex,
          submittedAnswer: answerText,
          isTextInputMode: isCustomAnswer,
          ownAnswer: isCustomAnswer ? answerText : '',
        },
      };
      setAnswerStates(newStates);

      // Check if all questions answered after this submission
      const allDone = questions.every(
        (_, idx) => newStates[idx]?.submittedAnswer
      );

      if (allDone) {
        const collectedAnswers: AskUserCollectedAnswer[] = questions.map(
          (q, idx) => ({
            index: q.index,
            question: q.question,
            answer: newStates[idx]?.submittedAnswer || '',
          })
        );
        onComplete(collectedAnswers);
        return;
      }

      // Find next unanswered question
      for (let i = 1; i <= questions.length; i++) {
        const nextIdx = (questionIndex + i) % questions.length;
        if (!newStates[nextIdx]?.submittedAnswer) {
          setQuestionIndex(nextIdx);
          return;
        }
      }
    },
    [answerStates, currentQuestion, onComplete, questionIndex, questions]
  );

  // Navigate to next question (Tab)
  const goToNextQuestion = useCallback(() => {
    setQuestionIndex((questionIndex + 1) % questions.length);
  }, [questionIndex, questions.length, setQuestionIndex]);

  // Navigate to previous question (Shift+Tab)
  const goToPrevQuestion = useCallback(() => {
    setQuestionIndex((questionIndex - 1 + questions.length) % questions.length);
  }, [questionIndex, questions.length, setQuestionIndex]);

  const handleOptionsInput = useCallback(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
      }
    ) => {
      if (!currentQuestion) {
        return;
      }

      const optionCount = currentQuestion.options.length;
      const maxIndex = optionCount - 1;

      if (key.upArrow) {
        updateCurrentState({
          selectedIndex: selectedIndex > 0 ? selectedIndex - 1 : maxIndex,
        });
        return;
      }

      if (key.downArrow) {
        if (selectedIndex === maxIndex) {
          updateCurrentState({ isTextInputMode: true });
        } else {
          updateCurrentState({ selectedIndex: selectedIndex + 1 });
        }
        return;
      }

      if (key.return) {
        submitAnswer(currentQuestion.options[selectedIndex]);
        return;
      }

      // Start typing in text input when user types a character
      if (input && !key.upArrow && !key.downArrow && !key.return) {
        updateCurrentState({ isTextInputMode: true, ownAnswer: input });
      }
    },
    [currentQuestion, selectedIndex, submitAnswer, updateCurrentState]
  );

  const handleTextInputSubmit = useCallback(() => {
    const trimmed = ownAnswer.trim();
    if (trimmed) {
      submitAnswer(trimmed);
    }
  }, [ownAnswer, submitAnswer]);

  const handleInput = useCallback(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        tab?: boolean;
        shift?: boolean;
      }
    ) => {
      if (parseError) {
        if (key.escape || key.return) {
          onCancel();
        }
        return;
      }

      if (!currentQuestion) {
        onCancel();
        return;
      }

      // Tab navigation between questions
      if (key.tab) {
        if (hasMultipleQuestions) {
          if (key.shift) {
            goToPrevQuestion();
          } else {
            goToNextQuestion();
          }
        }
        return;
      }

      // ESC cancels the entire Q&A session
      if (key.escape) {
        onCancel();
        return;
      }

      // When in text input mode, allow ↑ to return to options
      if (isTextInputMode) {
        if (key.upArrow) {
          updateCurrentState({
            isTextInputMode: false,
            selectedIndex: Math.max(0, currentQuestion.options.length - 1),
          });
        }
        return;
      }

      handleOptionsInput(input, key);
    },
    [
      currentQuestion,
      goToNextQuestion,
      goToPrevQuestion,
      handleOptionsInput,
      hasMultipleQuestions,
      isTextInputMode,
      onCancel,
      parseError,
      updateCurrentState,
    ]
  );

  useEffect(() => {
    if (!isFocused || !keypressProvider.isEnabled) {
      return;
    }

    const handler = (event: KeyEvent) => {
      handleInput(event.input, event.key);
    };

    keypressProvider.subscribe(handler);
    return () => {
      keypressProvider.unsubscribe(handler);
    };
  }, [handleInput, isFocused, keypressProvider]);

  useKeypressHandler(handleInput, {
    isActive: isFocused && !keypressProvider.isEnabled,
  });

  if (parseError) {
    return (
      <Box flexDirection="column" width={width}>
        <Text color={COLORS.error}>
          {t('common:askUser.invalidQuestionnaire')}
        </Text>
        <Text color={COLORS.text.muted}>
          {parseError.line
            ? t('common:askUser.linePrefix', { line: parseError.line })
            : ''}
          {parseError.message}
        </Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:askUser.escToCancel')}
          </Text>
        </Box>
      </Box>
    );
  }

  if (!currentQuestion) {
    return null;
  }

  const helpOptionsResourceKey = hasMultipleQuestions
    ? 'askUser.helpOptionsMultiple'
    : 'askUser.helpOptionsSingle';
  const localizedHelpOptions = i18n.getResource(
    i18n.resolvedLanguage ?? i18n.language,
    'common',
    helpOptionsResourceKey
  );
  const optionsHelpText =
    typeof localizedHelpOptions === 'string'
      ? localizedHelpOptions
      : t('common:askUser.helpOptions');

  return (
    <Box flexDirection="column" width={width}>
      <AskUserTopicNavBar
        questions={questions}
        questionIndex={questionIndex}
        answerStates={answerStates}
      />

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
          <TextInput
            focus={isTextInputMode}
            showCursor
            value={ownAnswer}
            onChange={(val) => updateCurrentState({ ownAnswer: val })}
            onSubmit={handleTextInputSubmit}
            placeholder={t('common:askUser.typeOwnAnswer')}
          />
        </Box>
      </AskUserOptionsList>

      <Box marginTop={1}>
        <Text color={COLORS.text.muted}>
          {isTextInputMode
            ? t('common:askUser.helpTextInput')
            : optionsHelpText}
        </Text>
      </Box>
    </Box>
  );
}
