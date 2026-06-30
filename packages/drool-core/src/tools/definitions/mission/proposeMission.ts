import {
  ToolExecutionLocation,
  TOOL_LLM_ID_PROPOSE_MISSION,
} from '@industry/drool-sdk-ext/protocol/tools';

import { proposeMissionSchema, proposeMissionResultSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const proposeMissionTool = createTool({
  id: 'propose-mission',
  llmId: TOOL_LLM_ID_PROPOSE_MISSION,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'Propose Mission',
  description: `Present a mission plan for user review. Use this tool when breaking down a large task into multiple features that will be implemented sequentially by worker sessions.

The proposal should include:
1. **Plan Overview**: High-level description of what the mission will accomplish
2. **Expected Functionality**: Milestones and features, structured for readability
3. **Environment Setup**: Any setup steps needed (dependencies, configuration, etc.)
4. **Infrastructure**: Services, processes, ports, and boundaries (what's allowed/off-limits)
5. **Non-functional Requirements**: Performance, security, or other quality attributes`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: proposeMissionSchema,
  outputSchemas: {
    result: proposeMissionResultSchema,
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: true,
  sideEffects: [SandboxSideEffect.FilesystemWrite],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
