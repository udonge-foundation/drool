import {
  ToolExecutionLocation,
  TOOL_LLM_ID_START_MISSION_RUN,
} from '@industry/drool-sdk-ext/protocol/tools';

import { startMissionRunSchema, startMissionRunResultSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const startMissionRunTool = createTool({
  id: 'start-mission-run',
  llmId: TOOL_LLM_ID_START_MISSION_RUN,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'Start Mission Run',
  description: `Signal that mission initialization is complete and start the runner.

**This is a blocking call.** The tool call remains open while the mission runner executes workers sequentially. It does NOT return immediately — control stays with the runner until a worker handoff warrants orchestrator attention, the user pauses, or all features complete. Do not expect to perform other actions while this call is in flight.

**Preconditions:**
- {missionDir}/validation-contract.md and validation-state.json must exist and be valid
- {missionDir}/features.json must exist with valid features
- {missionDir}/skills/<skillName>/SKILL.md must exist for each skillName used
- {missionDir}/AGENTS.md must exist with mission guidance
- {missionDir}/services.yaml must exist with commands and service definitions
- {missionDir}/init.sh should exist if environment setup is needed

**Effects:**
- Starts the runner which spawns worker sessions sequentially
- The call blocks until: a worker's handoff has actionable items, the user pauses, or all features complete
- On return, includes workerHandoffs with summaries of all work completed since the last run`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: startMissionRunSchema,
  outputSchemas: {
    result: startMissionRunResultSchema,
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.Process],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
