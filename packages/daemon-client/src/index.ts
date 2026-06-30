export { DaemonClient } from './DaemonClient';
export { connectAndAuthenticate, connectWithRetry } from './connectWithRetry';
export { TunnelConnection } from './TunnelConnection';
export type { TunnelConnectionOptions } from './types';
export {
  ClientDestroyedError,
  ComputeLimitExceededError,
  ConnectionClosedError,
  InProcessDaemonMethodNotFoundError,
  JsonRpcRequestError,
  RelayConnectionError,
  WebSocketConnectionError,
} from './errors';
export type {
  DaemonClientConfig,
  IDaemonClient,
  PendingRequest,
  WebSocketConnectionConfig,
} from './types';
export {
  IPC_DAEMON_URL,
  MACHINE_TYPE_WEBSOCKET_OVERRIDES,
  MANAGED_COMPUTER_MAX_RETRIES,
  SLACK_DELEGATION_MAX_RETRIES,
} from './constants';
export { createWebSocketDaemonClient } from './createWebSocketDaemonClient';
export { DaemonAuthenticationMode } from './enums';

// Re-export session layer without importing the React hook barrel into server bundles.
export { DaemonSessionController } from './session/DaemonSessionController';
export { ConnectionFailureReason, DroolEvent } from './session/enums';
export { MultiMissionStateManager } from './session/state/MultiMissionStateManager';
export { MultiSessionStateManager } from './session/state/MultiSessionStateManager';
export {
  QueuedUserMessageDisplayGroup,
  QueuedUserMessageKind,
} from './session/state/enums';
export {
  getQueuedUserMessageDisplayGroup,
  getQueuedUserMessageReviewPriority,
  isDaemonQueuedMessageKind,
  isReviewableQueuedMessageKind,
} from './session/state/queuedUserMessageHelpers';

export type {
  IndustryDaemonConfig,
  IndustryDroolEvents,
  Session,
  SessionManagerConfig,
  QueuedRequest,
  MachineInfo,
  MachineConnectionConfig,
  SessionInitializedOutcome,
  TerminalSerializedState,
  TerminalMetadata,
  IToolProgressStore,
  MissionStoreInterface,
  ToolProgressNotifier,
  MissionSnapshotStore,
  UseMissionStoreSnapshotParams,
  InitializeSessionRequestParams,
  LoadSessionRequestParams,
  AddUserMessageRequestParams,
  InterruptSessionRequestParams,
  InitializeResult,
  LoadResult,
  AddMessageResult,
  InterruptResult,
  WebSocketConnectionEvents,
  WebSocketConnectionEvents as SessionWebSocketConnectionEvents,
} from './session/types';

export type {
  MessageRouterEvents,
  PendingRequest as SessionPendingRequest,
  DaemonRequest,
  OutgoingMessage,
  RequestManagerEvents,
} from './session/core/types';

export type { QueuedUserMessageState } from './session/state/types';

export type {
  NotificationDispatcherEvents,
  PendingPermission,
  PermissionRequestHandlerEvents,
  PendingAskUserRequest,
  AskUserRequestHandlerEvents,
  PendingUserAction,
  StoredPermissionAction,
  StoredAskUserAction,
} from './session/handlers/types';

export type {
  DaemonClientTransport,
  DaemonClientTransportEvents,
  DaemonIpcMessageChannel,
  InProcessDaemonClientTransportOptions,
  InProcessMessageHandler,
  WebSocketDaemonTransportConfig,
} from './transports';
export {
  InProcessDaemonClientTransport,
  IpcDaemonClientTransport,
} from './transports';
