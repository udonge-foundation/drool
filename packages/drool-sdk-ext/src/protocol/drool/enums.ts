// Tool confirmation outcome options (possible user responses to permission requests)
export enum ToolConfirmationOutcome {
  ProceedOnce = 'proceed_once',
  ProceedAlways = 'proceed_always',
  /** Like ProceedAlways, but persists the exact file path instead of its parent directory. */
  ProceedAlwaysForExactPath = 'proceed_always_file',
  ProceedAutoRun = 'proceed_auto_run',
  ProceedAutoRunLow = 'proceed_auto_run_low',
  ProceedAutoRunMedium = 'proceed_auto_run_medium',
  ProceedAutoRunHigh = 'proceed_auto_run_high',
  ProceedNewSession = 'proceed_new_session',
  ProceedNewSessionLow = 'proceed_new_session_low',
  ProceedNewSessionMedium = 'proceed_new_session_medium',
  ProceedNewSessionHigh = 'proceed_new_session_high',
  ProceedEdit = 'proceed_edit',
  /** MCP: Persist approval for specific tool(s) across sessions */
  ProceedAlwaysTools = 'proceed_always_tools',
  /** MCP: Persist approval for all tools from a server across sessions */
  ProceedAlwaysServer = 'proceed_always_server',
  Cancel = 'cancel',
}

// Tool confirmation type (which tool is requesting permission)
export enum ToolConfirmationType {
  Edit = 'edit',
  Execute = 'exec',
  Create = 'create',
  AskUser = 'ask_user',
  ExitSpecMode = 'exit_spec_mode',
  ProposeMission = 'propose_mission',
  StartMissionRun = 'start_mission_run',
  ApplyPatch = 'apply_patch',
  McpTool = 'mcp_tool',
  SandboxViolation = 'sandbox_violation',
}

// Sandbox violation type (what kind of access was blocked)
export enum SandboxViolationType {
  FilesystemRead = 'filesystem-read',
  FilesystemWrite = 'filesystem-write',
  Network = 'network',
  /** Tool policy violations: unknown tool, missing/unhandled side-effect metadata */
  Tool = 'tool',
}

// Sandbox violation reason (why the access was denied)
export enum SandboxViolationReason {
  DenyList = 'deny-list',
  NotAllowed = 'not-allowed',
}

// Sandbox operation type (the type of operation that was blocked)
export enum SandboxOperationType {
  Read = 'read',
  Write = 'write',
  Network = 'network',
  /** Tool-level policy denial; see SandboxViolationType.Tool. */
  Tool = 'tool',
}

// Drool server methods (client to server communication)
export enum DroolServerMethod {
  INITIALIZE_SESSION = 'drool.initialize_session',
  LOAD_SESSION = 'drool.load_session',
  ADD_USER_MESSAGE = 'drool.add_user_message',
  RESOLVE_QUEUED_USER_MESSAGE = 'drool.resolve_queued_user_message',
  CLOSE_SESSION = 'drool.close_session',
  INTERRUPT_SESSION = 'drool.interrupt_session',
  KILL_WORKER_SESSION = 'drool.kill_worker_session',
  UPDATE_SESSION_SETTINGS = 'drool.update_session_settings',
  // MCP server management
  TOGGLE_MCP_SERVER = 'drool.toggle_mcp_server',
  AUTHENTICATE_MCP_SERVER = 'drool.authenticate_mcp_server',
  CANCEL_MCP_AUTH = 'drool.cancel_mcp_auth',
  CLEAR_MCP_AUTH = 'drool.clear_mcp_auth',
  ADD_MCP_SERVER = 'drool.add_mcp_server',
  REMOVE_MCP_SERVER = 'drool.remove_mcp_server',
  LIST_MCP_REGISTRY = 'drool.list_mcp_registry',
  LIST_MCP_TOOLS = 'drool.list_mcp_tools',
  LIST_TOOLS = 'drool.list_tools',
  LIST_MCP_SERVERS = 'drool.list_mcp_servers',
  TOGGLE_MCP_TOOL = 'drool.toggle_mcp_tool',
  SUBMIT_MCP_AUTH_CODE = 'drool.submit_mcp_auth_code',
  SUBMIT_MCP_AUTH_ERROR = 'drool.submit_mcp_auth_error',
  // Skills
  LIST_SKILLS = 'drool.list_skills',
  // Custom slash commands
  LIST_COMMANDS = 'drool.list_commands',
  // Bug reports
  SUBMIT_BUG_REPORT = 'drool.submit_bug_report',
  // Rewind
  GET_REWIND_INFO = 'drool.get_rewind_info',
  EXECUTE_REWIND = 'drool.execute_rewind',
  // Compaction
  COMPACT_SESSION = 'drool.compact_session',
  // Fork
  FORK_SESSION = 'drool.fork_session',
  // Rename
  RENAME_SESSION = 'drool.rename_session',
  // Context stats
  GET_CONTEXT_STATS = 'drool.get_context_stats',
  // Detailed context breakdown for the /context modal
  GET_CONTEXT_BREAKDOWN = 'drool.get_context_breakdown',
  // Cache warmup
  WARMUP_CACHE = 'drool.warmup_cache',
}

export enum QueuePlacement {
  EndOfTurn = 'end_of_turn',
  EndOfLoop = 'end_of_loop',
}

export enum ResolveQueuedUserMessageAction {
  UpdateQueue = 'update_queue',
  Delete = 'delete',
}

// Drool client methods (server to client communication)
export enum DroolClientMethod {
  SESSION_NOTIFICATION = 'drool.session_notification',
  REQUEST_PERMISSION = 'drool.request_permission',
  ASK_USER = 'drool.ask_user',
}

// Session notification types
export enum SessionNotificationType {
  TOOL_RESULT = 'tool_result',
  TOOL_PROGRESS_UPDATE = 'tool_progress_update',
  CREATE_MESSAGE = 'create_message',
  ERROR = 'error',
  DROOL_WORKING_STATE_CHANGED = 'drool_working_state_changed',
  SESSION_COMPACTED = 'session_compacted',
  /** @deprecated Loop state notifications are superseded by daemon cron events. */
  LOOP_STATE_CHANGED = 'loop_state_changed',
  PERMISSION_RESOLVED = 'permission_resolved',
  SETTINGS_UPDATED = 'settings_updated',
  SESSION_TITLE_UPDATED = 'session_title_updated',
  CHILD_SESSION_AVAILABLE = 'child_session_available',
  MCP_STATUS_CHANGED = 'mcp_status_changed',
  ASSISTANT_TEXT_DELTA = 'assistant_text_delta',
  ASSISTANT_TEXT_COMPLETE = 'assistant_text_complete',
  STRUCTURED_OUTPUT = 'structured_output',
  THINKING_TEXT_DELTA = 'thinking_text_delta',
  THINKING_TEXT_COMPLETE = 'thinking_text_complete',
  SESSION_TOKEN_USAGE_CHANGED = 'session_token_usage_changed',
  AGENT_TURN_COMPLETED = 'agent_turn_completed',
  MISSION_STATE_CHANGED = 'mission_state_changed',
  MISSION_FEATURES_CHANGED = 'mission_features_changed',
  MISSION_PROGRESS_ENTRY = 'mission_progress_entry',
  MISSION_HEARTBEAT = 'mission_heartbeat',
  MISSION_WORKER_STARTED = 'mission_worker_started',
  MISSION_WORKER_COMPLETED = 'mission_worker_completed',
  MCP_AUTH_REQUIRED = 'mcp_auth_required',
  MCP_AUTH_COMPLETED = 'mcp_auth_completed',
  HOOK_EXECUTION_STARTED = 'hook_execution_started',
  HOOK_EXECUTION_COMPLETED = 'hook_execution_completed',
  TOOL_CALL = 'tool_call',
  QUEUED_MESSAGES_DISCARDED = 'queued_messages_discarded',
  /**
   * Internal daemon keep-alive signal emitted while a long-running tool
   * (e.g. Execute) is actively executing but not streaming output. Used by
   * the daemon to refresh session inactivity timeouts. Not forwarded to
   * external clients.
   */
  TOOL_EXECUTION_HEARTBEAT = 'tool_execution_heartbeat',
}

/** Terminal reason reported when an agent turn finishes. */
export enum AgentTurnCompletionReason {
  Completed = 'completed',
  Cancelled = 'cancelled',
  PermissionRejected = 'permission_rejected',
  Error = 'error',
  ProcessExit = 'process_exit',
  SpecHandoff = 'spec_handoff',
}

export enum StructuredOutputErrorCode {
  MissingStructuredOutput = 'missing_structured_output',
  InvalidStructuredOutput = 'invalid_structured_output',
  InvalidSchema = 'invalid_schema',
  SchemaValidationFailed = 'schema_validation_failed',
}

export enum McpAuthOutcome {
  Success = 'success',
  Cancelled = 'cancelled',
  Failed = 'failed',
}

// MCP server connection status
export enum McpServerStatus {
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnected = 'disconnected',
  Failed = 'failed',
  Disabled = 'disabled',
}

// MCP server transport type
export enum McpServerType {
  Stdio = 'stdio',
  Http = 'http',
  Sse = 'sse',
}

// Overall MCP initialization status
export enum McpStatus {
  NotInitialized = 'not-initialized',
  Initializing = 'initializing',
  Ready = 'ready',
  NoServers = 'no-servers',
  Failed = 'failed',
}

// Error types for error notifications
export enum DroolErrorType {
  CONNECTION_ERROR = 'ConnectionError',
  PROTOCOL_ERROR = 'ProtocolError',
  SESSION_ERROR = 'SessionError',
  TIMEOUT_ERROR = 'TimeoutError',
  DROOL_CLIENT_ERROR = 'DroolClientError',
  PROCESS_EXIT_ERROR = 'ProcessExitError',
  ERROR = 'Error',
}

// Drool working state (represents what the agent is currently doing)
export enum DroolWorkingState {
  Idle = 'idle',
  Thinking = 'thinking',
  StreamingAssistantMessage = 'streaming_assistant_message',
  WaitingForToolConfirmation = 'waiting_for_tool_confirmation',
  ExecutingTool = 'executing_tool',
  CompactingConversation = 'compacting_conversation',
}

/** @deprecated Loop scheduling now uses daemon cron records. */
export enum DroolLoopStatus {
  Waiting = 'waiting',
  Running = 'running',
  Due = 'due',
  Stopped = 'stopped',
  Error = 'error',
}

/** @deprecated Loop scheduling now uses daemon cron records. */
export enum DroolLoopStopReason {
  UserStopped = 'user_stopped',
  ManualMessage = 'manual_message',
  Interrupted = 'interrupted',
  SessionClosed = 'session_closed',
  ProcessExited = 'process_exited',
  Error = 'error',
}

export enum ContextStatsAccuracy {
  Exact = 'exact',
  Estimated = 'estimated',
}

export enum ToolExecutionRenderStatus {
  Streaming = 'streaming',
  Pending = 'pending',
  Executing = 'executing',
  Completed = 'completed',
  Error = 'error',
}

// =========================
// Mission decomposition
// =========================

// Session type for mission decomposition (orchestrator manages workers)
export enum DecompSessionType {
  Orchestrator = 'orchestrator',
  Worker = 'worker',
}

/** Mission state enum (used by orchestrator mission runner). */
export enum MissionState {
  /** Mission is in planning before the run has been initialized. */
  Planning = 'planning',
  /** Idle. Waiting for user to send a message. */
  AwaitingInput = 'awaiting_input',
  /** Orchestrator is creating mission artifacts after user accepted proposal. */
  Initializing = 'initializing',
  /** Runner is active, spawning/monitoring workers. User input disabled. */
  Running = 'running',
  /** User paused execution. Resumable. */
  Paused = 'paused',
  /** Worker returned control or failed. Orchestrator acts next. */
  OrchestratorTurn = 'orchestrator_turn',
  /** All features done. Terminal state. */
  Completed = 'completed',
}

/** Feature status enum (mirrors orchestrator feature lifecycle). */
export enum FeatureStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Completed = 'completed',
  Cancelled = 'cancelled',
}

/** Success state for feature completion. */
export enum FeatureSuccessState {
  Success = 'success',
  Partial = 'partial',
  Failure = 'failure',
}

/** Issue severity for discovered issues. */
export enum IssueSeverity {
  Blocking = 'blocking',
  NonBlocking = 'non_blocking',
  Suggestion = 'suggestion',
}

/** Dismissal item type. */
export enum DismissalType {
  DiscoveredIssue = 'discovered_issue',
  CriticalContext = 'critical_context',
  IncompleteWork = 'incomplete_work',
}

/** Progress log entry type. */
export enum ProgressLogEntryType {
  MissionAccepted = 'mission_accepted',
  MissionPaused = 'mission_paused',
  MissionResumed = 'mission_resumed',
  MissionRunStarted = 'mission_run_started',
  WorkerStarted = 'worker_started',
  WorkerSelectedFeature = 'worker_selected_feature',
  WorkerCompleted = 'worker_completed',
  WorkerFailed = 'worker_failed',
  WorkerPaused = 'worker_paused',
  HandoffItemsDismissed = 'handoff_items_dismissed',
  MilestoneValidationTriggered = 'milestone_validation_triggered',
}

/**
 * Discriminator on `WorkerFailedEntry.failureReason` so the MissionRunner can
 * distinguish failure modes that should auto-pause the mission (e.g. an
 * unrecoverable 402) from generic worker exits that should be requeued and
 * retried by the orchestrator.
 */
export enum WorkerFailureReason {
  /**
   * Worker LLM call returned 402 (Payment Required) and the in-process
   * Drool Core fallback path was ineligible (overage preference != droolCore,
   * already on Core, or no swap-eligible slot). The mission must auto-pause.
   */
  UnrecoverableUsage402 = 'unrecoverable_usage_402',
}

/**
 * Discriminator on `MissionPausedEntry.pauseReason`. Default (`undefined`)
 * means a user- or runner-initiated pause; structured values mark
 * automatically-triggered pauses so the UI/orchestrator can react.
 */
export enum MissionPauseReason {
  /** Worker hit an unrecoverable 402 — usage limit reached. */
  UnrecoverableUsage402 = 'unrecoverable_usage_402',
  /**
   * A feature exhausted its worker-attempt budget (kept failing). The mission
   * is paused so the user can review the failure; resuming grants the feature
   * a fresh attempt budget so it can run again (unless it is cancelled).
   */
  FeatureRetryLimitExceeded = 'feature_retry_limit_exceeded',
}

/**
 * Color-key discriminators for the `/context` window usage breakdown. Each key
 * maps to a CSS variable in the rendering surface (CLI chalk colors or web
 * design tokens), so adding a new category requires updating both ends.
 */
export enum ContextCategoryColorKey {
  SystemPrompt = 'systemPrompt',
  SystemTools = 'systemTools',
  McpTools = 'mcpTools',
  UserInfo = 'userInfo',
  AgentsMd = 'agentsMd',
  CustomAgents = 'customAgents',
  Skills = 'skills',
  Messages = 'messages',
}
