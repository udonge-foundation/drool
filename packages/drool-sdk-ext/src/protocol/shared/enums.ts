/**
 * The interaction mode determines how Drool operates.
 * - Auto: Drool can execute actions based on autonomy level
 * - Spec: Drool is in planning/research mode only (read-only operations)
 * - Mission: Drool orchestrates missions with read-only tools and orchestrator controls
 */
export enum DroolInteractionMode {
  Auto = 'auto',
  Spec = 'spec',
  /** @deprecated Use Mission instead. Kept for protocol compatibility. */
  AGI = 'agi',
  Mission = 'mission',
}

/**
 * Autonomy level determines what actions Drool can perform without user confirmation.
 * - Off: User controls all actions (confirmation required for everything)
 * - Low: Allow file edits and read-only commands
 * - Medium: Allow reversible commands
 * - High: Allow all commands without prompts
 */
export enum AutonomyLevel {
  Off = 'off',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

/**
 * Combined autonomy mode for backward compatibility.
 * This is derived from DroolInteractionMode + AutonomyLevel:
 * - Normal = Auto + Off
 * - Spec = Spec mode (autonomy level ignored)
 * - AutoLow = Auto + Low
 * - AutoMedium = Auto + Medium
 * - AutoHigh = Auto + High
 * @deprecated Use DroolInteractionMode + AutonomyLevel instead
 */
export enum AutonomyMode {
  Normal = 'normal',
  Spec = 'spec',
  AutoLow = 'auto-low',
  AutoMedium = 'auto-medium',
  AutoHigh = 'auto-high',
}

export enum JsonRpcMessageType {
  Request = 'request',
  Response = 'response',
  Notification = 'notification',
}

/**
 * Standard JSON-RPC 2.0 error codes
 * @see https://www.jsonrpc.org/specification#error_object
 */
export enum JsonRpcErrorCode {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  AUTHENTICATION_ERROR = -32001,
  ENTITY_NOT_FOUND = -32004,
  /** Session's CLI process has disconnected or died */
  SESSION_DISCONNECTED = -32005,
  /**
   * The request conflicts with the current server state and was not applied,
   * e.g. a request whose id is already in flight (a duplicate) or a resource
   * that already exists. Analogous to HTTP 409. Prefer this over message
   * sniffing so callers can branch on a structured code; any "already exists /
   * duplicate / concurrent" collision can reuse it.
   */
  CONFLICT = -32006,
}
