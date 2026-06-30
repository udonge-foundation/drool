import { MachineConnectionConfig } from './types';

/**
 * Default connection configuration used as base for all machine types.
 */
export const DEFAULT_CONNECTION_CONFIG: MachineConnectionConfig = {
  connectionTimeoutMs: 5000,
  requestTimeoutMs: 30000,
  maxQueueSize: 100,
  maxReconnectAttempts: 3,
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 10000,
  reconnectBackoffFactor: 1.5,
};

/**
 * Bounded retry/backoff for triggerSelfResume() loadSession attempts.
 * Used to recover transient failures (network blip, daemon respawn) without
 * silently stranding the user when their buffered answer cannot be flushed.
 */
export const SELF_RESUME_MAX_ATTEMPTS = 3;
export const SELF_RESUME_INITIAL_DELAY_MS = 500;
export const SELF_RESUME_MAX_DELAY_MS = 4000;
export const SELF_RESUME_BACKOFF_FACTOR = 2;

/**
 * Retry budget for initializeSession against a connected daemon.
 *
 * The daemon may take >30s to spawn the underlying drool exec child on a
 * cold start (Windows AV scanning the binary, slow disk, daemon-side retry
 * after a stuck child). Surfacing the renderer's request timeout as a
 * terminal error in that window confused users — the daemon would often
 * still succeed shortly after. We instead retry transparently and only
 * raise a single, terminal error after the budget is exhausted.
 */
export const INITIALIZE_SESSION_MAX_ATTEMPTS = 2;
export const INITIALIZE_SESSION_PER_ATTEMPT_TIMEOUT_MS = 60_000;
