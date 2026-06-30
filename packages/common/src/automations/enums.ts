/** Named schedule cadences */
export enum AutomationScheduleCadence {
  Daily = 'daily',
  Weekly = 'weekly',
  Monthly = 'monthly',
}

/** Types of validation issues */
export enum AutomationValidationIssueType {
  MissingFile = 'missing_file',
  InvalidFrontmatter = 'invalid_frontmatter',
  InvalidSchedule = 'invalid_schedule',
  ParseError = 'parse_error',
}

// =============================================================================
// Control-plane enums
// =============================================================================

/**
 * Control-plane error codes.
 *
 * These codes enable deterministic error handling across CLI/desktop surfaces.
 */
export enum AutomationErrorCode {
  /** Automation with the given ID was not found */
  NotFound = 'AUTOMATION_NOT_FOUND',
  /** Automation already exists with the given ID */
  AlreadyExists = 'AUTOMATION_ALREADY_EXISTS',
  /** Invalid automation ID format */
  InvalidId = 'INVALID_AUTOMATION_ID',
  /** Invalid configuration (e.g., invalid schedule) */
  InvalidConfig = 'INVALID_AUTOMATION_CONFIG',
  /** Automation is already in the requested state */
  AlreadyInState = 'ALREADY_IN_STATE',
  /** A run is already in progress for this automation */
  RunInProgress = 'RUN_IN_PROGRESS',
  /** Heartbeat execution failed */
  ExecutionFailed = 'EXECUTION_FAILED',
  /** General internal error */
  InternalError = 'INTERNAL_ERROR',
}

/**
 * First-class, trigger-agnostic identifier for the template an automation was
 * created from. Maps 1:1 to a Software Industry SDLC stage. `undefined` denotes
 * a custom (non-templated) automation. Values intentionally match
 * `CIWorkflowModeId` so CI automations can be categorized from their mode.
 */
export enum AutomationTemplateId {
  CodeReview = 'code-review',
  Qa = 'qa',
  Wiki = 'wiki',
  SecurityAudit = 'security-audit',
  Triage = 'triage',
  IncidentResponse = 'incident-response',
}

/** Privacy level for an automation */
export enum AutomationPrivacyLevel {
  /** Only visible to the creator */
  Private = 'private',
  /** Visible to all members of the organization */
  Organization = 'organization',
}

/**
 * Discriminates the setup/creation session from real scheduled runs in the run
 * history. Mirrors the automation session tag's `metadata.type`. The creation
 * session is the first thing that ever happens for an automation and is
 * surfaced as the earliest entry, labeled "create".
 */
export enum AutomationRunType {
  /** The initial setup/creation session for the automation */
  Create = 'create',
  /** A real scheduled or manual run */
  Run = 'run',
}
