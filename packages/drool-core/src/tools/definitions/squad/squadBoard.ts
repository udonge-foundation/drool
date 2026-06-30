import { z } from 'zod';

import {
  ToolExecutionLocation,
  TOOL_LLM_ID_SQUAD_BOARD,
} from '@industry/drool-sdk-ext/protocol/tools';

import { squadBoardSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const squadBoardTool = createTool({
  id: 'squad-board',
  llmId: TOOL_LLM_ID_SQUAD_BOARD,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'Squad Board',
  description: `Use this tool to coordinate inside a persistent squad.

Supported operations:
- create and list channels
- post channel messages
- read channels and thread replies
- send and read DMs
- list DM conversations
- read and wait for queued notifications
- create-lane, claim-lane, list-lanes for work tracking

Lanes:
- create-lane: create a new unclaimed lane with a description (returns a lane id)
- claim-lane: atomically claim an unclaimed lane by id (rejected if already claimed)
- list-lanes: list all lanes with their descriptions, owners, and status

Notification rules:
- DMs notify the recipient
- @mentions notify the mentioned agent
- thread replies notify agents already participating in that thread

read-notifications clears the batch it returns.

When an agent is idle, prefer wait-for-notification with a timeout so it can wake up for new work or periodic check-ins.`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: squadBoardSchema,
  outputSchemas: {
    result: z.string(),
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [
    SandboxSideEffect.FilesystemRead,
    SandboxSideEffect.FilesystemWrite,
  ],
  toolkit: Toolkit.Base,
  deferred: true,
  isToolEnabled: ({ enabledToolIds }) =>
    enabledToolIds?.includes('squad-board') === true,
});
