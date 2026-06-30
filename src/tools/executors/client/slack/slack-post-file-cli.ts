import fs from 'fs/promises';
import path from 'path';

import { ToolExecutionErrorType } from '@industry/common/session';
import { fetch } from '@industry/drool-core/api/fetch';
import {
  SLACK_POST_FILE_MAX_BYTES,
  getSlackPostFileMetadata,
  slackPostFilePrepareResultSchema,
  slackPostFileResultSchema,
  slackPostFileSchema,
  type SlackPostFileInput,
  type SlackPostFilePrepareResult,
  type SlackPostFileResult,
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

function formatSlackPostFileResult(result: SlackPostFileResult): string {
  const location = result.threadTs
    ? `thread ${result.threadTs} in ${result.channel}`
    : result.channel;
  return `✓ Uploaded ${result.filename} to Slack ${location} (file: ${result.fileId})`;
}

function resolveUploadPath(workingDirectory: string, filePath: string): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workingDirectory, filePath);
}

function invalidParameterResult(
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

export class SlackPostFileCliExecutor
  implements ClientToolExecutor<CliClientSpecificToolDependencies, string>
{
  async *execute(
    dependencies: CliClientToolDependencies,
    parameters: SlackPostFileInput
  ): AsyncGenerator<DraftToolFeedback<string>> {
    if (dependencies.abortSignal?.aborted) {
      throw new ToolAbortError();
    }

    const parsed = slackPostFileSchema.safeParse(parameters);
    if (!parsed.success) {
      yield invalidParameterResult(
        `Invalid parameters: ${JSON.stringify(parsed.error.errors)}`,
        'Invalid Slack file parameters provided'
      );
      return;
    }

    const input = parsed.data;
    const resolvedFilePath = resolveUploadPath(
      dependencies.workingDirectoryFullPath,
      input.filePath
    );

    let fileBytes: Buffer;
    try {
      const stats = await fs.stat(resolvedFilePath);
      if (!stats.isFile()) {
        yield invalidParameterResult(
          'filePath must point to a file',
          'Invalid parameters: filePath must point to a file'
        );
        return;
      }
      if (stats.size <= 0) {
        yield invalidParameterResult(
          'filePath must point to a non-empty file',
          'Invalid parameters: file must not be empty'
        );
        return;
      }
      if (stats.size > SLACK_POST_FILE_MAX_BYTES) {
        yield invalidParameterResult(
          `file exceeds Slack post file limit of ${SLACK_POST_FILE_MAX_BYTES} bytes`,
          'Invalid parameters: file is too large to upload to Slack'
        );
        return;
      }

      fileBytes = await fs.readFile(resolvedFilePath);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      yield invalidParameterResult(
        `Could not read filePath: ${errorMessage}`,
        'Invalid parameters: file could not be read'
      );
      return;
    }

    const { filename, title } = getSlackPostFileMetadata(input);

    try {
      const basePayload = {
        ...input,
        filename,
        title,
        sessionId: dependencies.sessionId,
        toolCallId: dependencies.toolCallId,
        toolMessageId: dependencies.toolMessageId,
      };

      const prepareResponse = await fetch(
        '/api/tools/slack/post-file',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...basePayload,
            operation: 'prepare',
            length: fileBytes.length,
          }),
        },
        getIndustryApiConfig()
      );

      const prepareResult = await prepareResponse.json();
      if (prepareResult.isError) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType:
            prepareResult.errorType || ToolExecutionErrorType.ExternalAPIError,
          llmError:
            prepareResult.llmError || 'Failed to prepare Slack file upload',
          userError: prepareResult.userError || 'Slack file upload failed',
        };
        return;
      }

      const prepared = slackPostFilePrepareResultSchema.parse(
        prepareResult.value
      ) satisfies SlackPostFilePrepareResult;

      const uploadResponse = await fetch(prepared.uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fileBytes.length),
        },
        body: fileBytes,
      });

      if (!uploadResponse.ok) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType: ToolExecutionErrorType.ExternalAPIError,
          llmError: `Slack file byte upload failed with status ${uploadResponse.status}`,
          userError: 'Failed to upload file bytes to Slack',
        };
        return;
      }

      const completeResponse = await fetch(
        '/api/tools/slack/post-file',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...basePayload,
            channel: prepared.channel,
            dmUser: undefined,
            operation: 'complete',
            fileId: prepared.fileId,
          }),
        },
        getIndustryApiConfig()
      );

      const completeResult = await completeResponse.json();
      if (completeResult.isError) {
        yield {
          type: DraftToolFeedbackType.Result,
          isError: true,
          errorType:
            completeResult.errorType || ToolExecutionErrorType.ExternalAPIError,
          llmError:
            completeResult.llmError || 'Failed to complete Slack file upload',
          userError: completeResult.userError || 'Slack file upload failed',
        };
        return;
      }

      const result = slackPostFileResultSchema.parse(completeResult.value);

      yield {
        type: DraftToolFeedbackType.Result,
        isError: false,
        value: formatSlackPostFileResult(result),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      yield {
        type: DraftToolFeedbackType.Result,
        isError: true,
        errorType: ToolExecutionErrorType.ExternalAPIError,
        llmError: `Error uploading Slack file: ${errorMessage}`,
        userError: 'Failed to upload file to Slack',
      };
    }
  }
}
