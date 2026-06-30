import {
  ToolExecutionLocation,
  TOOL_LLM_ID_DISMISS_HANDOFF_ITEMS,
} from '@industry/drool-sdk-ext/protocol/tools';

import {
  dismissHandoffItemsSchema,
  dismissHandoffItemsResultSchema,
} from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const dismissHandoffItemsTool = createTool({
  id: 'dismiss-handoff-items',
  llmId: TOOL_LLM_ID_DISMISS_HANDOFF_ITEMS,
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'Dismiss Handoff Items',
  description: `Explicitly dismiss items from a worker's handoff. Use sparingly — for tech debt, default to creating follow-up features or update existing feature descriptions.

**Tech debt (discovered_issue, incomplete_work) should almost always be tracked.**

**When to use this tool:**
When a worker returns with discoveredIssues or whatWasLeftUndone, do one of the following before resuming:
1. Take action (create features, set an incomplete feature back to pending with an updated description, etc.)
2. Use this tool to dismiss items with a clear justification

To continue the mission run, you need to take one of these actions before calling start_mission_run again.

**Dismissal rules for tech debt (discovered_issue, incomplete_work):**
Dismiss only if one of these applies:
1. Already tracked as an existing feature (cite the feature ID)
2. Truly irrelevant / a non-issue that will never need to be fixed

Note: "Low priority" or "non-blocking" is not a sufficient reason to dismiss. If it might need fixing later, track it.
Reminder: Skipped work (e.g., skipped manual QA, incomplete verification) is tech debt — please do not dismiss it.

**Justification requirements:**
- Minimum 20 characters
- For tech debt: cite an existing feature ID, or explain why it will never need fixing
- "Will handle later", or "non-blocking" are not sufficient justifications, because all tech debt should be tracked as soon as it is identified.

**Dismissing does not skip the feature.** If the handoff came from a failed or partial feature, that feature has been reset to pending and remains at the top of the queue. Dismissing its handoff items does not change that — it will still be picked again by start_mission_run unless you reorder features.json.

**Dismissing does not notify workers or validators.** Dismissed items are NOT automatically communicated to future workers or validators. If the dismissed context is relevant to them, persist it in the appropriate mission artifacts — e.g., worker-facing guidance in AGENTS.md or a feature description, and milestone validation artifacts (such as the relevant validator synthesis file) for future validators.`,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: dismissHandoffItemsSchema,
  outputSchemas: {
    result: dismissHandoffItemsResultSchema,
  },
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.FilesystemWrite],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
