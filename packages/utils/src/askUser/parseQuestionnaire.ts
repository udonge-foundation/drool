import { MetaError } from '@industry/common/errors';

import type { AskUserParsedQuestionnaire } from './types';
import type { AskUserQuestion } from '@industry/drool-sdk-ext/protocol/drool';

const MAX_QUESTIONS = 10;
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 10;

const QUESTION_RE =
  /^(?:(?:\d+[.)]|[-*•])\s*)?\[question\]\s*(.+?)\s*(?:\(multi\))?\s*$/i;
const IMPLICIT_QUESTION_RE = /^(\d+)[.)]\s+(.+?)\s*$/;
const TOPIC_RE = /^(?:(?:\d+[.)]|[-*•])\s*)?\[topic\]\s*(.+?)\s*$/i;
const OPTION_RE = /^(?:(?:\d+[.)]|[-*•])\s*)?\[option\]\s*(.+?)\s*$/i;
const CODE_FENCE_RE = /```(?:\w+)?\s*([\s\S]*?)```/m;

function normalizeTopic(topic: string): string {
  return topic.trim().replace(/\s+/g, '-');
}

function normalizeQuestionnaire(rawQuestionnaire: string): string {
  const raw = String(rawQuestionnaire ?? '');
  const fenceMatch = raw.match(CODE_FENCE_RE);
  const withoutFence = fenceMatch?.[1] ? fenceMatch[1] : raw;

  const withSplitTags = withoutFence
    .split('\n')
    .map((line) => {
      const isQuestionLine = /^(?:\d+[.)]|[-*•])?\s*\[question\]/i.test(line);
      const hasInlineTags = /\[question\].*\[(topic|option)\]/i.test(line);

      if (!isQuestionLine || !hasInlineTags) {
        return line;
      }

      let result = line.replace(/([.?!])\s+\[(topic)\]/gi, '$1\n[$2]');
      result = result.replace(/([\w)])\s+\[(option)\]/g, '$1\n[$2]');

      return result;
    })
    .join('\n');

  const lines = withSplitTags.split('\n').map((l) => l.replace(/\r$/, ''));
  const filteredLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (/^#+\s/.test(trimmed)) return false;
    if (/^```/.test(trimmed)) return false;
    return true;
  });

  const firstQuestionIndex = filteredLines.findIndex((line) =>
    QUESTION_RE.test(line.trim())
  );

  if (firstQuestionIndex > 0) {
    return filteredLines.slice(firstQuestionIndex).join('\n');
  }

  return filteredLines.join('\n');
}

export function parseAskUserQuestionnaire(
  questionnaire: string
): AskUserParsedQuestionnaire {
  const normalized = normalizeQuestionnaire(questionnaire);
  const lines = normalized.split('\n').map((l) => l.replace(/\r$/, ''));

  const questions: AskUserQuestion[] = [];
  let current: {
    kind: 'explicit' | 'implicit';
    topic?: string;
    question: string;
    options: string[];
    startLine: number;
  } | null = null;

  const finalizeCurrent = () => {
    if (!current) {
      return;
    }

    if (current.options.length === 0) {
      current.options = ['Yes', 'No'];
    }

    const optionCount = current.options.length;
    if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) {
      throw new MetaError('Invalid AskUser questionnaire format', {
        line: String(current.startLine),
        message: `[question] must have ${MIN_OPTIONS}-${MAX_OPTIONS} [option] lines (got ${optionCount})`,
      });
    }

    const seen = new Set<string>();
    for (const opt of current.options) {
      const key = opt.trim().toLowerCase();
      if (seen.has(key)) {
        throw new MetaError('Invalid AskUser questionnaire format', {
          line: String(current.startLine),
          message: `Duplicate option: ${opt}`,
        });
      }
      seen.add(key);
    }

    const topic = current.topic || `Q${questions.length + 1}`;
    questions.push({
      index: questions.length + 1,
      topic,
      question: current.question,
      options: current.options,
    });

    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (!trimmed) {
      continue;
    }

    const qMatch = trimmed.match(QUESTION_RE);
    if (qMatch) {
      finalizeCurrent();

      if (questions.length >= MAX_QUESTIONS) {
        throw new MetaError('Invalid AskUser questionnaire format', {
          line: String(lineNo),
          message: `Maximum ${MAX_QUESTIONS} questions allowed`,
        });
      }

      const qText = (qMatch[1] || '').trim();
      if (!qText) {
        throw new MetaError('Invalid AskUser questionnaire format', {
          line: String(lineNo),
          message: '[question] text is required',
        });
      }

      current = {
        kind: 'explicit',
        question: qText,
        options: [],
        startLine: lineNo,
      };
      continue;
    }

    const tMatch = trimmed.match(TOPIC_RE);
    if (tMatch) {
      if (!current) {
        throw new MetaError('Invalid AskUser questionnaire format', {
          line: String(lineNo),
          message: '[topic] must come after a [question]',
        });
      }

      const topicText = (tMatch[1] || '').trim();
      if (!topicText) {
        throw new MetaError('Invalid AskUser questionnaire format', {
          line: String(lineNo),
          message: '[topic] text is required',
        });
      }

      current.topic = normalizeTopic(topicText);
      continue;
    }

    const oMatch = trimmed.match(OPTION_RE);
    if (oMatch) {
      if (!current) {
        throw new MetaError('Invalid AskUser questionnaire format', {
          line: String(lineNo),
          message: '[option] must come after a [question]',
        });
      }

      const optText = (oMatch[1] || '').trim();
      if (!optText) {
        throw new MetaError('Invalid AskUser questionnaire format', {
          line: String(lineNo),
          message: '[option] text is required',
        });
      }

      if (current.options.length >= MAX_OPTIONS) {
        throw new MetaError('Invalid AskUser questionnaire format', {
          line: String(lineNo),
          message: `Maximum ${MAX_OPTIONS} options per question allowed`,
        });
      }

      current.options.push(optText);
      continue;
    }

    if (
      current &&
      current.kind === 'explicit' &&
      !current.topic &&
      current.options.length === 0
    ) {
      current.question += `\n${trimmed}`;
      continue;
    }

    const implicitMatch = trimmed.match(IMPLICIT_QUESTION_RE);
    if (implicitMatch) {
      let nextLineIndex = i + 1;
      while (nextLineIndex < lines.length && !lines[nextLineIndex].trim()) {
        nextLineIndex++;
      }
      const nextLine = lines[nextLineIndex]?.trim() || '';
      const isFollowedByTaggedLine =
        TOPIC_RE.test(nextLine) || OPTION_RE.test(nextLine);

      if (isFollowedByTaggedLine) {
        finalizeCurrent();

        if (questions.length >= MAX_QUESTIONS) {
          throw new MetaError('Invalid AskUser questionnaire format', {
            line: String(lineNo),
            message: `Maximum ${MAX_QUESTIONS} questions allowed`,
          });
        }

        const qText = (implicitMatch[2] || '').trim();
        current = {
          kind: 'implicit',
          question: qText,
          options: [],
          startLine: lineNo,
        };
      }
    }
  }

  finalizeCurrent();

  if (questions.length === 0) {
    throw new MetaError('Invalid AskUser questionnaire format', {
      line: '1',
      message: 'No [question] entries found',
    });
  }

  return { questions };
}
