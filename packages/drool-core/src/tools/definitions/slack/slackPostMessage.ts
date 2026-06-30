import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import {
  SLACK_POST_MESSAGE_TOOL_ID,
  slackPostMessageSchema,
  slackPostMessageUpdateSchema,
  slackPostMessageResultSchema,
} from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';
import { isSlackAvailable } from '../../utils/get-toolkit-status';

export const slackPostMessageTool = createTool({
  id: SLACK_POST_MESSAGE_TOOL_ID,
  llmId: SLACK_POST_MESSAGE_TOOL_ID,
  uiGroupId: ToolUIGroupId.SlackPostMessage,
  displayName: 'Post Message',
  description:
    'Post a message to a Slack channel (or reply in a thread) using Slack “mrkdwn” formatting. Keep in mind this is different from normal markdown and does not support double wrapping. E.g. ** is wrong, * is correct.\n' +
    'Style: Keep replies to 2–4 sentences; if information is dense, still be as succinct as possible.\n' +
    '\n' +
    'To DM the user directly, set `dmUser: true` and omit `channel`.\n' +
    '\n' +
    'IMPORTANT: The `message` MUST ALREADY be valid Slack mrkdwn. Do NOT send GitHub-style Markdown, Mermaid Diagrams, etc.\n' +
    '\n' +
    'Quick mrkdwn cheat-sheet:\n' +
    '• Bold / emphasis ‑  *text* - DO NOT use **text** as it will not transfer.\n' +
    '• Italic ‑  _text_\n - DO NOT use __text__ as it will not transfer.\n' +
    '• Strikethrough ‑  ~text~\n - DO NOT use ~~text~~ as it will not transfer.\n' +
    '• Inline code ‑  `code`\n' +
    '• Code block ‑  ```lang\\ncode\\n```\n' +
    '• Block quote ‑  line starting with >\n' +
    '• List item ‑  • item   or   1. item - DO NOT use dashes like - as it will not transfer.\n' +
    '• Link ‑  <https://example.com|label>\n' +
    '\n' +
    'Returns Slack’s acknowledgement with channel, timestamp, and message metadata.',
  executionLocation: ToolExecutionLocation.Server,
  inputSchema: slackPostMessageSchema,
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  outputSchemas: {
    updates: slackPostMessageUpdateSchema,
    result: slackPostMessageResultSchema,
  },
  sideEffects: [SandboxSideEffect.ExternalService],
  toolkit: Toolkit.Slack,
  deferred: true,
  isToolEnabled: (params) =>
    isSlackAvailable(params, SLACK_POST_MESSAGE_TOOL_ID).isAvailable,
});
