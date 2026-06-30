import { ToolExecutionLocation } from '@industry/drool-sdk-ext/protocol/tools';

import { UPGRADE_SESSION_MODEL_TOOL_ID } from './constants';
import {
  sessionModelUpgradeCliSchema,
  sessionModelUpgradeOutputSchema,
} from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const upgradeSessionModelCliTool = createTool({
  id: UPGRADE_SESSION_MODEL_TOOL_ID,
  llmId: 'UpgradeSessionModel',
  uiGroupId: ToolUIGroupId.Planning,
  displayName: 'Upgrade Session Model',
  description:
    'Switch this session to a more capable model. This affects all subsequent turns.\n\nCall this tool when you catch yourself reasoning any of these phrases:\n- "Let me try a different approach" (on the 2nd attempt at the same problem)\n- "Actually, wait..." / "Hmm, let me..." after something didn\'t work\n- "Let me reconsider" / "I need to rethink this"\n- "This is too slow" / "This isn\'t working" / "more complicated than I thought"\n- "Let me look at this from a different angle / completely different perspective"\n- "I\'m missing something fundamental"\n- "I give up on [approach X]"\n\nMore generally: if you are on your second or third unsuccessful attempt, cycling approaches, or guessing without clear understanding of why a solution should work, upgrade.\n\nAlso call this tool when a system reminder says the current task may require stronger security or vulnerability-analysis reasoning.\n\nCalling this tool is not admitting defeat. It is correct resource allocation -- continuing to thrash on a task your current model cannot solve wastes tokens and produces worse outcomes.',
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: sessionModelUpgradeCliSchema,
  outputSchemas: {
    result: sessionModelUpgradeOutputSchema,
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  toolkit: Toolkit.Base,
  sideEffects: [SandboxSideEffect.PersistentSettings],
  isToolEnabled: true,
});
