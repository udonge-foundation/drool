// Constants
export {
  ROOT_MESSAGE_ID,
  SESSION_PLACEHOLDER_TITLE,
  GENERATING_TITLE_PLACEHOLDER,
  READINESS_REMEDIATION_PLATFORM,
  REQUEST_INTERRUPTED_BY_USER_RESULT_TEXT,
  TOOL_EXECUTION_CANCELLED_BY_USER_RESULT_TEXT,
  TOOL_RESULT_PENDING_MARKER,
} from './constants';

// Main enums
export {
  SessionPrivacyLevel,
  DroolExecutionStatus,
  DroolType,
  MachineConnectionType,
  BacklinkSource,
  DelegationStatus,
  SessionCreatedLocation,
} from './enums';

// Main schema exports
export {
  type LocalProcess,
  type FirestoreLocalProcess,
  type FirestoreLocalProcessWithId,
  type IndustryLocalProcess,
} from './schema';

// Main types
export {
  type SessionVersion,
  type IndustryMissionArtifactMetadata,
  type FirestoreSession,
  type FirestoreSessionWithId,
  type FirestoreMissionArtifactMetadata,
  type SlackAskUserDelegationState,
} from './types';

// Context enums
export { ContextType, ContextSource } from './context/enums';

// Context types
export {
  type ContextDeletionErrorResult,
  type ContextCreationErrorResult,
  type FirestoreSearchedFile,
  type SearchedFile,
  type SearchedFileWithContextId,
  type FileWithContent,
  type FirestoreSemanticSummary,
  type SemanticSummary,
  type SemanticSummaryWithMetadata,
  type ContextMetadata,
  type TodoItem,
  type FirestoreContext,
  type IndustryContext,
  type IntegrationContextInfo,
  type CreateContextPayload,
  type DerivedContextOptions,
  type RepoInContext,
} from './context/types';

// Fragment enums
export { AssemblyFragmentType } from './fragement/enums';

// Fragment schema
export {
  codeFragmentSchemaWithSlug,
  documentFragmentSchemaWithSlug,
  htmlFragmentSchemaWithSlug,
  svgFragmentSchemaWithSlug,
  mermaidFragmentSchemaWithSlug,
  type CodeFragment,
  type DocumentFragment,
  type HTMLFragment,
  type SVGFragment,
  type MermaidFragment,
  type FragmentWithSlug,
  type CreateFragmentPayload,
  type UpdateFragmentPayload,
  type FirestoreFragment,
  type FirestoreFragmentWithId,
  type StreamedFragment,
  type IndustryFragmentContent,
  type IndustryFragment,
} from './fragement/schema';

// Messages enums
export { AssemblyMessageRole, MessageContentType } from './messages/enums';

// Tags
export {
  SESSION_TAG_MISSION_ORCHESTRATOR,
  SESSION_TAG_MISSION_WORKER,
  MISSION_SESSION_TAG,
  SESSION_TAG_SUBAGENT,
  SESSION_TAG_BTW_FORK,
  SESSION_TAG_AUTOMATION,
} from './tags/constants';

// Messages types
export {
  type MessageImage,
  type MessageImageWithRawData,
  type MissingContent,
  type PersistedConversationSummary,
  type TextContent,
  type FragmentContent,
  type ThinkingContent,
  type UserMessageContent,
  type AssistantMessageContent,
  type LLMCompatibleAssistantMessageContent,
  type ToolMessageContent,
  type MessageContent,
  type UIMessageContent,
  type BaseMessage,
  type UserMessage,
  type DraftUserMessageWithoutImages,
  type CancelableMessage,
  type AssistantMessage,
  type LLMCompatibleAssistantMessage,
  type ToolMessage,
  type FirestoreUserMessage,
  type FirestoreAssistantMessage,
  type FirestoreToolMessage,
  type DraftClientSentMessage,
  type FirestoreMessage,
  type IndustryAssistantMessage,
  type IndustryLLMCompatibleAssistantMessage,
  type IndustryUserMessage,
  type IndustryToolMessage,
  type IndustryMessage,
  type IndustryLLMCompatibleMessage,
  type FragmentProperties,
  type ParsedContent,
  type MessageParsedContent,
  type IndustryParsedUserMessage,
  type IndustryParsedAssistantMessage,
  type IndustryParsedMessage,
  type UIAssistantMessageContent,
  type IndustryUIAssistantMessage,
  type IndustryUIMessage,
  type CompactionVariant,
} from './messages/types';

// Process schema
export { type LocalProcess as ProcessLocalProcess } from './process/schema';

// Process types
export {
  type FirestoreLocalProcess as ProcessFirestoreLocalProcess,
  type FirestoreLocalProcessWithId as ProcessFirestoreLocalProcessWithId,
  type IndustryLocalProcess as ProcessIndustryLocalProcess,
} from './process/types';

// Tools enums
export {
  ToolExecutionErrorType,
  ToolCallConfirmationStatus,
} from './tools/enums';

// Tools schema
export {
  GenericToolExecutionOutputSchema,
  type GenericToolExecutionOutput,
} from './tools/schema';

// Tools types
export {
  type ToolCall,
  type ToolUpdateData,
  type ToolUpdate,
  type ToolResultErrorType,
  type ToolResultSuccess,
  type ToolResultData,
  type ToolResultStaticFields,
  type AllOrNothing,
  type ToolResult,
  type ToolExecutionContent,
} from './tools/types';

// JSONL session file types (used by CLI, daemon, and services)
export type {
  CacheControlEphemeral,
  BaseContentBlock,
  LocallyPersistedTextBlock,
  LocallyPersistedImageBlock,
  LocallyPersistedThinkingBlock,
  LocallyPersistedRedactedThinkingBlock,
  LocallyPersistedToolUseBlock,
  LocallyPersistedToolResultBlock,
  LocallyPersistedDocumentBlock,
  LocallyPersistedContentBlock,
  LocallyPersistedDroolMessage,
  SessionSummaryEvent,
  DroolMessageEvent,
  CompactionStateEvent,
  TodoStateEvent,
  DroolSessionEvent,
} from './jsonl';

// JSONL converters (shared between CLI, desktop, and services)
export {
  convertLocallyPersistedMessageContentToDroolMessageContent,
  convertMessageEventToIndustryDroolMessage,
} from './jsonl';
