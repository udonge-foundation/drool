/**
 * Mission Decomposition Types
 *
 * A mission is a user-interactive orchestrator session that plans work,
 * plus multiple non-interactive worker sessions that execute features sequentially.
 */

import { MissionErrorType } from '@/services/mission/enums';

import type { StartMissionRunResult } from '@industry/drool-core/tools/definitions';
import type {
  MissionState,
  DiscoveredIssue,
  DismissalRecord,
  Handoff,
  HandoffItemsDismissedEntry,
  InteractiveCheck,
  ProgressLogEntry,
  MissionAcceptedEntry,
  MissionFeature,
  MissionFeaturesChangedNotification,
  MissionHeartbeatNotification,
  MissionProgressEntryNotification,
  MissionStateChangedNotification,
  MissionWorkerCompletedNotification,
  MissionWorkerStartedNotification,
  SessionTokenUsageChangedNotification,
  TestCase,
  TestFile,
  Tests,
  Verification,
  VerificationCommand,
  WorkerCompletedEntry,
  WorkerFailedEntry,
  WorkerPausedEntry,
  WorkerStartedEntry,
} from '@industry/drool-sdk-ext/protocol/drool';
import type { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import type { SessionTag } from '@industry/drool-sdk-ext/protocol/session';

// Re-export MissionErrorType for convenience
// eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
export { MissionErrorType };

// Re-export types from the SDK protocol for convenience
// eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
export type { MissionSessionTagMetadata } from '@industry/drool-sdk-ext/protocol/session';

export type {
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  DiscoveredIssue,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  DismissalRecord,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  Handoff,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  HandoffItemsDismissedEntry,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  InteractiveCheck,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  ProgressLogEntry,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  MissionAcceptedEntry,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  MissionFeature,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  TestCase,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  TestFile,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  Tests,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  Verification,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  VerificationCommand,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  WorkerCompletedEntry,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  WorkerFailedEntry,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  WorkerPausedEntry,
  // eslint-disable-next-line no-barrel-files/no-barrel-files -- PLT-76: migrated from file-level disable
  WorkerStartedEntry,
};

/** Alias for MissionFeature used by the mission services layer. */
export type Feature = MissionFeature;

/**
 * Features file structure (.industry/missions/{baseSessionId}/features.json)
 */
export interface FeaturesFile {
  features: Feature[];
}

/**
 * Mission state file (.industry/missions/{baseSessionId}/state.json)
 * System-managed - LLM must never write to this directly.
 *
 * This file stores only mission-level state. All feature/worker tracking
 * lives in features.json. The progress log is a pure audit trail.
 */
export interface MissionStateFile {
  /** Unique mission identifier (used for telemetry) */
  missionId: string;
  /** Current mission state */
  state: MissionState;
  /** Working directory where workers should spawn */
  workingDirectory: string;
  /** Mission creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
  /** Cursor: count of handoffs orchestrator has already reviewed */
  lastReviewedHandoffCount?: number;
  /**
   * Per-feature additional worker-attempt budget granted on top of the
   * default cap. Incremented when the user resumes a mission that was paused
   * because a feature exhausted its retry budget, so the feature is allowed to
   * run again instead of being permanently blocked. Keyed by feature id.
   */
  featureRetryBudgetBonus?: Record<string, number>;
  /** Canonical mission artifact layout version, if migrated */
  artifactLayoutVersion?: number;
  /** When legacy repo-root mission artifacts were copied into missionDir */
  legacyArtifactsHydratedAt?: string;
}

export type StartMissionRunProgressDetails = NonNullable<
  StartMissionRunResult['progressSnapshot']
>;

export type StartMissionRunFeaturePreview = NonNullable<
  StartMissionRunProgressDetails['featureWindow']['focus']
>;

export interface ArtifactLayoutMarker {
  version?: number;
  hydratedAt: string;
  importedPaths: string[];
  ambiguousSkillNames: string[];
  canonicalNoticeShownAt?: string;
}

/**
 * Mission notification payloads
 */
export type MissionNotification =
  | MissionStateChangedNotification
  | MissionFeaturesChangedNotification
  | MissionProgressEntryNotification
  | MissionHeartbeatNotification
  | MissionWorkerStartedNotification
  | MissionWorkerCompletedNotification
  | SessionTokenUsageChangedNotification;

/**
 * Notification emitter function type
 */
export type MissionNotificationEmitter = (
  notification: MissionNotification
) => void;

/**
 * Worker session result parsed from end_feature_run output
 */
export interface WorkerResult {
  success: boolean;
  returnToOrchestrator: boolean;
  featureId?: string;
  message?: string;
  /**
   * Set when the runner has already transitioned the mission to `Paused`
   * (e.g. unrecoverable usage 402). Callers must NOT auto-spawn another
   * worker on this result and should surface the pause to the user.
   */
  missionPaused?: boolean;
}

/**
 * Handoff entry stored in handoffs.jsonl
 */
export interface HandoffEntry {
  timestamp: string;
  workerSessionId: string;
  featureId: string;
  milestone?: string;
  commitId?: string;
  repoPath?: string;
  handoff: Handoff;
}

/**
 * Mission metadata for listing missions in the /missions picker
 */
export interface MissionMetadata {
  /** Base session ID (also the mission directory name) */
  baseSessionId: string;
  /** Mission state (Running, Paused, Completed, etc.) */
  state: MissionState | null;
  /** Mission title (from mission.md if available) */
  title: string | null;
  /** Working directory (repo root) */
  workingDirectory: string | null;
  /** Creation timestamp */
  createdAt: Date | null;
  /** Last update timestamp */
  updatedAt: Date | null;
  /** Number of completed features */
  completedFeatures: number | null;
  /** Total number of features */
  totalFeatures: number | null;
  /** Whether there was an error reading this mission */
  hasError: boolean;
  /** Specific error type for better UI/UX */
  errorType?: MissionErrorType;
  /** Error message if hasError is true */
  errorMessage?: string;
  /** Path to the file that caused the error */
  errorPath?: string;
}

export interface EnterMissionResult {
  wasNew: boolean;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  tags: SessionTag[] | undefined;
}

// ============ Mission artifact integrity (issue #974) types ============

/**
 * Common structured fields attached to mission-artifact errors. Plain strings
 * (not wrapped in `cause`) so that logger metadata redaction surfaces them.
 *
 * We intentionally split "what on-disk artifact was this" (`missionArtifactFileKind`,
 * e.g. `features` / `state`) from "why did it fail" (`missionArtifactFailureKind`,
 * e.g. `parse` / `schema` / `io`). A single overloaded `missionArtifactKind`
 * key was ambiguous in log queries — callers would not know whether a given
 * value described the file or the failure class.
 */
export interface MissionArtifactErrorFields {
  filePath: string;
  errnoCode?: string;
  errnoSyscall?: string;
  /** The on-disk artifact this error applies to. */
  missionArtifactFileKind?: string;
  /** Why the artifact was rejected — parse/schema/io. */
  missionArtifactFailureKind?: 'parse' | 'schema' | 'io';
  /** Serialized Zod issues; kept short to stay within log-metadata size limits. */
  issuesJson?: string;
}
