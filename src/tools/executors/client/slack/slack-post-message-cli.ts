import { z } from 'zod';

import { ToolExecutionErrorType } from '@industry/common/session';
import { fetch } from '@industry/drool-core/api/fetch';
import {
  slackPostMessageSchema,
  type SlackPostMessageResult,
} from '@industry/drool-core/tools/definitions/slack';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';
import { ToolAbortError } from '@industry/logging/errors';

import { getIndustryApiConfig } from '@/api/config';
import {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

function formatSlackPostResult(
  result: SlackPostMessageResult,
  target: string,
  threadTs?: string
): string {
  if (!result.ok) {
    return `Failed to post Slack message to ${target}`;
  }

  const action = threadTs ? 'Posted reply to thread in' : 'Posted message to';
  return `✓ ${action} ${target} (ts: ${result.ts})`;
}

export class SlackPostMessageCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: z.infer<typeof slackPostMessageSchema>
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { channel, dmUser, message, threadTs } = parameters;

    if (!message) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'message parameter is required',
        userError: 'Invalid parameters: message is required',
      };
      return;
    }

    if (!channel && !dmUser) {
      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.InvalidParameterLLMError,
        llmError: 'Provide a channel ID, or set dmUser: true to DM the user.',
        userError: 'Invalid parameters: either channel or dmUser is required',
      };
      return;
    }

    try {
      // Call backend API with session identifiers for proper guardrail enforcement
      const payload = {
        ...parameters,
        sessionId: dependencies.sessionId,
        toolCallId: dependencies.toolCallId,
        toolMessageId: dependencies.toolMessageId,
      };

      const response = await fetch(
        '/api/tools/slack/post-message',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        getIndustryApiConfig()
      );

      const result = await response.json();

      // Check if result indicates error
      if (result.isError) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType:
            result.errorType || ToolExecutionErrorType.ExternalAPIError,
          llmError: result.llmError || 'Failed to post Slack message',
          userError: result.userError || 'Slack post failed',
        };
        return;
      }

      const target = dmUser ? 'DM' : channel!;
      const formattedResult = formatSlackPostResult(
        result.value,
        target,
        threadTs
      );

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: formattedResult,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ExternalAPIError,
        llmError: `Error posting Slack message: ${errorMessage}`,
        userError: 'Failed to post to Slack',
      };
    }
  }
}
