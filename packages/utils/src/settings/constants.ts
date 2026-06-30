/**
 * Centralized registry of all settings resolution event descriptors.
 *
 * Every call to `createResolutionEvent` must reference an ID from this registry.
 * Unit tests verify:
 *   1. Every registry entry's `file` exists on disk.
 *   2. Every registry ID is referenced by at least one call site.
 *   3. Every `createResolutionEvent` call uses a registered ID.
 */

const SETTINGS_RESOLVER_LOC = {
  package: '@industry/runtime',
  file: 'settings/src/SettingsResolver.ts',
} as const;

const DAEMON_SETTINGS_LOC = {
  package: '@industry/daemon-core',
  file: 'utils/settings.ts',
} as const;

const ACTIVE_SESSION_LOC = {
  package: '@industry/frontend',
  file: 'sessions/hooks/useActiveSessionSettings.ts',
} as const;

const SESSION_DEFAULTS_LOC = {
  package: '@industry/frontend',
  file: 'sessions/hooks/useSessionDefaultSettings.ts',
} as const;

export const RESOLUTION_REGISTRY = {
  'hierarchy-skip-no-defaults': {
    ...SETTINGS_RESOLVER_LOC,
    function: 'mergeHierarchyWithChain',
  },
  'hierarchy-set': {
    ...SETTINGS_RESOLVER_LOC,
    function: 'mergeHierarchyWithChain',
  },
  'hierarchy-override-session-defaults': {
    ...SETTINGS_RESOLVER_LOC,
    function: 'mergeHierarchyWithChain',
  },
  'hierarchy-skip-lower-priority': {
    ...SETTINGS_RESOLVER_LOC,
    function: 'mergeHierarchyWithChain',
  },
  'daemon-model-flag-check': {
    ...DAEMON_SETTINGS_LOC,
    function: 'buildModelResolutionEvents',
  },
  'daemon-custom-model-check': {
    ...DAEMON_SETTINGS_LOC,
    function: 'buildModelResolutionEvents',
  },
  'active-session-nav-state': {
    ...ACTIVE_SESSION_LOC,
    function: 'useActiveSessionSettings (init)',
  },
  'active-session-frontend-flags': {
    ...ACTIVE_SESSION_LOC,
    function: 'useActiveSessionSettings (init)',
  },
  'active-session-state': {
    ...ACTIVE_SESSION_LOC,
    function: 'initializeFromSessionManager',
  },
  'new-session-nav-state': {
    ...SESSION_DEFAULTS_LOC,
    function: 'useSessionDefaultSettings (init)',
  },
  'new-session-orchestrator-reasoning': {
    ...SESSION_DEFAULTS_LOC,
    function: 'applyOrchestratorModelOverride',
  },
  'new-session-orchestrator-interaction-mode': {
    package: '@industry/frontend',
    file: 'sessions/hooks/useSessionDefaultSettings.ts',
    function: 'applyOrchestratorModelOverride',
  },
  'new-session-orchestrator-model': {
    ...SESSION_DEFAULTS_LOC,
    function: 'applyOrchestratorModelOverride',
  },
  'new-session-daemon-auto-select': {
    ...SESSION_DEFAULTS_LOC,
    function: 'fetchDefaultSettingsFromDaemon',
  },
  'new-session-daemon-model-fallback': {
    ...SESSION_DEFAULTS_LOC,
    function: 'fetchDefaultSettingsFromDaemon',
  },
  'new-session-daemon-spec-model-fallback': {
    ...SESSION_DEFAULTS_LOC,
    function: 'fetchDefaultSettingsFromDaemon',
  },
  'new-session-remote-org-model-fallback': {
    ...SESSION_DEFAULTS_LOC,
    function: 'applyFeatureFlagModels',
  },
  'new-session-remote-localstorage': {
    ...SESSION_DEFAULTS_LOC,
    function: 'buildRemoteMachineChainEvents',
  },
  'new-session-remote-feature-flags': {
    ...SESSION_DEFAULTS_LOC,
    function: 'applyFeatureFlagModels',
  },
  'new-session-remote-org-model-policy': {
    ...SESSION_DEFAULTS_LOC,
    function: 'applyFeatureFlagModels',
  },
  'new-session-remote-org-defaults': {
    ...SESSION_DEFAULTS_LOC,
    function: 'applyFeatureFlagModels',
  },
  'new-session-remote-auto-select': {
    ...SESSION_DEFAULTS_LOC,
    function: 'applyFeatureFlagModels',
  },
} as const satisfies Record<
  string,
  { package: string; file: string; function: string }
>;

export const SUBAGENT_TIERS = ['light', 'medium', 'heavy'] as const;

const SUBAGENT_MODEL_KEYS = [
  'lightModel',
  'mediumModel',
  'heavyModel',
] as const;

const SUBAGENT_REASONING_KEYS = [
  'lightReasoningEffort',
  'mediumReasoningEffort',
  'heavyReasoningEffort',
] as const;

export const SUBAGENT_SETTING_KEYS = [
  ...SUBAGENT_MODEL_KEYS,
  ...SUBAGENT_REASONING_KEYS,
] as const;

export const MISSION_WORKER_ROLES = ['worker', 'validationWorker'] as const;

export const MISSION_SETTING_KEYS = [
  'workerModel',
  'workerReasoningEffort',
  'validationWorkerModel',
  'validationWorkerReasoningEffort',
  'skipScrutiny',
  'skipUserTesting',
] as const satisfies readonly (
  | `${(typeof MISSION_WORKER_ROLES)[number]}Model`
  | `${(typeof MISSION_WORKER_ROLES)[number]}ReasoningEffort`
  | 'skipScrutiny'
  | 'skipUserTesting'
)[];
