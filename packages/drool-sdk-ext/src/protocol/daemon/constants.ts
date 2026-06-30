/**
 * Placeholder identifier for local machine ID
 */
export const LOCAL_MACHINE_ID = 'local' as const;

/**
 * WebSocket server configuration
 */
export const WS_SERVER_CONFIG = {
  DEFAULT_HOST: '127.0.0.1' as const,
  DEFAULT_PROD_PORT: 37643 as const,
  DEFAULT_DEV_PORT: 41723 as const,
};

/**
 * Default WebSocket URL for local daemon connections.
 */
export const DEFAULT_LOCAL_DAEMON_WS_URL = `ws://localhost`;

/**
 * Heartbeat interval for E2B sandbox keep-alive (1 minute).
 * Allows for ~3 retries before 5 minute sandbox timeout.
 */
export const DAEMON_HEARTBEAT_INTERVAL_MS = 60_000;
