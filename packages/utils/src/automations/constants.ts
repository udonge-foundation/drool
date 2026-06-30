export const AUTOMATION_RUN_TRIGGER_SOURCES = ['scheduled', 'manual'] as const;

export const AUTOMATION_RUN_FAILURE_REASONS = [
  'workflow_start_failed',
  'workflow_failed',
  'computer_not_found',
  'computer_not_active',
  'computer_missing_external_id',
  'sandbox_resume_failed',
  'session_creation_failed',
  // Local daemon pre-session dispatch failures (no chat session is ever
  // created, so these are invisible to chat-heuristic funnels and must be
  // persisted as run records to stay in the denominator).
  'dispatch_skipped',
  'dispatch_failed',
  'dispatch_exception',
] as const;
