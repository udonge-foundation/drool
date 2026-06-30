// Session layer - public API exports
export { DaemonSessionController } from './DaemonSessionController';
export { DroolEvent, ConnectionEvent, ConnectionFailureReason } from './enums';
export {
  ConnectionFailureError,
  SessionNotFoundError,
  WebSocketConnectionError,
} from './errors';
export { DEFAULT_CONNECTION_CONFIG } from './constants';

// State
export { MultiSessionStateManager } from './state/MultiSessionStateManager';
export { SessionStateManager } from './state/SessionStateManager';
export type { HookExecutionData, DisplayMessage } from './types';
export type { QueuedUserMessageState } from './state/types';
export { isHookExecutionData } from './guards';

// Hooks
export { useMissionStoreSnapshot } from './hooks/useMissionStoreSnapshot';

// Utils
export {
  resolveInteractionSettings,
  getDefaultInteractionSettings,
} from './utils/resolveInteractionSettings';

// Types (from types.ts)
export type {
  ConnectionStatus,
  RecoveryInfo,
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
  MissionSnapshotStore,
  MissionStoreInterface,
  UseMissionStoreSnapshotParams,
  ToolProgressNotifier,
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
} from './types';

// Core types (from core/types.ts)
export type {
  MessageRouterEvents,
  PendingRequest,
  DaemonRequest,
  OutgoingMessage,
  RequestManagerEvents,
  PendingOptimisticSubmit,
} from './core/types';

// Handler types (from handlers/types.ts)
export type {
  NotificationDispatcherEvents,
  PendingPermission,
  PermissionRequestHandlerEvents,
  PendingAskUserRequest,
  AskUserRequestHandlerEvents,
  PendingUserAction,
  StoredPermissionAction,
  StoredAskUserAction,
} from './handlers/types';
