import { Box, Text } from 'ink';

import type { AskUserAnswerState } from '@/components/askUser/types';
import { COLORS } from '@/components/chat/themedColors';
import type { AskUserParsedQuestion } from '@/utils/askUser/types';

import type React from 'react';

interface AskUserTopicNavBarProps {
  questions: AskUserParsedQuestion[];
  questionIndex: number;
  answerStates: Record<number, AskUserAnswerState>;
}

export function AskUserTopicNavBar({
  questions,
  questionIndex,
  answerStates,
}: AskUserTopicNavBarProps) {
  if (questions.length <= 1) {
    return null;
  }

  return (
    <Box flexDirection="row">
      {questions.map((q, idx) => {
        const isAnswered = !!answerStates[idx]?.submittedAnswer;
        const isCurrent = idx === questionIndex;
        let color = COLORS.text.muted;
        if (isCurrent) {
          color = COLORS.primary;
        } else if (isAnswered) {
          color = COLORS.success;
        }
        const separator = idx < questions.length - 1 ? ' → ' : '';
        return (
          <Text key={idx}>
            <Text color={color} bold={isCurrent}>
              {q.topic}
            </Text>
            <Text color={COLORS.text.muted}>{separator}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

interface AskUserOptionsListProps {
  options: string[];
  selectedIndex: number;
  isTextInputMode: boolean;
  children?: React.ReactNode;
}

export function AskUserOptionsList({
  options,
  selectedIndex,
  isTextInputMode,
  children,
}: AskUserOptionsListProps) {
  return (
    <Box marginTop={1} flexDirection="column">
      {options.map((opt, idx) => {
        const isSelected = !isTextInputMode && idx === selectedIndex;
        return (
          <Box key={`${idx}-${opt}`}>
            <Text
              wrap="wrap"
              color={isSelected ? COLORS.text.primary : COLORS.text.muted}
              bold={isSelected}
            >
              {opt}
            </Text>
          </Box>
        );
      })}
      {children}
    </Box>
  );
}
