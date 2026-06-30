export { DroolClient } from './client';
export { ProcessTransport } from './process-transport';
export { DroolProcessManager } from './DroolProcessManager';
export { DroolProcessMode } from './enums';
export type { DroolProcessConfig, ManagedProcess } from './types';
export {
  ConnectionError,
  InvalidSessionCwdError,
  ProcessExitError,
  SessionNotFoundError,
  TimeoutError,
} from './errors';
export { DroolClientEvent } from './enums';

// Re-export protocol types from the SDK extension package.
export type {
  AddUserMessageParams,
  AddUserMessageRequest,
  AddUserMessageResponse,
  ResolveQueuedUserMessageParams,
  ResolveQueuedUserMessageRequest,
  ResolveQueuedUserMessageResponse,
  ClientRequest,
  CreateMessageNotification,
  DroolClientOptions,
  DroolClientTransport,
  HttpMCPServer,
  ImageContent,
  InitializeSessionParams,
  InitializeSessionRequest,
  InitializeSessionResponse,
  InterruptSessionParams,
  InterruptSessionRequest,
  InterruptSessionResponse,
  LoadSessionParams,
  LoadSessionRequest,
  LoadSessionResponse,
  MCPServer,
  ProcessTransportOptions,
  RequestPermissionEvent,
  RequestPermissionResponse,
  SessionNotificationEvent,
  SessionNotificationParams,
  SessionResult,
  SseMCPServer,
  StdioMCPServer,
  ToolResultNotification,
  UpdateSessionSettingsParams,
  UpdateSessionSettingsRequest,
  UpdateSessionSettingsResponse,
} from '@industry/drool-sdk-ext/protocol/drool';
