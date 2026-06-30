/** Trigger type for an automation */
export enum AutomationTriggerType {
  Schedule = 'schedule',
  CI = 'ci',
  Slack = 'slack',
}

/** Status of an automation */
export enum AutomationStatus {
  Active = 'active',
  Paused = 'paused',
  Degraded = 'degraded',
}

/** Setup status for CI automations that require a merged workflow file */
export enum CISetupStatus {
  /** PR has been created but not yet merged */
  PendingSetup = 'pending_setup',
  /** Workflow file exists on default branch and is active */
  Active = 'active',
  /** Workflow file was removed from the repo */
  Inactive = 'inactive',
  /** A PR to remove the workflow has been opened */
  PendingRemoval = 'pending_removal',
}

/** Status of a single automation run (used by daemon-core local run tracking) */
export enum AutomationRunStatus {
  InProgress = 'in_progress',
  Success = 'success',
  Failure = 'failure',
  Cancelled = 'cancelled',
}

export enum SlackAutomationSessionPrivacy {
  Private = 'private',
  Team = 'team',
}

/** Stable identifier for each known structured CI workflow mode. */
export enum CIWorkflowModeId {
  CodeReview = 'code-review',
  Wiki = 'wiki',
  Qa = 'qa',
  SecurityAudit = 'security-audit',
}

/** GitHub plan tiers we surface on CI owner / org payloads. */
export enum CIRepositoryOwnerPlan {
  Free = 'free',
  Team = 'team',
  Business = 'business',
  BusinessPlus = 'business_plus',
  Enterprise = 'enterprise',
  Unknown = 'unknown',
}
