export const NO_MATCHES_FOUND = 'No matches found';
export const NO_MATCHING_FILES_FOUND = 'No matching files found';

/**
 * Tool LLM ID constants
 * These are the canonical llmId values used across all tool definitions.
 * These constants should be imported by both tool definitions and UI components.
 */

// File system tools
export const TOOL_LLM_ID_LS = 'LS';
export const TOOL_LLM_ID_READ = 'Read';
export const TOOL_LLM_ID_CREATE = 'Create';
export const TOOL_LLM_ID_EDIT = 'Edit';
const TOOL_LLM_ID_MULTI_EDIT = 'MultiEdit';
export const TOOL_LLM_ID_APPLY_PATCH = 'ApplyPatch';

// Search tools
export const TOOL_LLM_ID_GLOB = 'Glob';
export const TOOL_LLM_ID_GREP = 'Grep';

// Execution tools
export const TOOL_LLM_ID_EXECUTE = 'Execute';

// Task management
export const TOOL_LLM_ID_TODO_WRITE = 'TodoWrite';

// User interaction
export const TOOL_LLM_ID_ASK_USER = 'AskUser';

// Web tools
export const TOOL_LLM_ID_WEB_SEARCH = 'WebSearch';
export const TOOL_LLM_ID_FETCH_URL = 'FetchUrl';

// IDE tools
const TOOL_LLM_ID_GET_IDE_DIAGNOSTICS = 'getIdeDiagnostics';

// Spec mode tools
export const TOOL_LLM_ID_EXIT_SPEC_MODE = 'ExitSpecMode';

// Mission decomposition tools
export const TOOL_LLM_ID_PROPOSE_MISSION = 'ProposeMission';
export const TOOL_LLM_ID_START_MISSION_RUN = 'StartMissionRun';
const TOOL_LLM_ID_SELECT_FEATURE = 'SelectFeature';
export const TOOL_LLM_ID_END_FEATURE_RUN = 'EndFeatureRun';
export const TOOL_LLM_ID_DISMISS_HANDOFF_ITEMS = 'DismissHandoffItems';

// Tools that stream proposal content before requesting confirmation.
export const TOOL_LLM_IDS_WITH_PROPOSAL_CONFIRMATION = [
  TOOL_LLM_ID_EXIT_SPEC_MODE,
  TOOL_LLM_ID_PROPOSE_MISSION,
] as const;

// Connectors tools
export const TOOL_LLM_ID_CONNECTOR_SEARCH = 'ConnectorSearch';

// Squad tools
export const TOOL_LLM_ID_SQUAD_BOARD = 'squad-board';

// Other tools
const TOOL_LLM_ID_TASK = 'Task';

/**
 * Tool IDs safe to re-run after a daemon respawn. AskUser/ExitSpecMode/
 * ProposeMission only re-prompt the user; Task re-attaches to its already
 * spawned child session (via the persisted Task invocation) instead of
 * starting new work, so a paused parent can recover an in-flight subagent.
 */
export const RESUMABLE_TOOL_LLM_IDS: readonly string[] = [
  TOOL_LLM_ID_ASK_USER,
  TOOL_LLM_ID_EXIT_SPEC_MODE,
  TOOL_LLM_ID_PROPOSE_MISSION,
  TOOL_LLM_ID_TASK,
];

/**
 * Tool display names for UI rendering
 * Maps tool LLM IDs to human-readable display names
 * These should match the displayName values in tool definitions
 */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  [TOOL_LLM_ID_LS]: 'LS',
  [TOOL_LLM_ID_READ]: 'Read',
  [TOOL_LLM_ID_CREATE]: 'Create',
  [TOOL_LLM_ID_EDIT]: 'Edit',
  [TOOL_LLM_ID_MULTI_EDIT]: 'Multi Edit',
  [TOOL_LLM_ID_APPLY_PATCH]: 'Apply Patch',
  [TOOL_LLM_ID_GLOB]: 'Glob',
  [TOOL_LLM_ID_GREP]: 'Grep',
  [TOOL_LLM_ID_EXECUTE]: 'Execute',
  [TOOL_LLM_ID_TODO_WRITE]: 'Plan',
  [TOOL_LLM_ID_ASK_USER]: 'Ask User',
  [TOOL_LLM_ID_WEB_SEARCH]: 'Web Search',
  [TOOL_LLM_ID_FETCH_URL]: 'Fetch URL',
  [TOOL_LLM_ID_GET_IDE_DIAGNOSTICS]: 'Get IDE Diagnostics',
  [TOOL_LLM_ID_EXIT_SPEC_MODE]: 'Propose Specification',
  [TOOL_LLM_ID_PROPOSE_MISSION]: 'Propose Mission',
  [TOOL_LLM_ID_START_MISSION_RUN]: 'Start Mission Run',
  [TOOL_LLM_ID_SELECT_FEATURE]: 'Select Feature',
  [TOOL_LLM_ID_END_FEATURE_RUN]: 'End Feature Run',
  [TOOL_LLM_ID_DISMISS_HANDOFF_ITEMS]: 'Dismiss Handoff Items',
  [TOOL_LLM_ID_SQUAD_BOARD]: 'Squad Board',
  [TOOL_LLM_ID_TASK]: 'Subagent',
  [TOOL_LLM_ID_CONNECTOR_SEARCH]: 'Connectors',
};
