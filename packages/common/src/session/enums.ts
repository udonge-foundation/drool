export enum DroolStatus {
  InProgress = 'inProgress',
  Complete = 'complete',
}
export enum SessionStatus {
  Online = 'online',
  Offline = 'offline',
}

export enum SessionPrivacyLevel {
  Private = 'private',
  Organization = 'organization',
}
/**
 * Enum representing the possible execution states of a Drool
 */
export enum DroolExecutionStatus {
  Idle = 'idle',
  Pending = 'pending',
  Running = 'running',
}

export enum DroolType {
  CODE = 'code-drool',
  KNOWLEDGE = 'knowledge-drool',
  RELIABILITY = 'reliability-drool',
  PRODUCT = 'product-drool',
  TUTORIAL = 'tutorial-drool',
  AGENT_READINESS = 'agent-readiness-drool',
}

/**
 * @deprecated Use MachineType instead. This also should no longer be used as a session-level
 *             source of truth, as the connection is relative to the client using the session.
 */
export enum MachineConnectionType {
  Workspace = 'workspace',
  TUI = 'tui',
  Computer = 'computer',
  /**
   * @deprecated Legacy local-machine connection (the old Industry Bridge app),
   * removed in #8986. Retained only so persisted sessions that still carry this
   * value stay strongly typed; it maps to `MachineType.Local`. Never set on new
   * sessions.
   */
  Bridge = 'bridge',
  /**
   * @deprecated Legacy remote workspace connection, removed in #9525. Retained
   * only so persisted sessions that still carry this value stay strongly typed;
   * it maps to `MachineType.Ephemeral`. Never set on new sessions.
   */
  WorkspaceLegacy = 'workspace-legacy',
}

export enum WorkspaceConnectionStatus {
  Connected = 'Connected',
  Connecting = 'Connecting',
  Disconnected = 'Disconnected',
}

export enum BacklinkSource {
  LinearIssueAttachment = 'Linear - Issue Attachment',
  JiraRemoteIssueLink = 'Jira - Remote Issue Link',
  ReviewDrool = 'Review Drool',
  SlackThread = 'Slack Thread',
}

export enum DelegationSource {
  SlackThreadDelegation = 'Slack Thread Delegation',
  LinearAgentDelegation = 'Linear Agent Delegation',
}

export enum DelegationStatus {
  // Durable cross-invocation marker that a delegated run has entered its
  // working phase. Used by external surfaces (e.g. Slack) to avoid re-posting
  // the preamble narration on every message when in-process state is lost
  // between serverless invocations.
  Working = 'working',
  Stopped = 'stopped',
}

export enum ReadinessSessionType {
  Evaluation = 'evaluation',
  Remediation = 'remediation',
}

export enum SessionCreatedLocation {
  LandingPageNewSession = 'Landing Page - New Session',
  LandingPageNewSessionFromRepo = 'Landing Page - New Session from Repo',
  LandingPageIssue = 'Landing Page - Issue',
  SidePanel = 'Side Panel',
  GeneratedFromWorkflowShortcut = 'Workflow - Landing Page Shortcut',
  GeneratedFromWorkflowPage = 'Workflow - Workflow Page',
  GeneratedFromThreadPage = 'Thread - Thread Page',
  LinearIssueAttachment = BacklinkSource.LinearIssueAttachment,
  JiraRemoteIssueLink = BacklinkSource.JiraRemoteIssueLink,
  ReviewDrool = BacklinkSource.ReviewDrool,
  CopySession = 'copy_session',
  SlackThread = BacklinkSource.SlackThread,
  SlackThreadDelegation = DelegationSource.SlackThreadDelegation,
  LinearAgentDelegation = DelegationSource.LinearAgentDelegation,
  AgentReadinessDelegation = 'Agent Readiness - Delegation',
  ReadinessRemediationDelegation = 'Readiness Remediation - Delegation',
  WikiDelegation = 'Wiki - Delegation',
  ComputerSetup = 'Computer Setup',
  Unknown = 'Unknown',
}
