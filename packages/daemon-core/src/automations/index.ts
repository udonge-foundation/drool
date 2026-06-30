// Note: For automation discovery primitives (discoverAutomations, loadAutomation, getAutomationsPath),
// import directly from '@industry/drool-core/automations'

// Control-plane actions
export {
  createAutomation,
  getHistory,
  listAutomations,
  pauseAutomation,
  resumeAutomation,
  _resetSkeletonState,
} from './control-plane';
export { getPersistedLocalAutomationHistory } from './local-history';

export type {
  RunAutomationForSchedulerOptions,
  RunAutomationForSchedulerResponse,
} from './types';

// Run state management (recovery)
export { recoverInterruptedRuns } from './run-state';

// Automation persistent state types. Helpers (readAutomationState,
// writeAutomationState, backfillAutomationState) are consumed via
// relative imports inside daemon-core today and will be re-exported here
// once there are cross-package consumers (frontend migration PR).
export type { AutomationState } from './schemas';

// Due-run poller
export { DueRunPoller, isDue } from './poller';

// Sync service
export { AutomationSyncService } from './automation-sync-service';

export type {
  AutomationOutcomeTracking,
  AutomationVisualBaseline,
  SyncResult,
  TrackedSessionInfo,
} from './types';

export type {
  CreateAutomationScaffoldOptions,
  ExecuteFirstHeartbeatOptions,
  ExecuteHeartbeatOptions,
  FirstHeartbeatResult,
  HeartbeatResult,
  InFlightRunState,
  MarkRunCompletedOptions,
  MarkRunStartedOptions,
  PendingRetryInfo,
  PollerCheckResult,
  PollerDispatchResult,
  PollerOptions,
  ProcessRetryRequest,
  ProcessRetryResponse,
  RecordFailedRunRequest,
  RecordFailedRunResponse,
  RecordInterruptedRunRequest,
  RecoveredRunInfo,
  ScheduleValidationResult,
} from './types';
