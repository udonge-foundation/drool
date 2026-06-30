import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import {
  SLACK_POST_FILE_TOOL_ID,
  slackPostFileResultSchema,
  slackPostFileSchema,
  slackPostFileUpdateSchema,
} from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';
import { isSlackAvailable } from '../../utils/get-toolkit-status';

export const slackPostFileTool = createTool({
  id: SLACK_POST_FILE_TOOL_ID,
  llmId: SLACK_POST_FILE_TOOL_ID,
  uiGroupId: ToolUIGroupId.SlackPostFile,
  displayName: 'Post File',
  description:
    'Upload a local file to a Slack channel, thread, or DM. The filePath must point to a file on the machine running Drool.\n' +
    '\n' +
    'To DM the user directly, set `dmUser: true` and omit `channel`.\n' +
    '\n' +
    'If you include `initialComment`, it MUST ALREADY be valid Slack mrkdwn. Do NOT send GitHub-style Markdown, Mermaid Diagrams, etc.\n' +
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
    'Returns Slack’s acknowledgement with channel, file id, filename, and title.',
  executionLocation: ToolExecutionLocation.Server,
  inputSchema: slackPostFileSchema,
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.ExternalService],
  outputSchemas: {
    updates: slackPostFileUpdateSchema,
    result: slackPostFileResultSchema,
  },
  toolkit: Toolkit.Slack,
  deferred: true,
  isToolEnabled: (params) =>
    isSlackAvailable(params, SLACK_POST_FILE_TOOL_ID).isAvailable,
});
