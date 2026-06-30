import {
  ToolExecutionLocation,
  TOOL_LLM_ID_END_FEATURE_RUN,
} from '@industry/drool-sdk-ext/protocol/tools';

import {
  endFeatureRunLlmSchema,
  endFeatureRunSchema,
  endFeatureRunResultSchema,
} from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const endFeatureRunTool = createTool({
  id: 'end-feature-run',
  llmId: TOOL_LLM_ID_END_FEATURE_RUN,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'End Feature Run',
  description: `Report your results and hand off to your teammate. This tool must be called before the worker session exits.

**Required fields:**
- successState: "success", "partial", or "failure"
- returnToOrchestrator: true if orchestrator attention is needed
- handoff: structured handoff information (see below)

**If successState is "success":**
- commitId and repoPath are required if your feature changed repository code.
- validatorsPassed must be true

**The handoff object is REQUIRED and must include:**
- whatWasImplemented: Concrete description of what was built (min 50 characters)
- whatWasLeftUndone: What's incomplete. Must leave empty if everything is truly complete.
- verification: { commandsRun: [{command, exitCode, observation}], interactiveChecks?: [{action, observed}] }
- tests: { added: [{file, cases: [{name, verifies}]}], updated?: [], coverage: "summary" }
- discoveredIssues: Array of {severity, description, suggestedFix?} - empty array if none

**Note:** Critical context for future workers (ports, env vars, gotchas) should be written to the mission library before calling this tool.

**Be specific in observations.** Don't write "tests passed" - write what the output showed. Don't write "checked the form" - write what you clicked and what appeared.

**When to set returnToOrchestrator=true:**
- You encountered a blocker that needs human decision
- The feature scope needs clarification
- You found blocking issues that affect the mission plan
- Implementation revealed unexpected complexity
- No features matching your assigned skill are pending
- Baseline test failed and couldn't be fixed
- Feature is too large and needs splitting
- Previous worker left broken state you can't fix

**Quality requirements before calling with success:**
- Any repository working tree you changed is clean (no uncommitted changes)
- All validators/tests are passing
- Repository code changes are captured in a commit and reported with repoPath
- Handoff is detailed and complete`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: endFeatureRunSchema,
  llmInputSchema: endFeatureRunLlmSchema,
  outputSchemas: {
    result: endFeatureRunResultSchema,
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.FilesystemWrite],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
