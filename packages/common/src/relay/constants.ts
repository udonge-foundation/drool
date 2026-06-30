/**
 * Header authenticating relay ↔ backend internal metadata.
 * Compared constant-time against `INDUSTRY_RELAY_INTERNAL_SECRET`.
 */
export const RELAY_INTERNAL_AUTH_HEADER = 'x-relay-internal-auth';

/** Header carrying the ALB-observed WebSocket peer IP on relay → backend calls. */
export const RELAY_FORWARDED_CLIENT_IP_HEADER = 'x-relay-forwarded-client-ip';

/**
 * Max gap between inbound frames from the daemon before the relay
 * stops forwarding to it. Enforced by the relay itself.
 */
export const COMPUTER_STALE_MS = 5_000;

/**
 * Backend-side "skip resume" gate. Deliberately tighter than
 * {@link COMPUTER_STALE_MS} so we resume ~2s before the relay would
 * refuse to forward, avoiding a TOCTOU race where the daemon dies
 * between the status check and the client's WS upgrade. The buffer is
 * larger than warm-resume p99 (~2.3s in production), so even if we
 * "wastefully" resume a borderline-fresh daemon, the client's connect
 * window still covers it.
 */
export const COMPUTER_FRESH_MS = 3_000;

/** Subprotocol prefix for relay<->daemon version negotiation (`industry-relay.N`). */
export const RELAY_SUBPROTOCOL_PREFIX = 'industry-relay';

/** Current subprotocol version. Increment for each new capability. */
export const RELAY_PROTOCOL_VERSION = 1;

/**
 * Subprotocol version at which the relay begins initiating ping/pong
 * (relay->daemon). Daemons at this version or above receive
 * `relay.ping` from the relay and must reply `relay.pong`; older
 * daemons stay on the passive {@link COMPUTER_STALE_MS} path.
 */
export const RELAY_PROTOCOL_VERSION_INITIATE_PING = 1;

/**
 * Ping interval shared by both liveness directions: relay->daemon
 * (ComputerLivenessMonitor) and daemon->relay (RelayConnection).
 * Keeping a single source of truth keeps the two symmetrical.
 * Overridable via env on the relay side.
 */
export const DEFAULT_PING_INTERVAL_MS = 1_000;

/** Max pong age before closing (~2 missed pings). Shared by both directions. Overridable via env on the relay side. */
export const DEFAULT_PING_TIMEOUT_MS = 2_000;

/**
 * Send-buffer ceiling (bytes). Socket closed after {@link RELAY_BUFFER_STALL_TICKS}
 * consecutive ticks above this. Version-agnostic (inspects relay's own buffer).
 * Overridable via env.
 */
export const RELAY_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Consecutive stalls above {@link RELAY_MAX_BUFFERED_BYTES} before close. Overridable via env. */
export const RELAY_BUFFER_STALL_TICKS = 3;
