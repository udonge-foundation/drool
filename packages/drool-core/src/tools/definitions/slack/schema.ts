import { z } from 'zod';

export const SLACK_POST_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const SLACK_POST_FILE_TOOL_ID = 'slack_post_file';
export const SLACK_POST_MESSAGE_TOOL_ID = 'slack_post_message';

const SLACK_POST_TARGET_REQUIRED_MESSAGE =
  'Provide a channel ID, or set dmUser: true to DM the user.';

function validateSlackPostTarget(
  data: { channel?: string; dmUser?: boolean },
  ctx: z.RefinementCtx
) {
  if (!data.channel && !data.dmUser) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: SLACK_POST_TARGET_REQUIRED_MESSAGE,
    });
  }
}

function createSlackPostTargetShape({
  channelDescription,
  dmUserDescription,
  threadTsDescription,
}: {
  channelDescription: string;
  dmUserDescription: string;
  threadTsDescription: string;
}) {
  return {
    channel: z.string().optional().describe(channelDescription),
    dmUser: z.boolean().optional().describe(dmUserDescription),
    threadTs: z.string().optional().describe(threadTsDescription),
  };
}

export function getSlackPostFileMetadata(parameters: {
  filePath: string;
  filename?: string;
  title?: string;
}): { filename: string; title: string } {
  const normalizedPath = parameters.filePath.replaceAll('\\', '/');
  const basename = normalizedPath.split('/').filter(Boolean).pop();
  const filename = parameters.filename ?? basename ?? 'upload';
  return {
    filename,
    title: parameters.title ?? filename,
  };
}

export const slackPostMessageSchema = z
  .object({
    message: z
      .string()
      .min(1, 'message must not be empty')
      .describe('The message content to send'),
    ...createSlackPostTargetShape({
      channelDescription:
        'The Slack channel ID to send a message to (e.g., "C365A0B3U8N"). Required unless dmUser is true.',
      dmUserDescription:
        'Set to true to send the message as a DM to the user instead of a channel. When true, channel is not required.',
      threadTsDescription:
        'Optional thread timestamp to reply to an existing thread (e.g., "1234567890.123456")',
    }),
  })
  .superRefine(validateSlackPostTarget);
export const slackPostMessageUpdateSchema = z.string();

export type SlackPostMessageUpdate = z.infer<
  typeof slackPostMessageUpdateSchema
>;

export const slackPostMessageResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  channel: z.string(),
  message: z.object({
    text: z.string(),
    ts: z.string(),
    user: z.string(),
  }),
});

export type SlackPostMessageResult = z.infer<
  typeof slackPostMessageResultSchema
>;

export const slackPostFileSchema = z
  .object({
    filePath: z
      .string()
      .min(1, 'filePath must not be empty')
      .describe(
        'Path to the file on the current machine to upload to Slack. Relative paths resolve from the current working directory.'
      ),
    filename: z
      .string()
      .min(1, 'filename must not be empty')
      .optional()
      .describe(
        'Optional Slack filename. Defaults to the basename of filePath.'
      ),
    title: z
      .string()
      .min(1, 'title must not be empty')
      .optional()
      .describe('Optional display title for the Slack file.'),
    initialComment: z
      .string()
      .min(1, 'initialComment must not be empty')
      .optional()
      .describe(
        'Optional Slack mrkdwn message to post with the uploaded file.'
      ),
    ...createSlackPostTargetShape({
      channelDescription:
        'The Slack channel ID to upload the file to (e.g., "C365A0B3U8N"). Required unless dmUser is true.',
      dmUserDescription:
        'Set to true to upload the file in a DM to the user instead of a channel. When true, channel is not required.',
      threadTsDescription:
        'Optional thread timestamp to upload the file as a reply in an existing thread (e.g., "1234567890.123456")',
    }),
  })
  .superRefine(validateSlackPostTarget);

export const slackPostFileUpdateSchema = z.string();

export type SlackPostFileInput = z.infer<typeof slackPostFileSchema>;

export type SlackPostFileUpdate = z.infer<typeof slackPostFileUpdateSchema>;

export const slackPostFilePrepareResultSchema = z.object({
  ok: z.literal(true),
  uploadUrl: z.string().url(),
  fileId: z.string(),
  channel: z.string(),
  filename: z.string(),
  title: z.string(),
  threadTs: z.string().optional(),
});

export type SlackPostFilePrepareResult = z.infer<
  typeof slackPostFilePrepareResultSchema
>;

export const slackPostFileResultSchema = z.object({
  ok: z.boolean(),
  fileId: z.string(),
  channel: z.string(),
  filename: z.string(),
  title: z.string(),
  threadTs: z.string().optional(),
});

export type SlackPostFileResult = z.infer<typeof slackPostFileResultSchema>;
