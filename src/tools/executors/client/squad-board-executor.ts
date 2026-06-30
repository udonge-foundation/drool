import { z } from 'zod';

import { ToolExecutionErrorType } from '@industry/common/session';
import {
  SquadBoardOperation,
  squadBoardSchema,
  type SquadBoardInput,
} from '@industry/drool-core/tools/definitions';
import { DraftToolFeedbackType } from '@industry/drool-core/tools/enums';
import { ToolAbortError } from '@industry/logging/errors';

import { getSessionService } from '@/services/SessionService';
import { getSquadSessionTagMetadata } from '@/services/squad/sessionTags';
import {
  createSquadChannel,
  formatSquadNotifications,
  listSquadChannels,
  listSquadDmConversations,
  postSquadChannelMessage,
  readSquadChannel,
  readSquadDms,
  readSquadThread,
  replySquadThread,
  sendSquadDm,
  waitForSquadNotification,
} from '@/services/squad/SquadBoardStore';
import {
  claimSquadLane,
  createSquadLane,
  listSquadLanes,
} from '@/services/squad/SquadLaneStore';
import type {
  CliClientSpecificToolDependencies,
  CliClientToolDependencies,
} from '@/tools/types';

import type {
  ClientToolExecutor,
  DraftToolFeedback,
} from '@industry/drool-core/tools/types';

function errorResult(
  llmError: string,
  userError: string
): DraftToolFeedback<string> {
  return {
    type: DraftToolFeedbackType.Result,
    isError: true,
    errorType: ToolExecutionErrorType.InvalidParameterLLMError,
    llmError,
    userError,
  };
}

function getResolvedContext(parameters: SquadBoardInput): {
  squadId: string | undefined;
  callerAgentId: string | undefined;
} {
  const squadMetadata = getSquadSessionTagMetadata(
    getSessionService().getCurrentSessionTags()
  );

  return {
    squadId: parameters.squadId ?? squadMetadata?.squadId,
    callerAgentId: parameters.callerAgentId ?? squadMetadata?.agentId,
  };
}

export class SquadBoardExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: z.infer<typeof squadBoardSchema>
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const { squadId, callerAgentId } = getResolvedContext(parameters);

    if (!squadId) {
      yield errorResult(
        'squadId is required when not running inside a squad session',
        'Squad context is missing.'
      );
      return;
    }

    const requireCaller = new Set<SquadBoardInput['operation']>([
      SquadBoardOperation.PostMessage,
      SquadBoardOperation.SendDm,
      SquadBoardOperation.ReadDms,
      SquadBoardOperation.ListDmConversations,
      SquadBoardOperation.ReplyThread,
      SquadBoardOperation.ReadNotifications,
      SquadBoardOperation.WaitForNotification,
      SquadBoardOperation.CreateLane,
      SquadBoardOperation.ClaimLane,
    ]);

    if (requireCaller.has(parameters.operation) && !callerAgentId) {
      yield errorResult(
        'callerAgentId is required for this squad-board operation',
        'Agent context is missing.'
      );
      return;
    }

    let result: string;

    switch (parameters.operation) {
      case SquadBoardOperation.CreateChannel:
        if (!parameters.channelName) {
          yield errorResult(
            'channelName is required',
            'Channel name is missing.'
          );
          return;
        }
        result = await createSquadChannel({
          squadId,
          channelName: parameters.channelName,
        });
        break;
      case SquadBoardOperation.ListChannels:
        result = await listSquadChannels(squadId);
        break;
      case SquadBoardOperation.PostMessage:
        if (!parameters.channelName || !parameters.content) {
          yield errorResult(
            'channelName and content are required',
            'Channel name or content is missing.'
          );
          return;
        }
        result = await postSquadChannelMessage({
          squadId,
          callerAgentId: callerAgentId!,
          channelName: parameters.channelName,
          content: parameters.content,
        });
        break;
      case SquadBoardOperation.ReadChannel:
        if (!parameters.channelName) {
          yield errorResult(
            'channelName is required',
            'Channel name is missing.'
          );
          return;
        }
        result = await readSquadChannel({
          squadId,
          channelName: parameters.channelName,
        });
        break;
      case SquadBoardOperation.SendDm:
        if (!parameters.targetAgentId || !parameters.content) {
          yield errorResult(
            'targetAgentId and content are required',
            'DM target or content is missing.'
          );
          return;
        }
        result = await sendSquadDm({
          squadId,
          callerAgentId: callerAgentId!,
          targetAgentId: parameters.targetAgentId,
          content: parameters.content,
        });
        break;
      case SquadBoardOperation.ReadDms:
        if (!parameters.targetAgentId) {
          yield errorResult(
            'targetAgentId is required',
            'DM target is missing.'
          );
          return;
        }
        result = await readSquadDms({
          squadId,
          callerAgentId: callerAgentId!,
          targetAgentId: parameters.targetAgentId,
        });
        break;
      case SquadBoardOperation.ListDmConversations:
        result = await listSquadDmConversations({
          squadId,
          callerAgentId: callerAgentId!,
        });
        break;
      case SquadBoardOperation.ReplyThread:
        if (!parameters.parentMessageId || !parameters.content) {
          yield errorResult(
            'parentMessageId and content are required',
            'Thread target or content is missing.'
          );
          return;
        }
        result = await replySquadThread({
          squadId,
          callerAgentId: callerAgentId!,
          parentMessageId: parameters.parentMessageId,
          content: parameters.content,
        });
        break;
      case SquadBoardOperation.ReadThread:
        if (!parameters.parentMessageId) {
          yield errorResult(
            'parentMessageId is required',
            'Thread target is missing.'
          );
          return;
        }
        result = await readSquadThread({
          squadId,
          parentMessageId: parameters.parentMessageId,
        });
        break;
      case SquadBoardOperation.ReadNotifications:
        result = await formatSquadNotifications({
          squadId,
          callerAgentId: callerAgentId!,
        });
        break;
      case SquadBoardOperation.WaitForNotification:
        result = await waitForSquadNotification({
          squadId,
          callerAgentId: callerAgentId!,
          timeoutSeconds: parameters.timeoutSeconds,
          abortSignal: dependencies.abortSignal,
        });
        break;
      case SquadBoardOperation.CreateLane:
        if (!parameters.description) {
          yield errorResult(
            'description is required for create-lane',
            'Lane description is missing.'
          );
          return;
        }
        result = await createSquadLane({
          squadId,
          callerAgentId: callerAgentId!,
          description: parameters.description,
        });
        break;
      case SquadBoardOperation.ClaimLane:
        if (!parameters.laneId) {
          yield errorResult(
            'laneId is required for claim-lane',
            'Lane id is missing.'
          );
          return;
        }
        result = await claimSquadLane({
          squadId,
          callerAgentId: callerAgentId!,
          laneId: parameters.laneId,
        });
        break;
      case SquadBoardOperation.ListLanes:
        result = await listSquadLanes(squadId);
        break;
      default:
        yield errorResult(
          `Unsupported squad-board operation: ${parameters.operation}`,
          'Unsupported squad-board operation.'
        );
        return;
    }

    yield {
      type: DraftToolFeedbackType.Result,
      isError: false,
      value: result,
    };
  }
}
