import { MachineType } from '@industry/common/daemon';

import type { WebSocketConnectionConfig } from './types';

export const IPC_DAEMON_URL = 'ipc://daemon' as const;

/**
 * Default config for the initial WebSocket connect() call.
 * These control retries when the first connection attempt fails.
 *
 * Note: The frontend (DaemonSessionController) disables these retries
 * (maxConnectRetries: 0) and instead uses its own higher-level reconnection
 * strategy (reconnectInitialDelayMs, reconnectMaxDelayMs, etc.) to handle
 * dropped connections. The backend uses these defaults directly since it
 * creates short-lived clients without a reconnection layer.
 */
export const DEFAULT_WEBSOCKET_CONFIG: WebSocketConnectionConfig = {
  maxConnectRetries: 5,
  initialRetryDelayMs: 500,
  maxRetryDelayMs: 5000,
  connectionTimeoutMs: 5000,
};

/**
 * Per-machine-type WebSocket config overrides.
 * Merged on top of DEFAULT_WEBSOCKET_CONFIG.
 */
export const MACHINE_TYPE_WEBSOCKET_OVERRIDES: Record<
  MachineType,
  Partial<WebSocketConnectionConfig>
> = {
  [MachineType.Local]: {},
  [MachineType.Ephemeral]: {},
  [MachineType.Computer]: {
    connectionTimeoutMs: 45_000,
    maxConnectRetries: 10,
    initialRetryDelayMs: 2_000,
    maxRetryDelayMs: 10_000,
  },
};

/**
 * Retry budget for managed Drool Computer connect+authenticate when the
 * sandbox is being woken from hibernation. Sized so that the relay has
 * time to observe the daemon re-registering after E2B resumes the
 * paused sandbox: roughly 60s at the fixed 2s poll interval. The
 * default budget (~22s) is too tight for cold resumes, which is why
 * a freshly-resumed managed computer can surface as
 * `RelayConnectionError(ComputerOffline)` even though the sandbox is
 * coming back online.
 */
export const MANAGED_COMPUTER_MAX_RETRIES = 30;

/**
 * Retry budget for Slack auto-run flows.
 *
 * Slack auto-run creates a fresh E2B sandbox per session. From sandbox
 * creation to daemon readiness we've observed gaps of up to ~2 minutes in
 * production (E2B cold start + CLI bootstrap + daemon.start()), so the
 * `MANAGED_COMPUTER_MAX_RETRIES` budget (~60s) is not enough — callers get
 * `Auto-run failed: Could not connect to session daemon.` even though the
 * sandbox is still coming up.
 *
 * 90 retries * 2s poll interval ≈ 180s (3 min) connect+auth budget,
 * giving plenty of headroom for the observed startup latency plus jitter
 * while still bounding failure surfacing for Slack users.
 */
export const SLACK_DELEGATION_MAX_RETRIES = 90;
