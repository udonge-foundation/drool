import { ToolExecutionErrorType } from '@industry/common/session';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { MetaError, ToolAbortError } from '@industry/logging/errors';

import { requestAskUserAnswers } from '@/services/AskUserAnswerStore';
import type {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';
import { parseAskUserQuestionnaire } from '@/utils/askUser/parseQuestionnaire';

import type { AskUserToolInput } from '@industry/drool-core/tools/definitions/cli';
import type {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';

export class AskUserExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: AskUserToolInput
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    let parsed;
    try {
      parsed = parseAskUserQuestionnaire(parameters.questionnaire);
    } catch (error) {
      let message = 'Invalid questionnaire format';
      if (error instanceof MetaError && error.metadata) {
        const { line, message: expected } = error.metadata as {
          line?: string;
          message?: string;
        };
        message =
          `Invalid AskUser questionnaire format at line ${line || '?'}: ${expected || ''}`.trim();
      } else if (error instanceof Error) {
        message = error.message;
      }
      yield this.error(
        ToolExecutionErrorType.InvalidParameterLLMError,
        message,
        'Invalid AskUser parameters'
      );
      return;
    }

    const toolCallId = dependencies.toolCallId;

    // Request answers from UI - this will wait until user completes the questionnaire
    let answers;
    try {
      answers = await requestAskUserAnswers(
        toolCallId,
        parsed.questions,
        dependencies.abortSignal,
        dependencies.sessionId
      );
    } catch (error) {
      if (error instanceof ToolAbortError) {
        throw error;
      }
      yield this.error(
        ToolExecutionErrorType.EnvironmentStateError,
        error instanceof Error ? error.message : 'User cancelled AskUser',
        'AskUser cancelled'
      );
      return;
    }

    if (answers.length !== parsed.questions.length) {
      yield this.error(
        ToolExecutionErrorType.EnvironmentStateError,
        `AskUser collected ${answers.length} answers for ${parsed.questions.length} questions.`,
        'AskUser answers incomplete'
      );
      return;
    }

    const outLines: string[] = [];
    for (const a of answers) {
      outLines.push(`${a.index}. [question] ${a.question}`);
      outLines.push(`[answer] ${a.answer}`);
      outLines.push('');
    }

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: outLines.join('\n').trim(),
    };
  }

  private error(
    errorType: ToolExecutionErrorType,
    llmError: string,
    userError: string
  ): DraftToolFeedback<string> {
    return {
      type: DraftToolFeedbackType.Result,
      isError: true,
      errorType,
      llmError,
      userError,
    };
  }
}
